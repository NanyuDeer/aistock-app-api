/**
 * S3：给定状态档位 → 未来 N 日收益分布
 *
 * 设计：docs/superpowers/specs/2026-11-25-s2-s3-state-forward-dist-design.md §5 / §9
 * 前置：032（forward_return_dist）+ state_daily + index_daily(000300.SH)
 *
 * 【这个脚本要防的三件事】
 *
 * 1. **不能按天数算样本。** 相邻交易日的 20 日未来收益高度重叠：2,646 个交易日
 *    只有 132 个独立观测。所以门槛卡 `n_eff`（不重叠块命中数），不卡 `n_obs`。
 *
 * 2. **状态是聚集的。** 连续 300 天冰点可能只来自 3 个事件段，`300/20=15` 会高估
 *    独立性。块代表法（块长=h，块内众数定档）天然消除重叠，各档 n_eff 之和
 *    等于总块数，可横向比较。
 *
 * 3. **重叠样本的 CI 会假窄。** iid bootstrap 会把方差低估到不可信，比不给区间更危险。
 *    这里用 moving block bootstrap（块长 = h），在段内交易日上做循环块重抽样。
 *
 * 【确定性】
 *   每个格子用 (dim,bucket,h,segment,caliber) 派生固定种子，**与遍历顺序无关** ——
 *   否则删掉/新增一个格子，后面所有 CI 都会变，"同输入同结论"就破了。
 *
 * 【预注册】
 *   所有预注册组合全量入表，**包括样本不足与作废的**。不按显著性筛选，
 *   否则进表的全是"看起来有效"的档位，后续回测会系统性偏乐观。
 *
 * 用法：
 *   node --import tsx scripts/build-forward-dist.ts
 *   node --import tsx scripts/build-forward-dist.ts --dry
 *   node --import tsx scripts/build-forward-dist.ts --rounds 200   # 快速试算
 */

import pool from '../src/core/db';

// ---------------------------------------------------------------------------
// 参数（变更必须升 SPEC_VERSION）
// ---------------------------------------------------------------------------

const SPEC_VERSION = 'v1';
const HORIZONS = [5, 10, 20] as const;
const BOOTSTRAP_ROUNDS = 1000;
const BOOTSTRAP_SEED = 20261125;
const MIN_N_EFF_POOLED = 30;
const MIN_N_EFF_SEGMENT = 10;
const MIN_OBS_FOR_CI = 20;

const DIMS = ['breadth', 'limit', 'momentum', 'vol', 'margin', 'dispersion'] as const;
type Dim = (typeof DIMS)[number];

const DIM_COLUMN: Record<Dim, string> = {
    breadth: 'bucket_breadth',
    limit: 'bucket_limit',
    momentum: 'bucket_momentum',
    vol: 'bucket_vol',
    margin: 'bucket_margin',
    dispersion: 'bucket_dispersion',
};

const SEGMENTS = [
    { key: 'A_2016_2019', from: '2016-01-01', to: '2019-12-31' },
    { key: 'B_2020_2023', from: '2020-01-01', to: '2023-12-31' },
    { key: 'C_2024_NOW', from: '2024-01-01', to: '9999-12-31' },
] as const;

const CALIBERS = ['ew_all', 'hs300'] as const;
type Caliber = (typeof CALIBERS)[number];

type Status = 'ok' | 'insufficient' | 'segment_limited' | 'void' | 'undecidable';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function hasFlag(n: string): boolean {
    return process.argv.includes(`--${n}`);
}

function arg(n: string): string | null {
    const i = process.argv.indexOf(`--${n}`);
    if (i < 0) return null;
    const v = process.argv[i + 1];
    return v && !v.startsWith('--') ? v : null;
}

/** 固定种子 PRNG。bootstrap 必须可复现，不能用 Math.random。 */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 由格子标识派生种子：改任何一个维度都会得到不同的重抽样序列 */
function seedFor(dim: Dim, bucket: number, h: number, segment: string, caliber: Caliber): number {
    let hsh = BOOTSTRAP_SEED >>> 0;
    const key = `${dim}|${bucket}|${h}|${segment}|${caliber}`;
    for (let i = 0; i < key.length; i += 1) {
        hsh = Math.imul(hsh ^ key.charCodeAt(i), 2246822519) >>> 0;
    }
    return hsh >>> 0;
}

