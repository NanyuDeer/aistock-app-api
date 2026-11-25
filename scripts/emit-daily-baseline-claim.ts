/**
 * S5：把当日状态与一条基线结论写进账本（state → evidence → claim）
 *
 * 设计：docs/superpowers/specs/2026-11-25-baseline-claim-wiring-design.md
 * 前置：035（claim_ledger.horizon）+ state_daily / state_rarity_daily / forward_return_dist
 *
 * 【为什么只接一条】
 *   第一条 claim 的价值是验证链路能不能跑通，不是堆数量。选
 *   `breadth 低档 × 20 日 × ew_all`：CI 不含 0（+0.45%~+2.39%）、
 *   三段 n_eff 15/14/13 都过门槛、语义最直白。
 *
 * 【三条硬约束】
 *   1. **evidence 每天都写，claim 有条件才写。**
 *      状态是事实，结论是推断。混在一起出问题时无法判断是状态算错还是推断错。
 *   2. **source 固定 `internal_state`。**
 *      状态与行情快照是同一批日线的两种投影，不是独立来源（设计文档 §14.4）。
 *      拿它去凑"高置信需 2 个独立来源"是自欺。
 *   3. **confidence 必须落在 prob_up 的 bootstrap CI 内**（§14.1）。
 *      超出就 clamp 并告警 —— 不允许"看起来很可信"就抬上去。
 *
 * 用法：
 *   node --import tsx scripts/emit-daily-baseline-claim.ts
 *   node --import tsx scripts/emit-daily-baseline-claim.ts --date 2026-11-20
 *   node --import tsx scripts/emit-daily-baseline-claim.ts --dry
 */

import pool from '../src/core/db';

// ---------------------------------------------------------------------------
// 配置：这一版只接一个格子
// ---------------------------------------------------------------------------

const PRODUCER = 's3_baseline@v1';
const TARGET = {
    dim: 'breadth',
    bucket: 0,          // 广度低档（上涨占比 < 35%）
    horizon: 20,
    segment: 'ALL',
    caliber: 'ew_all',
} as const;
/** 20 个交易日 → PredictionHorizonType 的 mid（035 的白名单只认 short/mid/long） */
const HORIZON_KEY = 'mid';
const MIN_RARITY_WINDOW = 250;

function arg(n: string): string | null {
    const i = process.argv.indexOf(`--${n}`);
    if (i < 0) return null;
    const v = process.argv[i + 1];
    return v && !v.startsWith('--') ? v : null;
}

const hasFlag = (n: string): boolean => process.argv.includes(`--${n}`);

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** 小数 → 百分数文本，带符号：0.0134 → '+1.34%' */
function pct(v: number | null, digits = 2): string {
    if (v === null) return '—';
    const x = v * 100;
    return `${x >= 0 ? '+' : ''}${x.toFixed(digits)}%`;
}

/** 比率 → 百分数文本，不带符号：0.0562 → '5.62%' */
function ratio(v: number | null, digits = 2): string {
    if (v === null) return '—';
    return `${(v * 100).toFixed(digits)}%`;
}

/** 绝对值 → 百分数文本，不带符号：-0.0257 → '2.57%' */
function pctAbs(v: number | null, digits = 2): string {
    if (v === null) return '—';
    return `${(Math.abs(v) * 100).toFixed(digits)}%`;
}

function dec(v: number | null, digits = 3): string {
    if (v === null) return '—';
    return v.toFixed(digits);
}

function clamp(x: number, lo: number | null, hi: number | null): { v: number; clamped: boolean } {
    let v = x;
    let clamped = false;
    if (lo !== null && v < lo) { v = lo; clamped = true; }
    if (hi !== null && v > hi) { v = hi; clamped = true; }
    return { v, clamped };
}

const ymd = (d: string): string => d.replace(/-/g, '');

// ---------------------------------------------------------------------------
// 数据
// ---------------------------------------------------------------------------

interface StateRow {
    d: string;
    traded: number;
    upRatio: number;
    medianPct: number;
    lu: number;
    ld: number;
    ewRet: number;
    bucket: number | null;
    specVersion: string;
    limitApprox: boolean;
}

async function loadState(date: string): Promise<StateRow | null> {
    const r = await pool.query(
        `SELECT trade_date::text AS d, traded_count, breadth_up_ratio, breadth_median_pct,
                limit_up_count, limit_down_count, ew_ret, bucket_breadth,
                spec_version, limit_approx
           FROM state_daily WHERE trade_date = $1::date`,
        [date],
    );
    if (r.rowCount === 0) return null;
    const x = r.rows[0];
    return {
        d: x.d,
        traded: Number(x.traded_count),
        upRatio: Number(x.breadth_up_ratio),
        medianPct: Number(x.breadth_median_pct),
        lu: Number(x.limit_up_count),
        ld: Number(x.limit_down_count),
        ewRet: Number(x.ew_ret),
        bucket: x.bucket_breadth === null ? null : Number(x.bucket_breadth),
        specVersion: String(x.spec_version),
        limitApprox: Boolean(x.limit_approx),
    };
}

