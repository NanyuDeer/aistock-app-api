/**
 * S2 状态向量的两个参考数据集回填
 *
 * 为什么需要这两张表（设计文档 2026-11-25 §1.6）：
 *   1. `stock_name_hist`（Tushare namechange）
 *      涨跌停判定依赖"当时是不是 ST"。ST 是 ±5%，非 ST 是 10/20/30%。
 *      没有历史名称，ST 股的涨停会被当成"没涨停"，导致涨停家数**系统性下偏**。
 *      这个偏差是单向的，事后无法用统计手段纠正 —— 只能靠这张表。
 *
 *   2. `stock_industry_hist`（Tushare index_member，31 个申万一级 × is_new=Y/N）
 *      板块分化度需要"当时这只股票属于哪个行业"。
 *      用今天的行业快照去算 2016 年，等于让活到今天的公司代表当年所有公司
 *      （分类层的生存偏差），且退市股会整体落在分组之外。
 *      实测该接口含退市股：300104.SZ（乐视网）传媒 2014-02-21 ~ 2019-05-10。
 *
 * 幂等：全部 ON CONFLICT DO UPDATE，重跑即刷新，不会产生重复行。
 *
 * 用法：
 *   node --import tsx scripts/backfill-state-refs.ts          # 全量回填 + 自检
 *   node --import tsx scripts/backfill-state-refs.ts --check   # 只自检，不写库
 *   node --import tsx scripts/backfill-state-refs.ts --only name
 *   node --import tsx scripts/backfill-state-refs.ts --only industry
 *
 * 前置：032_state_forward_dist.sql 已执行。
 */

import pool from '../src/core/db';
import { tushareRequest } from '../src/modules/quote/TushareService';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** namechange 单页行数。实测 5,000 一页稳定，两页拉完（总量 1 万~2 万）。 */
const NAME_PAGE = 5000;
/** 单次 INSERT 的行数，7 列 × 500 = 3500 参数，远低于 65535 上限。 */
const INSERT_CHUNK = 500;
/** 自检取样的日期：分段起点 + 最新 */
const PROBE_DATES = ['2016-01-04', '2018-01-02', '2020-01-02', '2024-01-02', 'latest'];

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function hasFlag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

function arg(name: string): string | null {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx < 0) return null;
    const value = process.argv[idx + 1];
    return value && !value.startsWith('--') ? value : null;
}

/** '20261126' → '2026-11-26'；空串/null → null */
function toDate(v: unknown): string | null {
    const s = String(v ?? '').trim();
    if (s.length !== 8) return null;
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function str(v: unknown): string {
    return String(v ?? '').trim();
}

/**
 * ST 判定：名称含 'ST'。
 * 覆盖 'ST' / '*ST' / 'SST' / 'S*ST' 全部四种前缀。
 * 不含退市整理期（名称以"退"结尾）—— 那批样本极少且规则不同，不单独建模。
 */
function isSt(name: string): boolean {
    return name.includes('ST');
}

// ---------------------------------------------------------------------------
// namechange → stock_name_hist
// ---------------------------------------------------------------------------

interface NameRow {
    ts_code: string;
    name: string;
    start_date: string;
    end_date: string | null;
    ann_date: string | null;
    change_reason: string;
    is_st: boolean;
}

async function fetchNameChanges(): Promise<NameRow[]> {
    const out: NameRow[] = [];
    let offset = 0;
    for (;;) {
        const rows = await tushareRequest('namechange', { limit: NAME_PAGE, offset });
        if (rows.length === 0) break;
        for (const r of rows) {
            const tsCode = str(r.ts_code);
            const start = toDate(r.start_date);
            if (!tsCode || !start) continue; // 起点缺失无法定位区间，跳过
            out.push({
                ts_code: tsCode,
                name: str(r.name),
                start_date: start,
                end_date: toDate(r.end_date),
                ann_date: toDate(r.ann_date),
                change_reason: str(r.change_reason),
                is_st: isSt(str(r.name)),
            });
        }
        process.stdout.write(`\r  namechange 已拉取 ${out.length} 行 (offset=${offset})   `);
        if (rows.length < NAME_PAGE) break;
        offset += NAME_PAGE;
    }
    process.stdout.write('\n');
    return out;
}

async function writeNameChanges(rows: NameRow[]): Promise<number> {
    let written = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        const chunk = rows.slice(i, i + INSERT_CHUNK);
        const values: unknown[] = [];
        const tuples = chunk.map((r, j) => {
            const b = j * 7;
            values.push(r.ts_code, r.name, r.start_date, r.end_date, r.ann_date, r.change_reason, r.is_st);
            return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
        });
        const res = await pool.query(
            `INSERT INTO stock_name_hist
                (ts_code, name, start_date, end_date, ann_date, change_reason, is_st)
             VALUES ${tuples.join(',')}
             ON CONFLICT (ts_code, start_date) DO UPDATE SET
                name = EXCLUDED.name,
                end_date = EXCLUDED.end_date,
                ann_date = EXCLUDED.ann_date,
                change_reason = EXCLUDED.change_reason,
                is_st = EXCLUDED.is_st,
                backfilled_at = now()`,
            values,
        );
        written += res.rowCount ?? 0;
        if (i % (INSERT_CHUNK * 10) === 0) {
            process.stdout.write(`\r  写入 stock_name_hist ${written}/${rows.length}   `);
        }
    }
    process.stdout.write('\n');
    return written;
}