/** 线性插值分位（与 PG 的 percentile_cont 同口径） */
function quantile(sorted: Float64Array | number[], p: number): number {
    const n = sorted.length;
    if (n === 0) return NaN;
    if (n === 1) return sorted[0];
    const pos = (n - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function signOf(x: number): number {
    return x > 0 ? 1 : x < 0 ? -1 : 0;
}

function round(v: number | null, digits = 6): number | null {
    if (v === null || !Number.isFinite(v)) return null;
    const f = 10 ** digits;
    return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// 数据
// ---------------------------------------------------------------------------

interface Series {
    dates: string[];
    ewRet: number[];
    hs300: number[];
    buckets: Record<Dim, Array<number | null>>;
    /** 档位编码：-1 = 无档（预热期），0/1/2 */
    codes: Record<Dim, Int8Array>;
}

async function loadSeries(): Promise<Series> {
    const rows = await pool.query(
        `SELECT trade_date::text AS d, ew_ret, ${DIMS.map((d) => DIM_COLUMN[d]).join(', ')}
           FROM state_daily ORDER BY trade_date`,
    );
    const idxRows = await pool.query(
        `SELECT trade_date::text AS d, pct_chg FROM index_daily
          WHERE ts_code = '000300.SH' ORDER BY trade_date`,
    );
    const idx = new Map<string, number>();
    for (const r of idxRows.rows) idx.set(r.d, Number(r.pct_chg) / 100);

    const n = rows.rows.length;
    const s: Series = {
        dates: [],
        ewRet: [],
        hs300: [],
        buckets: { breadth: [], limit: [], momentum: [], vol: [], margin: [], dispersion: [] },
        codes: {
            breadth: new Int8Array(n), limit: new Int8Array(n), momentum: new Int8Array(n),
            vol: new Int8Array(n), margin: new Int8Array(n), dispersion: new Int8Array(n),
        },
    };
    const missingIdx: string[] = [];
    for (let i = 0; i < n; i += 1) {
        const r = rows.rows[i];
        s.dates.push(r.d);
        s.ewRet.push(Number(r.ew_ret));
        // 指数缺失记 NaN，绝不补 0（补 0 会把分布往中间拉）
        if (idx.has(r.d)) s.hs300.push(idx.get(r.d) as number);
        else { s.hs300.push(NaN); missingIdx.push(r.d); }
        for (const d of DIMS) {
            const v = r[DIM_COLUMN[d]];
            const b = v === null || v === undefined ? null : Number(v);
            s.buckets[d].push(b);
            s.codes[d][i] = b === null ? -1 : b;
        }
    }
    if (missingIdx.length > 0) {
        throw new Error(
            `000300.SH 缺 ${missingIdx.length} 个交易日（${missingIdx.slice(0, 5).join(',')}…）。` +
            'hs300 口径的区间收益必须逐日完整，缺一天就让所有跨该日的窗口失效。先补指数数据。',
        );
    }
    return s;
}

/** 累计净值：P[i] = Π(1+r[0..i-1])，P[0]=1 */
function cumulative(rets: number[]): Float64Array {
    const P = new Float64Array(rets.length + 1);
    P[0] = 1;
    for (let i = 0; i < rets.length; i += 1) P[i + 1] = P[i] * (1 + rets[i]);
    return P;
}

/** 未来 h 日收益：T 收盘 → T+h 收盘。用净值比，避免逐日连乘误差。NaN = 窗口不完整 */
function forwardReturns(P: Float64Array, h: number): Float64Array {
    const days = P.length - 1;
    const out = new Float64Array(days).fill(NaN);
    for (let t = 0; t + h < days; t += 1) {
        const a = P[t + 1];
        const b = P[t + 1 + h];
        if (a !== 0) out[t] = b / a - 1;
    }
    return out;
}

// ---------------------------------------------------------------------------
// 核心统计
// ---------------------------------------------------------------------------

interface Cell {
    dim: Dim; bucket: number; horizon: number; segment: string; caliber: Caliber;
    nObs: number; nEff: number; nEpisode: number;
    p10: number | null; p25: number | null; p50: number | null;
    p75: number | null; p90: number | null;
    mean: number | null; probUp: number | null;
    ciLow: number | null; ciHigh: number | null;
    probUpLow: number | null; probUpHigh: number | null;
    status: Status; dateMin: string; dateMax: string;
    _median: number | null;
}

/**
 * 块代表法：把有效区间切成不重叠块（块长 = h），块内取众数档位。
 * 并列时取**靠近块末日**者（状态是"块末已成立的事实"，且规则固定可复现）。
 */
function blockRepresentatives(codes: Int8Array, lo: number, hi: number, h: number, target: number): number {
    let hit = 0;
    const span = hi - lo + 1;
    const blocks = Math.floor(span / h);
    const cnt = [0, 0, 0, 0]; // index0 不用，1..3 对应档 0..2
    const last = [-1, -1, -1, -1];
    for (let b = 0; b < blocks; b += 1) {
        const start = lo + b * h;
        const end = start + h - 1;
        cnt[1] = 0; cnt[2] = 0; cnt[3] = 0;
        last[1] = -1; last[2] = -1; last[3] = -1;
        for (let t = start; t <= end; t += 1) {
            const c = codes[t];
            if (c < 0) continue;
            cnt[c + 1] += 1;
            last[c + 1] = t;
        }
        let best = -1;
        let bestC = 0;
        let bestLast = -1;
        for (let k = 1; k <= 3; k += 1) {
            if (cnt[k] > bestC || (cnt[k] === bestC && cnt[k] > 0 && last[k] > bestLast)) {
                best = k - 1; bestC = cnt[k]; bestLast = last[k];
            }
        }
        if (best === target) hit += 1;
    }
    return hit;
}

function countEpisodes(codes: Int8Array, lo: number, hi: number, bucket: number): number {
    let episodes = 0;
    let inRun = false;
    for (let t = lo; t <= hi; t += 1) {
        const hit = codes[t] === bucket;
        if (hit && !inRun) episodes += 1;
        inRun = hit;
    }
    return episodes;
}

/**
 * moving block bootstrap：段内交易日做循环块重抽样（块长 = h），
 * 重抽样后取该档的中位数，得到中位数的经验分布。
 *
 * 为什么不 iid：重叠窗口下 iid 低估方差，给出假窄区间 —— 比不给区间更危险。
 */
function bootstrapCIs(
    codes: Int8Array,
    fwd: Float64Array,
    lo: number,
    hi: number,
    bucket: number,
    h: number,
    rounds: number,
    seed: number,
): { median: [number, number]; probUp: [number, number] } | null {
    // 有效日 = 未来收益窗口完整的交易日
    const idx: number[] = [];
    for (let t = lo; t <= hi; t += 1) if (!Number.isNaN(fwd[t])) idx.push(t);
    const L = idx.length;
    if (L < h * 2) return null;

    const rand = mulberry32(seed);
    const blocks = Math.ceil(L / h);
    const buf = new Float64Array(L);
    const medians = new Float64Array(rounds);
    const ups = new Float64Array(rounds);
    let ok = 0;

    for (let r = 0; r < rounds; r += 1) {
        let len = 0;
        for (let b = 0; b < blocks && len < L; b += 1) {
            const start = (rand() * L) | 0;
            for (let k = 0; k < h && len < L; k += 1) {
                const t = idx[(start + k) % L];
                if (codes[t] === bucket) buf[len++] = fwd[t];
            }
        }
        if (len >= 3) {
            const sorted = Float64Array.from(buf.subarray(0, len)).sort();
            medians[ok] = quantile(sorted, 0.5);
            let up = 0;
            for (let k = 0; k < len; k += 1) if (buf[k] > 0) up += 1;
            ups[ok] = up / len;
            ok += 1;
        }
    }
    if (ok < rounds * 0.5) return null;
    const medUsed = Float64Array.from(medians.subarray(0, ok)).sort();
    const upUsed = Float64Array.from(ups.subarray(0, ok)).sort();
    return {
        median: [quantile(medUsed, 0.025), quantile(medUsed, 0.975)],
        probUp: [quantile(upUsed, 0.025), quantile(upUsed, 0.975)],
    };
}

function computeCell(
    s: Series,
    dim: Dim,
    bucket: number,
    h: number,
    caliber: Caliber,
    segKey: string,
    lo: number,
    hi: number,
    fwd: Float64Array,
    rounds: number,
): Cell {
    const codes = s.codes[dim];

    let loValid = -1;
    let hiValid = -1;
    const obsT: number[] = [];
    const obsV: number[] = [];
    for (let t = lo; t <= hi; t += 1) {
        if (Number.isNaN(fwd[t])) continue;
        if (loValid < 0) loValid = t;
        hiValid = t;
        if (codes[t] === bucket) { obsT.push(t); obsV.push(fwd[t]); }
    }
    if (loValid < 0) loValid = lo;
    if (hiValid < 0) hiValid = hi;

    const values = Float64Array.from(obsV).sort();
    const n = values.length;
    const nEff = blockRepresentatives(codes, loValid, hiValid, h, bucket);
    const nEpisode = countEpisodes(codes, loValid, hiValid, bucket);

    let ci: { median: [number, number]; probUp: [number, number] } | null = null;
    if (n >= MIN_OBS_FOR_CI) {
        ci = bootstrapCIs(codes, fwd, loValid, hiValid, bucket, h, rounds, seedFor(dim, bucket, h, segKey, caliber));
    }

    const mean = n > 0 ? obsV.reduce((a, b) => a + b, 0) / n : null;
    const up = n > 0 ? obsT.filter((t) => (fwd[t] as number) > 0).length / n : null;

    return {
        dim, bucket, horizon: h, segment: segKey, caliber,
        nObs: n, nEff, nEpisode,
        p10: n ? round(quantile(values, 0.1)) : null,
        p25: n ? round(quantile(values, 0.25)) : null,
        p50: n ? round(quantile(values, 0.5)) : null,
        p75: n ? round(quantile(values, 0.75)) : null,
        p90: n ? round(quantile(values, 0.9)) : null,
        mean: round(mean),
        probUp: up === null ? null : round(up, 4),
        ciLow: ci ? round(ci.median[0]) : null,
        ciHigh: ci ? round(ci.median[1]) : null,
        probUpLow: ci ? round(ci.probUp[0], 4) : null,
        probUpHigh: ci ? round(ci.probUp[1], 4) : null,
        status: 'ok',
        dateMin: obsT.length ? s.dates[obsT[0]] : s.dates[loValid],
        dateMax: obsT.length ? s.dates[obsT[obsT.length - 1]] : s.dates[hiValid],
        _median: n ? quantile(values, 0.5) : null,
    };
}

/**
 * 三段判决（设计文档 §5.1）。
 *
 * - 段内 n_eff < 10 → undecidable（**不计入"不一致"**：样本少本身不是反证）
 * - 显著反向（符号相反且合并中位数落在段 CI 之外）→ void
 * - 三段都可判定、同向、且无非显著反向 → ok
 * - 其余（有段不可判定，或存在非显著反向）→ segment_limited
 *
 * 第三条是给 A 方案配的刹车：段内 11~15 个观测时符号翻转有一半来自噪声。
 * 判 void 会随机废掉状态，判 ok 会抹掉反向迹象，segment_limited 是唯一诚实的出口。
 */
function judgeStatus(pooled: Cell, segs: Cell[]): Status {
    if (pooled.nEff < MIN_N_EFF_POOLED || pooled._median === null) return 'insufficient';
    const mAll = pooled._median;
    const decidable = segs.filter((c) => c.nEff >= MIN_N_EFF_SEGMENT && c._median !== null);
    let sigReverse = false;
    let weakReverse = false;
    for (const c of decidable) {
        const m = c._median as number;
        if (signOf(m) === signOf(mAll) || signOf(m) === 0) continue;
        const outside = c.ciLow !== null && c.ciHigh !== null ? (mAll < c.ciLow || mAll > c.ciHigh) : false;
        if (outside) sigReverse = true; else weakReverse = true;
    }
    if (sigReverse) return 'void';
    if (decidable.length === 3 && !weakReverse) return 'ok';
    return 'segment_limited';
}

// ---------------------------------------------------------------------------
// 写库
// ---------------------------------------------------------------------------

const COLUMNS = [
    'dim', 'bucket', 'horizon', 'segment', 'caliber',
    'n_obs', 'n_eff', 'n_episode',
    'p10', 'p25', 'p50', 'p75', 'p90', 'mean_ret', 'prob_up',
    'ci_low', 'ci_high', 'prob_up_low', 'prob_up_high',
    'status', 'date_min', 'date_max', 'spec_version',
];

async function writeCells(cells: Cell[]): Promise<number> {
    await pool.query('DELETE FROM forward_return_dist WHERE spec_version = $1', [SPEC_VERSION]);
    const CHUNK = 60;
    let written = 0;
    for (let i = 0; i < cells.length; i += CHUNK) {
        const chunk = cells.slice(i, i + CHUNK);
        const vals: unknown[] = [];
        const tuples = chunk.map((c) => {
            const row: Record<string, unknown> = {
                dim: c.dim, bucket: c.bucket, horizon: c.horizon, segment: c.segment,
                caliber: c.caliber, n_obs: c.nObs, n_eff: c.nEff, n_episode: c.nEpisode,
                p10: c.p10, p25: c.p25, p50: c.p50, p75: c.p75, p90: c.p90,
                mean_ret: c.mean, prob_up: c.probUp,
                ci_low: c.ciLow, ci_high: c.ciHigh,
                prob_up_low: c.probUpLow, prob_up_high: c.probUpHigh,
                status: c.status, date_min: c.dateMin, date_max: c.dateMax,
                spec_version: SPEC_VERSION,
            };
            return '(' + COLUMNS.map((col) => { vals.push(row[col]); return `$${vals.length}`; }).join(',') + ')';
        });
        const res = await pool.query(
            `INSERT INTO forward_return_dist (${COLUMNS.join(',')}) VALUES ${tuples.join(',')}`,
            vals,
        );
        written += res.rowCount ?? 0;
    }
    return written;
}

// ---------------------------------------------------------------------------
// 回读校验
// ---------------------------------------------------------------------------

/**
 * 注意：只有 `segment='ALL'` 的行携带**判决**。
 * 分段行的 status='ok' 仅表示"该段样本够描述"，不代表这个状态被判定为有效 ——
 * 消费方必须按 segment='ALL' 取结论，否则会把三段数据当成三条独立结论。
 */
async function verify(): Promise<void> {
    console.log('\n=== 回读校验 ===');
    const rows = await pool.query(
        `SELECT horizon, status, count(*)::int AS n
           FROM forward_return_dist WHERE spec_version = $1 AND segment = 'ALL'
          GROUP BY 1, 2 ORDER BY 1, 2`,
        [SPEC_VERSION],
    );
    const byH: Record<string, Record<string, number>> = {};
    for (const r of rows.rows) {
        byH[r.horizon] = byH[r.horizon] ?? {};
        byH[r.horizon][r.status] = r.n;
    }
    console.log('ALL 行判决 × 窗口：');
    console.table(byH);

    const ok = await pool.query(
        `SELECT dim, bucket, horizon, caliber, n_eff, n_obs,
                round(p50::numeric, 4) AS p50,
                round(p25::numeric, 4) AS p25,
                round(p75::numeric, 4) AS p75,
                round(prob_up::numeric, 3) AS up,
                round(ci_low::numeric, 4) AS lo, round(ci_high::numeric, 4) AS hi,
                round(prob_up_low::numeric, 3) AS up_lo,
                round(prob_up_high::numeric, 3) AS up_hi
           FROM forward_return_dist
          WHERE spec_version = $1 AND segment = 'ALL' AND status = 'ok'
          ORDER BY horizon, dim, bucket, caliber`,
        [SPEC_VERSION],
    );
    console.log(`\nstatus=ok 的格子（${ok.rowCount} 个，可直接进 claim）：`);
    console.table(ok.rows);

    const t = await pool.query(
        `SELECT count(*)::int AS rows,
                count(*) FILTER (WHERE status = 'ok' AND segment = 'ALL')::int AS ok_all,
                count(*) FILTER (WHERE ci_low IS NULL)::int AS no_ci
           FROM forward_return_dist WHERE spec_version = $1`,
        [SPEC_VERSION],
    );
    console.table(t.rows[0]);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const dry = hasFlag('dry');
    const quiet = hasFlag('quiet');
    const rounds = Number(arg('rounds') ?? BOOTSTRAP_ROUNDS);

    if (hasFlag('verify')) {
        await verify();
        await pool.end();
        return;
    }

    if (!quiet) console.log('读取序列…');
    const s = await loadSeries();
    if (s.dates.length < 100) throw new Error(`序列只有 ${s.dates.length} 天，不足以计算分布`);
    if (!quiet) console.log(`  ${s.dates.length} 个交易日，${s.dates[0]} ~ ${s.dates[s.dates.length - 1]}`);

    const t0 = Date.now();
    const all: Cell[] = [];

    for (const h of HORIZONS) {
        for (const caliber of CALIBERS) {
            const fwd = forwardReturns(cumulative(caliber === 'ew_all' ? s.ewRet : s.hs300), h);

            const segRange = SEGMENTS.map((seg) => {
                let lo = s.dates.findIndex((d) => d >= seg.from);
                if (lo < 0) lo = s.dates.length;
                let hi = s.dates.length - 1;
                while (hi >= 0 && s.dates[hi] > seg.to) hi -= 1;
                return { key: seg.key as string, lo, hi };
            });

            for (const dim of DIMS) {
                for (const bucket of [0, 1, 2]) {
                    const pooled = computeCell(s, dim, bucket, h, caliber, 'ALL', 0, s.dates.length - 1, fwd, rounds);
                    const segCells = segRange.map((r) =>
                        computeCell(s, dim, bucket, h, caliber, r.key, r.lo, r.hi, fwd, rounds),
                    );
                    for (const c of segCells) {
                        c.status = c.nEff < MIN_N_EFF_SEGMENT || c.nObs === 0 ? 'undecidable' : 'ok';
                    }
                    pooled.status = judgeStatus(pooled, segCells);
                    all.push(pooled, ...segCells);
                }
            }
            if (!quiet) console.log(`  h=${h} ${caliber} 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
        }
    }

    if (!quiet) console.log(`共 ${all.length} 个格子，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (dry) {
        const okCells = all.filter((c) => c.status === 'ok' && c.segment === 'ALL');
        console.log(`\nstatus=ok 的合并样本：${okCells.length} 个`);
        console.table(okCells.map((c) => ({
            dim: c.dim, b: c.bucket, h: c.horizon, cal: c.caliber,
            nObs: c.nObs, nEff: c.nEff, ep: c.nEpisode,
            p50: c.p50, p25: c.p25, p75: c.p75, up: c.probUp,
            ci: `${c.ciLow ?? '-'}~${c.ciHigh ?? '-'}`,
        })));
        const summary = new Map<string, number>();
        for (const c of all) summary.set(c.status, (summary.get(c.status) ?? 0) + 1);
        console.log('状态分布：', Object.fromEntries(summary));
        await pool.end();
        return;
    }

    const n = await writeCells(all);
    console.log(`写入 ${n} 行`);
    await verify();
    await pool.end();
}

main().catch(async (e) => {
    console.error('\n失败：', e instanceof Error ? e.message : e);
    await pool.end().catch(() => undefined);
    process.exit(1);
});