interface RarityRow {
    breadthRank: number; limitRank: number; windowDays: number;
}

async function loadRarity(date: string): Promise<RarityRow | null> {
    const r = await pool.query(
        `SELECT breadth_rank, limit_rank, window_days
           FROM state_rarity_daily WHERE trade_date = $1::date`,
        [date],
    );
    if (r.rowCount === 0) return null;
    const x = r.rows[0];
    return {
        breadthRank: Number(x.breadth_rank),
        limitRank: Number(x.limit_rank),
        windowDays: Number(x.window_days),
    };
}

interface FrdRow {
    status: string;
    nEff: number;
    nObs: number;
    p25: number | null; p50: number | null; p75: number | null;
    probUp: number | null; probUpLow: number | null; probUpHigh: number | null;
    dateMin: string; dateMax: string;
}

async function loadTargetCell(specVersion: string): Promise<FrdRow | null> {
    const r = await pool.query(
        `SELECT status, n_eff, n_obs, p25, p50, p75, prob_up,
                prob_up_low, prob_up_high, date_min::text AS date_min, date_max::text AS date_max
           FROM forward_return_dist
          WHERE dim = $1 AND bucket = $2 AND horizon = $3
            AND segment = $4 AND caliber = $5 AND spec_version = $6`,
        [TARGET.dim, TARGET.bucket, TARGET.horizon, TARGET.segment, TARGET.caliber, specVersion],
    );
    if (r.rowCount === 0) return null;
    const x = r.rows[0];
    return {
        status: String(x.status),
        nEff: Number(x.n_eff),
        nObs: Number(x.n_obs),
        p25: num(x.p25), p50: num(x.p50), p75: num(x.p75),
        probUp: num(x.prob_up), probUpLow: num(x.prob_up_low), probUpHigh: num(x.prob_up_high),
        dateMin: x.date_min, dateMax: x.date_max,
    };
}

// ---------------------------------------------------------------------------
// 写账本
// ---------------------------------------------------------------------------

interface EvidenceDraft {
    id: string;
    statement: string;
    quality: 'ok' | 'partial';
    payload: Record<string, unknown>;
}

/** 纯函数：dry 与真实写入共用，避免两处文案各写一遍后漂移 */
function buildEvidence(state: StateRow, rarity: RarityRow | null): EvidenceDraft {
    const id = `ev_${ymd(state.d)}_state`;
    // rarity 缺失时 statement 里会出现 "—"（分位拿不到），那是降级，必须标 partial。
    // 不能因为"主数字都在"就写 ok —— 读的人会以为分位也算过了。
    const rarityUsable = rarity !== null && rarity.windowDays >= MIN_RARITY_WINDOW;
    const quality: 'ok' | 'partial' = state.limitApprox || !rarityUsable ? 'partial' : 'ok';

    const statement = [
        `全市场 ${state.traded.toLocaleString('en-US')} 只有成交`,
        `上涨占比 ${ratio(state.upRatio, 2)}（近 3 年分位 ${dec(rarity?.breadthRank ?? null)}）`,
        `中位数 ${state.medianPct >= 0 ? '+' : ''}${state.medianPct.toFixed(2)}%`,
        `跌停 ${state.ld} 家（分位 ${dec(rarity?.limitRank ?? null)}）`,
        `涨停 ${state.lu} 家`,
        `等权 ${pct(state.ewRet, 2)}`,
    ].join('，');

    const payload = {
        state_date: state.d,
        spec_version: state.specVersion,
        bucket_breadth: state.bucket,
        values: {
            traded_count: state.traded,
            breadth_up_ratio: state.upRatio,
            breadth_median_pct: state.medianPct,
            limit_up_count: state.lu,
            limit_down_count: state.ld,
            ew_ret: state.ewRet,
        },
        rarity: rarity === null ? null : {
            breadth_rank: rarity.breadthRank,
            limit_rank: rarity.limitRank,
            window_days: rarity.windowDays,
        },
    };

    return { id, statement, quality, payload };
}

async function writeEvidence(draft: EvidenceDraft, date: string): Promise<void> {
    await pool.query(
        `INSERT INTO evidence_ledger
            (evidence_id, kind, subject_type, subject_code, statement, source, source_type,
             published_at, fetched_at, quality, weight, payload)
         VALUES ($1, 'market', 'market', 'ALL', $2, 'internal_state', 'data',
                 $3::timestamptz, now(), $4, NULL, $5::jsonb)
         ON CONFLICT (evidence_id) DO NOTHING`,
        [draft.id, draft.statement, `${date}T15:00:00+08:00`, draft.quality, JSON.stringify(draft.payload)],
    );
}