// ---------------------------------------------------------------------------
// index_member → stock_industry_hist
// ---------------------------------------------------------------------------

interface IndustryRow {
    ts_code: string;
    l1_code: string;
    l1_name: string;
    in_date: string;
    out_date: string | null;
    is_current: boolean;
}

async function fetchIndustries(): Promise<IndustryRow[]> {
    const classify = await tushareRequest('index_classify', { level: 'L1', src: 'SW2021' });
    if (classify.length === 0) throw new Error('index_classify 返回空，行业映射无法建立');

    const out: IndustryRow[] = [];
    let done = 0;
    for (const c of classify) {
        const code = str(c.index_code);
        const name = str(c.industry_name);
        // is_new=Y 当前成分 / N 已调出。两者合起来才是完整区间历史。
        for (const isNew of ['Y', 'N'] as const) {
            const rows = await tushareRequest('index_member', { index_code: code, is_new: isNew });
            for (const r of rows) {
                const tsCode = str(r.con_code);
                const inDate = toDate(r.in_date);
                if (!tsCode || !inDate) continue;
                out.push({
                    ts_code: tsCode,
                    l1_code: code,
                    l1_name: name,
                    in_date: inDate,
                    out_date: toDate(r.out_date),
                    is_current: isNew === 'Y',
                });
            }
        }
        done += 1;
        process.stdout.write(`\r  行业 ${done}/${classify.length}（${name}），累计 ${out.length} 行   `);
    }
    process.stdout.write('\n');
    return out;
}

async function writeIndustries(rows: IndustryRow[]): Promise<number> {
    let written = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        const chunk = rows.slice(i, i + INSERT_CHUNK);
        const values: unknown[] = [];
        const tuples = chunk.map((r, j) => {
            const b = j * 7;
            values.push(r.ts_code, r.l1_code, r.l1_name, r.in_date, r.out_date, r.is_current, 'SW2021');
            return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
        });
        const res = await pool.query(
            `INSERT INTO stock_industry_hist
                (ts_code, l1_code, l1_name, in_date, out_date, is_current, src)
             VALUES ${tuples.join(',')}
             ON CONFLICT (ts_code, l1_code, in_date) DO UPDATE SET
                l1_name = EXCLUDED.l1_name,
                out_date = EXCLUDED.out_date,
                is_current = EXCLUDED.is_current,
                backfilled_at = now()`,
            values,
        );
        written += res.rowCount ?? 0;
    }
    return written;
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

