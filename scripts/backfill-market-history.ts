/**
 * 历史行情回填（S1 数据地基）
 *
 * 用途：把 2016 年起的个股日线、指数日线、两融汇总、北向资金落库，
 *       供「给定市场状态 → 未来 N 日收益分布」与归因的 CAR / 截面检验使用。
 *
 * 为什么按「交易日」拉而不是按「股票」拉（重要）：
 *   按 trade_date 调 `daily`，返回的是那天实际有交易的全部标的，
 *   **天然包含后来退市的股票**。按股票循环反而会漏掉退市股，
 *   造成生存偏差（收益分位数系统性偏右，最容易在"冰点抄底"上过于乐观）。
 *
 * 断点续跑：
 *   每次启动先查各表已有哪些交易日，逐表跳过。中断后直接重跑即可，
 *   不要加 --force，除非确实要覆盖。
 *
 * 用法：
 *   # 全量回填（默认 2016-01-01 至今，四张表）
 *   node --import tsx scripts/backfill-market-history.ts
 *
 *   # 只看进度，不写库
 *   node --import tsx scripts/backfill-market-history.ts --check
 *
 *   # 只回填指定表
 *   node --import tsx scripts/backfill-market-history.ts --tables stock_daily,margin_daily
 *
 *   # 指定区间
 *   node --import tsx scripts/backfill-market-history.ts --start 20200101 --end 20201231
 *
 * 前置：030_market_history.sql 已执行（四张表存在）。
 */

import pool from '../src/core/db';
import { tushareRequest } from '../src/modules/quote/TushareService';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DEFAULT_START = '20160101';

/** 回填的指数。够用即可，后续要加直接往这里加。 */
const INDEX_CODES = [
    '000001.SH', // 上证指数
    '000300.SH', // 沪深300
    '000905.SH', // 中证500
    '000852.SH', // 中证1000
    '399001.SZ', // 深证成指
    '399006.SZ', // 创业板指
    '000688.SH', // 科创50
];

/** 单次多值 INSERT 的行数。5500 行/天 ÷ 800 ≈ 7 批/天，兼顾速度与参数上限。 */
const INSERT_CHUNK = 800;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function arg(name: string): string | null {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx < 0) return null;
    const value = process.argv[idx + 1];
    return value && !value.startsWith('--') ? value : '';
}

function hasFlag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