async function writeClaim(state: StateRow, frd: FrdRow, evidenceId: string): Promise<{ id: string; statement: string; confidence: number } | null> {
    const id = `cl_${ymd(state.d)}_ALL_trend_s3`;

    // confidence：先取 prob_up 点估计，再钳到 bootstrap CI 内
    const raw = frd.probUp ?? 0;
    const { v: clampedValue, clamped } = clamp(raw, frd.probUpLow, frd.probUpHigh);
    // claim_ledger.confidence 是 NUMERIC(4,3)：显式取 3 位，
    // 否则日志打 0.5963、库里存 0.596，日后对不上账
    const confidence = Math.round(clampedValue * 1000) / 1000;
    if (clamped) {
        console.warn(
            `[S5] prob_up=${raw} 落在自身 CI [${frd.probUpLow}, ${frd.probUpHigh}] 之外，已钳制。` +
            ' 这通常说明 bootstrap 出了问题，应检查而不是静默接受。',
        );
    }

    // 三段措辞：只有 status='ok' 才算"未发现反向证据"
    const segmentText = frd.status === 'ok'
        ? '三段均未发现反向证据'
        : frd.status === 'segment_limited'
            ? '仅部分时段有效'
            : '样本不足';

    const statement = [
        `广度低档下，未来 ${TARGET.horizon} 日全市场等权收益中位数为正`,
        `历史中位数 ${pct(frd.p50)}，P25 ${pct(frd.p25)}，P75 ${pct(frd.p75)}`,
        `P(涨) ${ratio(frd.probUp, 1)}`,
        `有效样本 n_eff=${frd.nEff}（${frd.dateMin.slice(0, 7)} ~ ${frd.dateMax.slice(0, 7)}，${segmentText}）`,
        `左尾较厚：约四分之一的情形亏损超过 ${pctAbs(frd.p25, 2)}`,
    ].join('；') + '。';

    const res = await pool.query(
        `INSERT INTO claim_ledger
            (claim_id, subject_type, subject_code, kind, capability, statement,
             evidence_ids, confidence, invalidated_by, produced_by, as_of,
             horizon, horizon_days)
         VALUES ($1, 'market', 'ALL', 'trend', 'trend', $2, ARRAY[$3]::text[], $4, '{}', $5,
                 $6::timestamptz, $7, $8)
         ON CONFLICT (claim_id) DO NOTHING`,
        [id, statement, evidenceId, confidence, PRODUCER, `${state.d}T15:00:00+08:00`, HORIZON_KEY, TARGET.horizon],
    );
    if (res.rowCount === 0) {
        console.log(`[S5] ${id} 已存在，跳过（append-only，要改结论请换序号）`);
        return null;
    }
    return { id, statement, confidence };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const dry = hasFlag('dry');
    let date = arg('date');

    if (!date) {
        const r = await pool.query('SELECT max(trade_date)::text AS d FROM state_daily');
        date = r.rows[0]?.d;
        if (!date) throw new Error('state_daily 为空，先跑 build-state-daily.ts');
    }

    const state = await loadState(date as string);
    if (!state) throw new Error(`${date} 的 state_daily 不存在，先跑状态构建`);

    const rarity = await loadRarity(date as string);
    const frd = await loadTargetCell(state.specVersion);

    console.log(`[S5] ${state.d}  breadth_bucket=${state.bucket ?? 'NULL'}  spec=${state.specVersion}`);
    console.log(`[S5] 目标格 ${TARGET.dim}/${TARGET.bucket}/h${TARGET.horizon}/${TARGET.segment}/${TARGET.caliber} → ${frd?.status ?? '缺失'}`);

    if (dry) {
        const ev = buildEvidence(state, rarity);
        console.log('\n--dry 不写库\n');
        console.log('evidence:', ev.id);
        console.log('  ', ev.statement);
        console.log('   quality =', ev.quality);
        if (state.bucket === TARGET.bucket && frd?.status === 'ok') {
            console.log('\nclaim: 将产出（status=ok 且当日为低档）');
            console.log('   confidence 锚 =', frd.probUp, 'CI =', [frd.probUpLow, frd.probUpHigh]);
        } else {
            console.log('\nclaim: 不产出（当日档位=' + (state.bucket ?? 'NULL') + '，目标 status=' + (frd?.status ?? '无') + '）');
        }
        await pool.end();
        return;
    }

    const ev = buildEvidence(state, rarity);
    await writeEvidence(ev, state.d);
    console.log(`[S5] evidence ${ev.id}（quality=${ev.quality}）`);
    console.log('     ', ev.statement);

    if (state.bucket !== TARGET.bucket) {
        console.log(`[S5] 当日不在低档（bucket=${state.bucket}），不产出 claim`);
        await pool.end();
        return;
    }
    if (!frd) {
        console.log('[S5] 目标格缺失，不产出 claim');
        await pool.end();
        return;
    }
    if (frd.status !== 'ok') {
        // segment_limited / insufficient / void 一律不产 claim（spec §5）
        console.log(`[S5] 目标格 status=${frd.status}，不产出 claim（只留 evidence）`);
        await pool.end();
        return;
    }

    const claim = await writeClaim(state, frd, ev.id);
    if (claim) {
        console.log(`[S5] claim ${claim.id}  confidence=${claim.confidence}`);
        console.log('     ', claim.statement);
    }
    await pool.end();
}

main().catch(async (e) => {
    console.error('[S5] 失败：', e instanceof Error ? e.message : e);
    await pool.end().catch(() => undefined);
    process.exit(1);
});