async function verify(): Promise<void> {
    console.log('\n=== 自检 ===');

    const base = await pool.query(
        `SELECT (SELECT count(*) FROM stock_name_hist)          AS name_rows,
                (SELECT count(DISTINCT ts_code) FROM stock_name_hist) AS name_codes,
                (SELECT count(*) FROM stock_industry_hist)      AS ind_rows,
                (SELECT count(DISTINCT ts_code) FROM stock_industry_hist) AS ind_codes,
                -- 必须 ::text：pg 会把 DATE 解析成本地零点的 Date，
                -- 再经 toISOString() 落到 UTC 会**倒退一天**（东八区典型陷阱）
                (SELECT max(trade_date)::text FROM stock_daily) AS last_day`,
    );
    console.table(base.rows[0]);

    const lastDay: string | null = base.rows[0].last_day || null;

    // 1) ST 覆盖：各时点 ST 家数 + 有多少股票能查到名称
    console.log('\n[1] 名称/ST 覆盖（stock_daily 当日有成交的股票中，能查到名称的比例）');
    const stRows: Record<string, unknown>[] = [];
    for (const d of PROBE_DATES) {
        const day = d === 'latest' ? lastDay : d;
        if (!day) continue;
        const r = await pool.query(
            `WITH s AS (SELECT DISTINCT ts_code FROM stock_daily WHERE trade_date = $1::date)
             SELECT $1::text AS trade_date,
                    count(*)                                        AS traded,
                    count(n.is_st)                                  AS named,
                    count(*) FILTER (WHERE n.is_st)                 AS st,
                    round(100.0 * count(n.is_st) / NULLIF(count(*),0), 2) AS named_pct
             FROM s LEFT JOIN LATERAL (
                SELECT is_st FROM stock_name_hist h
                 WHERE h.ts_code = s.ts_code
                   AND h.start_date <= $1::date
                   AND (h.end_date IS NULL OR h.end_date >= $1::date)
                 ORDER BY h.start_date DESC LIMIT 1
             ) n ON true`,
            [day],
        );
        stRows.push(r.rows[0]);
    }
    console.table(stRows);

    // 2) 行业覆盖
    console.log('\n[2] 行业覆盖（有成交股票中，能定位到当时申万一级行业的比例）');
    const indRows: Record<string, unknown>[] = [];
    for (const d of PROBE_DATES) {
        const day = d === 'latest' ? lastDay : d;
        if (!day) continue;
        const r = await pool.query(
            `WITH s AS (SELECT DISTINCT ts_code FROM stock_daily WHERE trade_date = $1::date)
             SELECT $1::text AS trade_date,
                    count(*)                                        AS traded,
                    count(i.ts_code)                                AS covered,
                    round(100.0 * count(i.ts_code) / NULLIF(count(*),0), 2) AS covered_pct,
                    count(*) FILTER (WHERE s.ts_code LIKE '%.BJ')   AS bse
             FROM s LEFT JOIN LATERAL (
                SELECT ts_code FROM stock_industry_hist h
                 WHERE h.ts_code = s.ts_code
                   AND h.in_date <= $1::date
                   AND (h.out_date IS NULL OR h.out_date >= $1::date)
                 ORDER BY h.in_date DESC, h.is_current DESC LIMIT 1
             ) i ON true
             GROUP BY 1`,
            [day],
        );
        indRows.push(r.rows[0]);
    }
    console.table(indRows);

    // 3) 完全查不到名称的股票（说明 namechange 漏了这批）
    const missName = await pool.query(
        `SELECT count(DISTINCT ts_code) AS codes FROM stock_daily d
          WHERE NOT EXISTS (SELECT 1 FROM stock_name_hist h WHERE h.ts_code = d.ts_code)`,
    );
    console.log(`\n[3] 完全无名称记录的股票：${missName.rows[0].codes} 只（应为 0 或极少）`);

    // 4) 重叠区间检查（源数据历史修订会留下重叠记录，取数时按 in_date 最新者优先）
    const overlap = await pool.query(
        `SELECT count(*) AS pairs FROM stock_industry_hist a
           JOIN stock_industry_hist b
             ON a.ts_code = b.ts_code AND a.l1_code = b.l1_code AND a.in_date < b.in_date
          WHERE (a.out_date IS NULL OR a.out_date >= b.in_date)`,
    );
    console.log(`[4] 行业内重叠区间对数：${overlap.rows[0].pairs}（正常存在，取数规则已固定为 in_date 最新者优先）`);

    // 5) 样例核对：乐视网应有传媒行业区间，且在 2020-07-20 退市后不再有成交
    const sample = await pool.query(
        `SELECT ts_code, l1_name, in_date, out_date, is_current
           FROM stock_industry_hist WHERE ts_code = '300104.SZ' ORDER BY in_date`,
    );
    console.log('[5] 样例 300104.SZ（乐视网）行业区间：');
    console.table(sample.rows);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const checkOnly = hasFlag('check');
    const only = arg('only'); // 'name' | 'industry' | null

    if (!checkOnly) {
        if (!only || only === 'name') {
            console.log('[1/2] namechange → stock_name_hist');
            const rows = await fetchNameChanges();
            const n = await writeNameChanges(rows);
            console.log(`  完成：拉取 ${rows.length} 行，写入 ${n} 行`);
        }
        if (!only || only === 'industry') {
            console.log('[2/2] index_member → stock_industry_hist');
            const rows = await fetchIndustries();
            const n = await writeIndustries(rows);
            console.log(`  完成：拉取 ${rows.length} 行，写入 ${n} 行`);
        }
    }

    await verify();
    await pool.end();
}

main().catch(async (e) => {
    console.error('\n失败：', e instanceof Error ? e.message : e);
    await pool.end().catch(() => undefined);
    process.exit(1);
});