function ymd(d: Date): string {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function toDate(s: string): string {
    // 20160104 → 2016-01-04
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function num(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Tushare 返回 NaN/空串是常态，统一转 null，避免写入时报类型错。 */
function numOrNull(v: unknown): number | null {
    return num(v);
}

/**
 * 把交易日列表按自然年切段，供支持 start_date/end_date 的接口批量拉。
 *
 * 为什么要切段而不是一次拉全部：Tushare 单次返回有行数上限（约 6000），
 * 而 margin 一天 3 行、十年 7200 行会超限。按年切每段约 750 行，留足余量。
 */
function yearSegments(days: string[]): Array<{ start: string; end: string }> {
    const byYear = new Map<string, string[]>();
    for (const d of days) {
        const y = d.slice(0, 4);
        const list = byYear.get(y);
        if (list) list.push(d);
        else byYear.set(y, [d]);
    }
    return [...byYear.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, list]) => ({ start: list[0], end: list[list.length - 1] }));
}

async function chunkInsert(
    table: string,
    columns: string[],
    rows: unknown[][],
): Promise<number> {
    if (rows.length === 0) return 0;
    let written = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        const slice = rows.slice(i, i + INSERT_CHUNK);
        const values: unknown[] = [];
        const placeholders = slice
            .map((row) => {
                const ph = row.map((cell) => {
                    values.push(cell);
                    return `$${values.length}`;
                });
                return `(${ph.join(',')})`;
            })
            .join(',');
        const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders} ON CONFLICT DO NOTHING`;
        const res = await pool.query(sql, values);
        written += res.rowCount ?? 0;
    }
    return written;
}

/** 取表里已有的交易日，用于断点续跑。 */
async function existingDates(table: string): Promise<Set<string>> {
    const res = await pool.query<{ d: string }>(
        `SELECT DISTINCT to_char(trade_date, 'YYYY-MM-DD') AS d FROM ${table}`,
    );
    return new Set(res.rows.map((r) => r.d));
}

// ---------------------------------------------------------------------------
// 交易日历
// ---------------------------------------------------------------------------

async function loadTradingDays(start: string, end: string): Promise<string[]> {
    const rows = await tushareRequest(
        'trade_cal',
        { exchange: 'SSE', start_date: start, end_date: end, is_open: '1' },
        'cal_date,is_open',
    );
    return rows
        .map((r) => String(r.cal_date))
        .filter((d) => /^\d{8}$/.test(d))
        .sort();
}

// ---------------------------------------------------------------------------
// 各表回填
// ---------------------------------------------------------------------------

type DayResult = { ok: number; skip: number; fail: Array<{ day: string; error: string }> };

async function backfillStockDaily(days: string[], checkOnly: boolean): Promise<DayResult> {
    const existing = checkOnly ? new Set<string>() : await existingDates('stock_daily');
    const result: DayResult = { ok: 0, skip: 0, fail: [] };

    for (const [i, day] of days.entries()) {
        const date = toDate(day);
        if (existing.has(date)) {
            result.skip += 1;
            continue;
        }
        try {
            const [bars, factors] = await Promise.all([
                tushareRequest(
                    'daily',
                    { trade_date: day },
                    'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount',
                ),
                tushareRequest('adj_factor', { trade_date: day }, 'ts_code,trade_date,adj_factor'),
            ]);
            if (bars.length === 0) {
                result.skip += 1;
                continue;
            }
            const factorMap = new Map<string, number | null>();
            for (const f of factors) {
                factorMap.set(String(f.ts_code), numOrNull(f.adj_factor));
            }
            const rows = bars.map((b) => {
                const code = String(b.ts_code);
                return [
                    code,
                    date,
                    numOrNull(b.open),
                    numOrNull(b.high),
                    numOrNull(b.low),
                    numOrNull(b.close),
                    numOrNull(b.pre_close),
                    numOrNull(b.change),
                    numOrNull(b.pct_chg),
                    numOrNull(b.vol),
                    numOrNull(b.amount),
                    factorMap.get(code) ?? null,
                ];
            });
            const written = await chunkInsert(
                'stock_daily',
                [
                    'ts_code', 'trade_date', 'open', 'high', 'low', 'close',
                    'pre_close', 'change', 'pct_chg', 'vol', 'amount', 'adj_factor',
                ],
                rows,
            );
            result.ok += written;
            if ((i + 1) % 100 === 0) {
                console.log(`  [stock_daily] ${i + 1}/${days.length} 天，累计 ${result.ok} 行`);
            }
        } catch (error) {
            result.fail.push({ day: date, error: (error as Error).message });
            console.warn(`  [stock_daily] ${date} 失败: ${(error as Error).message}`);
        }
    }
    return result;
}

/**
 * 指数日线：**按指数拉整个区间**，不是按日。
 *
 * 为什么不能按日拉：按日 × 7 个指数，全量 2400 天要 16800 次调用，
 * 是整条回填链路 90% 的耗时。Tushare `index_daily` 支持 ts_code + 日期区间，
 * 每个指数一次拿完 → 7 次调用结束。
 */
async function backfillIndexDaily(days: string[], checkOnly: boolean): Promise<DayResult> {
    const existing = checkOnly ? new Set<string>() : await existingDates('index_daily');
    const result: DayResult = { ok: 0, skip: 0, fail: [] };
    if (days.length === 0) return result;

    const start = days[0];
    const end = days[days.length - 1];

    for (const code of INDEX_CODES) {
        try {
            const bars = await tushareRequest(
                'index_daily',
                { ts_code: code, start_date: start, end_date: end },
                'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount',
            );
            const rows: unknown[][] = [];
            for (const b of bars) {
                const raw = String(b.trade_date);
                if (!/^\d{8}$/.test(raw)) continue;
                const date = toDate(raw);
                if (existing.has(date)) continue;
                rows.push([
                    String(b.ts_code), date,
                    numOrNull(b.open), numOrNull(b.high), numOrNull(b.low), numOrNull(b.close),
                    numOrNull(b.pre_close), numOrNull(b.change), numOrNull(b.pct_chg),
                    numOrNull(b.vol), numOrNull(b.amount),
                ]);
            }
            if (rows.length === 0) {
                console.log(`  [index_daily] ${code} 无新数据`);
                continue;
            }
            const written = await chunkInsert(
                'index_daily',
                ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'change', 'pct_chg', 'vol', 'amount'],
                rows,
            );
            result.ok += written;
            console.log(`  [index_daily] ${code} 写入 ${written} 行`);
        } catch (error) {
            result.fail.push({ day: code, error: (error as Error).message });
            console.warn(`  [index_daily] ${code} 失败: ${(error as Error).message}`);
        }
    }
    return result;
}

async function backfillMargin(days: string[], checkOnly: boolean): Promise<DayResult> {
    const existing = checkOnly ? new Set<string>() : await existingDates('margin_daily');
    const result: DayResult = { ok: 0, skip: 0, fail: [] };
    if (days.length === 0) return result;

    // margin 支持 start_date/end_date，按年分段拉（每年约 250 天 × 3 交易所 = 750 行，远低于 6000 上限）。
    // 按日拉要 2400 次调用，按年只要 10 次。
    for (const seg of yearSegments(days)) {
        try {
            const rows = await tushareRequest(
                'margin',
                { start_date: seg.start, end_date: seg.end },
                'trade_date,exchange_id,rzye,rzmre,rzche,rqye,rqyl,rqmcl,rqchl,rzrqye',
            );
            const values: unknown[][] = [];
            for (const r of rows) {
                const raw = String(r.trade_date);
                if (!/^\d{8}$/.test(raw)) continue;
                const date = toDate(raw);
                if (existing.has(date)) continue;
                values.push([
                    date, String(r.exchange_id),
                    numOrNull(r.rzye), numOrNull(r.rzmre), numOrNull(r.rzche),
                    numOrNull(r.rqye), numOrNull(r.rqyl), numOrNull(r.rqmcl), numOrNull(r.rqchl),
                    numOrNull(r.rzrqye),
                ]);
            }
            if (values.length === 0) continue;
            const written = await chunkInsert(
                'margin_daily',
                ['trade_date', 'exchange_id', 'rzye', 'rzmre', 'rzche', 'rqye', 'rqyl', 'rqmcl', 'rqchl', 'rzrqye'],
                values,
            );
            result.ok += written;
            console.log(`  [margin_daily] ${seg.start}~${seg.end} 写入 ${written} 行`);
        } catch (error) {
            result.fail.push({ day: `${seg.start}~${seg.end}`, error: (error as Error).message });
            console.warn(`  [margin_daily] ${seg.start}~${seg.end} 失败: ${(error as Error).message}`);
        }
    }
    return result;
}

async function backfillMoneyflow(days: string[], checkOnly: boolean): Promise<DayResult> {
    const existing = checkOnly ? new Set<string>() : await existingDates('moneyflow_daily');
    const result: DayResult = { ok: 0, skip: 0, fail: [] };
    if (days.length === 0) return result;

    // 同上，按年分段。moneyflow_hsgt 支持 start_date/end_date。
    for (const seg of yearSegments(days)) {
        try {
            const rows = await tushareRequest(
                'moneyflow_hsgt',
                { start_date: seg.start, end_date: seg.end },
                'trade_date,ggt_ss,ggt_sz,hgt,sgt,north_money,south_money',
            );
            const values: unknown[][] = [];
            for (const r of rows) {
                const raw = String(r.trade_date);
                if (!/^\d{8}$/.test(raw)) continue;
                const date = toDate(raw);
                if (existing.has(date)) continue;
                values.push([
                    date,
                    numOrNull(r.ggt_ss), numOrNull(r.ggt_sz), numOrNull(r.hgt),
                    numOrNull(r.sgt), numOrNull(r.north_money), numOrNull(r.south_money),
                ]);
            }
            if (values.length === 0) continue;
            const written = await chunkInsert(
                'moneyflow_daily',
                ['trade_date', 'ggt_ss', 'ggt_sz', 'hgt', 'sgt', 'north_money', 'south_money'],
                values,
            );
            result.ok += written;
            console.log(`  [moneyflow_daily] ${seg.start}~${seg.end} 写入 ${written} 行`);
        } catch (error) {
            result.fail.push({ day: `${seg.start}~${seg.end}`, error: (error as Error).message });
            console.warn(`  [moneyflow_daily] ${seg.start}~${seg.end} 失败: ${(error as Error).message}`);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const TABLES: Record<string, (days: string[], checkOnly: boolean) => Promise<DayResult>> = {
    stock_daily: backfillStockDaily,
    index_daily: backfillIndexDaily,
    margin_daily: backfillMargin,
    moneyflow_daily: backfillMoneyflow,
};

async function printProgress(): Promise<void> {
    const res = await pool.query<{ t: string; n: string; lo: string | null; hi: string | null }>(`
        SELECT 'stock_daily' t, count(*)::text n, min(trade_date)::text lo, max(trade_date)::text hi FROM stock_daily
        UNION ALL SELECT 'index_daily', count(*)::text, min(trade_date)::text, max(trade_date)::text FROM index_daily
        UNION ALL SELECT 'margin_daily', count(*)::text, min(trade_date)::text, max(trade_date)::text FROM margin_daily
        UNION ALL SELECT 'moneyflow_daily', count(*)::text, min(trade_date)::text, max(trade_date)::text FROM moneyflow_daily
    `);
    console.log('表状态：');
    for (const r of res.rows) {
        console.log(`  ${r.t.padEnd(16)} ${String(r.n).padStart(10)} 行  ${r.lo ?? '-'} ~ ${r.hi ?? '-'}`);
    }
}

async function main(): Promise<void> {
    const checkOnly = hasFlag('check');
    const start = arg('start') || DEFAULT_START;
    const end = arg('end') || ymd(new Date());
    const only = (arg('tables') || '').split(',').map((s) => s.trim()).filter(Boolean);

    if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) {
        throw new Error('--start / --end 须为 YYYYMMDD');
    }

    await printProgress();

    if (checkOnly) {
        console.log('\n--check 模式：只报告进度，不写库。');
        return;
    }

    console.log(`\n拉取交易日 ${start} ~ ${end} ...`);
    const days = await loadTradingDays(start, end);
    console.log(`共 ${days.length} 个交易日`);

    const targets = only.length > 0 ? only : Object.keys(TABLES);
    for (const t of targets) {
        if (!TABLES[t]) throw new Error(`未知表: ${t}（可选 ${Object.keys(TABLES).join(' / ')}）`);
    }

    const summary: Record<string, DayResult> = {};
    for (const t of targets) {
        console.log(`\n=== ${t} ===`);
        summary[t] = await TABLES[t](days, false);
        const r = summary[t];
        console.log(`完成：写入 ${r.ok} 行，跳过 ${r.skip} 天，失败 ${r.fail.length} 天`);
    }

    await printProgress();

    const totalFail = Object.values(summary).reduce((acc, r) => acc + r.fail.length, 0);
    if (totalFail > 0) {
        console.log(`\n⚠ 共 ${totalFail} 天失败，重跑本脚本即可续跑（已写入的会自动跳过）。失败明细：`);
        for (const [t, r] of Object.entries(summary)) {
            for (const f of r.fail.slice(0, 20)) console.log(`  ${t} ${f.day}: ${f.error}`);
            if (r.fail.length > 20) console.log(`  ${t} ... 另有 ${r.fail.length - 20} 天`);
        }
        process.exitCode = 1;
    } else {
        console.log('\n✅ 全部完成，无失败。');
    }
}

main()
    .catch((error: unknown) => {
        console.error('回填失败:', error);
        process.exit(1);
    })
    .finally(() => {
        void pool.end();
    });
