/**
 * S2：构建 state_daily（每日市场状态向量）
 *
 * 设计：docs/superpowers/specs/2026-11-25-s2-s3-state-forward-dist-design.md
 * 前置：032_state_forward_dist.sql + scripts/backfill-state-refs.ts 已完成
 *
 * 【为什么按年切片聚合，而不是一条大 SQL】
 *   生产库物理内存 7.4G、可用常年 200M 上下且挂着 8G swap、磁盘 98% 水位。
 *   `percentile_cont` 是有序集聚合，PG 必须按 (trade_date, pct_chg) 排序；
 *   一次排 1140 万行会在磁盘只剩 2.5G 的机器上留一个大临时文件。
 *   按年切片后每次只排 ~130 万行，内存与临时空间都可控。
 *   JS 侧只处理 2646 个点的序列，占用恒定在几十 MB。
 *
 * 【口径要点（每条都有代价，不要"顺手优化"）】
 *   1. 等权收益 = 全市场 avg(pct_chg)/100。含退市、含 ST、含北交所，不过滤。
 *      过滤即选择偏差 —— 状态描述的是"市场"，不是"可投资组合"。
 *   2. 涨跌停按板块阈值：科创板 20%、创业板 2020-08-24 起 20%（之前 10%）、
 *      北交所 30%、主板 ST 5%、主板非 ST 10%。
 *      **板块规则优先于 ST 规则**：创业板/科创板的 ST 也是 20%。
 *   3. 新股上市首 5 个交易日不计入涨跌停家数：20% 板新股首日无涨跌幅限制，
 *      +200% 会被误判成涨停。广度仍计入（它确实是涨的）。
 *      注意只剔除"回填区间内上市"的（first_date > 2016-01-04），
 *      否则 2016-01-04 全部 2592 只都会被当成新股。
 *   4. 两融用 T-1，且只用 SSE+SZSE：T 日收盘时只知 T-1 余额；
 *      BSE 2023 才加入且规模仅 0.3%，混入会引入水平跳变。
 *   5. 滚动分位一律 PIT：只用当日及之前，窗口 750 自然日，样本 <400 输出 NULL。
 *
 * 用法：
 *   node --import tsx scripts/build-state-daily.ts
 *   node --import tsx scripts/build-state-daily.ts --dry
 *   node --import tsx scripts/build-state-daily.ts --start 2016-01-04 --end 2026-11-25
 */

import pool from '../src/core/db';

// ---------------------------------------------------------------------------
// 参数（变更必须升 SPEC_VERSION 并整表重算）
// ---------------------------------------------------------------------------

const SPEC_VERSION = 'v1';
const DATA_START = '2016-01-04';

const PARAMS = {
    version: SPEC_VERSION,
    breadth: { low: 0.35, high: 0.65 },
    limit: { low: 0.005, mid: 0.05 },
    momentum: { shortDays: 5, longDays: 60, midDays: 20 },
    rolling: { windowDays: 750, minObs: 400, cutLow: 1 / 3, cutHigh: 2 / 3 },
    sector: { minStocksPerIndustry: 5, minIndustries: 10, excludeBse: true },
    margin: { exchanges: ['SSE', 'SZSE'], maDays: 60 },
    newListing: { skipFirstTradingDays: 5 },
    indexBase: { date: DATA_START, value: 1000 },
    calibers: { return: 'pct_chg 累乘（已含除权调整）', universe: '全 A 含退市/ST/北交所' },
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const hasFlag = (n: string): boolean => process.argv.includes(`--${n}`);

function arg(n: string): string | null {
    const i = process.argv.indexOf(`--${n}`);
    if (i < 0) return null;
    const v = process.argv[i + 1];
    return v && !v.startsWith('--') ? v : null;
}

function num(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function stddev(xs: number[]): number | null {
    if (xs.length < 2) return null;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
    return Math.sqrt(v);
}

/** 'YYYY-MM-DD' 前推 n 天（UTC 运算，不受本地时区影响） */
function shiftDays(d: string, n: number): string {
    return new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
}

/** 二分：最后一个 <= target 的下标，找不到返回 -1 */
function lastIndexLE(arr: string[], target: string): number {
    let lo = 0;
    let hi = arr.length - 1;
    let hit = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= target) { hit = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return hit;
}

/** 二分：第一个 >= target 的下标，找不到返回 arr.length */
function firstIndexGE(arr: string[], target: string): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] < target) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/**
 * PIT 分位：窗口内 <= x 的比例（中位秩，相等值算半份）。
 * 确定性：只依赖窗口内的值与 x，不依赖遍历顺序。
 */
function pctRank(values: number[], x: number, minObs: number): number | null {
    if (values.length < minObs) return null;
    let less = 0;
    let eq = 0;
    for (const v of values) {
        if (v < x) less += 1;
        else if (v === x) eq += 1;
    }
    return (less + 0.5 * eq) / values.length;
}

function bucketFromPct(p: number | null): number | null {
    if (p === null) return null;
    if (p < PARAMS.rolling.cutLow) return 0;
    if (p > PARAMS.rolling.cutHigh) return 2;
    return 1;
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface DayBase { d: string; traded: number; up: number; ewRet: number; medianPct: number; amount: number }
interface DayLimit { up: number; down: number; st: number; named: number; total: number }
interface DaySector { sectors: number; disp: number | null }
interface MarginPoint { d: string; bal: number }

// ---------------------------------------------------------------------------
// 1. 基础截面（按年切片）
// ---------------------------------------------------------------------------

function yearChunks(start: string, end: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const y0 = Number(start.slice(0, 4));
    const y1 = Number(end.slice(0, 4));
    for (let y = y0; y <= y1; y += 1) {
        const cs = `${y}-01-01`;
        const ce = `${y}-12-31`;
        out.push([cs < start ? start : cs, ce > end ? end : ce]);
    }
    return out;
}

async function buildBaseSeries(chunks: Array<[string, string]>): Promise<DayBase[]> {
    const all: DayBase[] = [];
    for (const [s, e] of chunks) {
        const r = await pool.query(
            `SELECT trade_date::text AS d,
                    count(*)                                             AS traded,
                    count(*) FILTER (WHERE pct_chg > 0)                  AS up,
                    avg(pct_chg) / 100.0                                 AS ew_ret,
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY pct_chg) AS med,
                    sum(amount)                                          AS amount
               FROM stock_daily
              WHERE trade_date >= $1::date AND trade_date <= $2::date
                AND vol > 0 AND pct_chg IS NOT NULL
              GROUP BY 1 ORDER BY 1`,
            [s, e],
        );
        for (const x of r.rows) {
            all.push({
                d: x.d,
                traded: Number(x.traded),
                up: Number(x.up),
                ewRet: Number(x.ew_ret),
                medianPct: Number(x.med),
                amount: num(x.amount) ?? 0,
            });
        }
    }
    return all;
}

// ---------------------------------------------------------------------------
// 2. 涨跌停
// ---------------------------------------------------------------------------

async function loadNewListingExclusions(dataStart: string): Promise<Set<string>> {
    const r = await pool.query(
        `WITH ranked AS (
            SELECT ts_code, trade_date::text AS d,
                   row_number() OVER (PARTITION BY ts_code ORDER BY trade_date) AS rn,
                   min(trade_date) OVER (PARTITION BY ts_code) AS first_date
              FROM stock_daily WHERE vol > 0
         )
         SELECT ts_code || '|' || d AS k FROM ranked
          WHERE first_date > $1::date AND rn <= $2`,
        [dataStart, PARAMS.newListing.skipFirstTradingDays],
    );
    return new Set(r.rows.map((x) => x.k));
}

/**
 * 逐日涨跌停家数。
 * 新股剔除在 JS 侧做（名单只有万级），避免在 1140 万行上再套一层窗口排序。
 */
async function buildLimitSeries(
    chunks: Array<[string, string]>,
    excl: Set<string>,
): Promise<Map<string, DayLimit>> {
    const out = new Map<string, DayLimit>();
    for (const [s, e] of chunks) {
        const r = await pool.query(
            `SELECT d.trade_date::text AS d,
                    d.ts_code,
                    d.pct_chg,
                    COALESCE(n.is_st, false) AS is_st,
                    (n.start_date IS NOT NULL) AS has_name,
                    CASE
                        WHEN d.ts_code LIKE '688%' THEN 19.8
                        WHEN d.ts_code LIKE '30%' AND d.trade_date >= DATE '2020-08-24' THEN 19.8
                        WHEN d.ts_code LIKE '30%' THEN 9.8
                        WHEN d.ts_code LIKE '%.BJ' THEN 29.8
                        WHEN COALESCE(n.is_st, false) THEN 4.8
                        ELSE 9.8
                    END AS threshold
               FROM stock_daily d
               LEFT JOIN LATERAL (
                    SELECT is_st, start_date FROM stock_name_hist h
                     WHERE h.ts_code = d.ts_code
                       AND h.start_date <= d.trade_date
                       AND (h.end_date IS NULL OR h.end_date >= d.trade_date)
                     ORDER BY h.start_date DESC LIMIT 1
               ) n ON true
              WHERE d.trade_date >= $1::date AND d.trade_date <= $2::date
                AND d.vol > 0 AND d.pct_chg IS NOT NULL`,
            [s, e],
        );

        for (const x of r.rows) {
            if (excl.has(`${x.ts_code}|${x.d}`)) continue;
            const cur = out.get(x.d) ?? { up: 0, down: 0, st: 0, named: 0, total: 0 };
            const p = Number(x.pct_chg);
            const th = Number(x.threshold);
            if (p >= th) cur.up += 1;
            if (p <= -th) cur.down += 1;
            if (x.is_st) cur.st += 1;
            if (x.has_name) cur.named += 1;
            cur.total += 1;
            out.set(x.d, cur);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// 3. 板块分化度
// ---------------------------------------------------------------------------

async function assertNoIndustryOverlap(): Promise<void> {
    const r = await pool.query(
        `SELECT count(*) AS n FROM stock_industry_hist a
           JOIN stock_industry_hist b
             ON a.ts_code = b.ts_code AND a.l1_code = b.l1_code AND a.in_date < b.in_date
          WHERE (a.out_date IS NULL OR a.out_date >= b.in_date)`,
    );
    const n = Number(r.rows[0].n);
    if (n > 0) {
        throw new Error(`stock_industry_hist 有 ${n} 对重叠区间，行业分化度会重复计权。先修数据。`);
    }
}

async function buildSectorSeries(chunks: Array<[string, string]>): Promise<Map<string, DaySector>> {
    await assertNoIndustryOverlap();
    const out = new Map<string, DaySector>();
    for (const [s, e] of chunks) {
        const r = await pool.query(
            `WITH m AS (
                SELECT d.trade_date AS dt, i.l1_name, avg(d.pct_chg) AS r
                  FROM stock_daily d
                  JOIN stock_industry_hist i
                    ON i.ts_code = d.ts_code
                   AND d.trade_date >= i.in_date
                   AND (i.out_date IS NULL OR d.trade_date <= i.out_date)
                 WHERE d.trade_date >= $1::date AND d.trade_date <= $2::date
                   AND d.vol > 0 AND d.pct_chg IS NOT NULL
                   AND ($3::boolean IS NOT TRUE OR d.ts_code NOT LIKE '%.BJ')
                 GROUP BY 1, 2
                HAVING count(*) >= $4
             )
             -- 除 100：stddev 出来是百分点，而 ew_ret / mom_* 都是小数，统一口径
             SELECT dt::text AS d, count(*) AS sectors, stddev_samp(r) / 100.0 AS disp
               FROM m GROUP BY 1 HAVING count(*) >= $5 ORDER BY 1`,
            [s, e, PARAMS.sector.excludeBse, PARAMS.sector.minStocksPerIndustry, PARAMS.sector.minIndustries],
        );
        for (const x of r.rows) {
            out.set(x.d, { sectors: Number(x.sectors), disp: num(x.disp) });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// 4. 两融
// ---------------------------------------------------------------------------

async function loadMarginSeries(): Promise<MarginPoint[]> {
    const r = await pool.query(
        `SELECT trade_date::text AS d, sum(rzrqye) AS bal
           FROM margin_daily
          WHERE exchange_id = ANY($1::text[])
          GROUP BY 1 ORDER BY 1`,
        [PARAMS.margin.exchanges],
    );
    return r.rows
        .map((x) => ({ d: x.d, bal: Number(x.bal) }))
        .filter((p) => Number.isFinite(p.bal) && p.bal > 0);
}

// ---------------------------------------------------------------------------
// 5. 组装 + 派生
// ---------------------------------------------------------------------------

type Row = Record<string, number | string | boolean | null>;

function assemble(
    base: DayBase[],
    limits: Map<string, DayLimit>,
    sectors: Map<string, DaySector>,
    margins: MarginPoint[],
    limitApprox: boolean,
): Row[] {
    const marginDates = margins.map((m) => m.d);
    // 两融 ratio 序列（bal/MA60）预先算一次：逐日重算是 O(750×60)，纯浪费
    const marginRatios: Array<number | null> = margins.map((m, k) => {
        if (k < PARAMS.margin.maDays - 1) return null;
        const base = margins.slice(k - (PARAMS.margin.maDays - 1), k + 1);
        const mean = base.reduce((a, c) => a + c.bal, 0) / base.length;
        return mean > 0 ? m.bal / mean : null;
    });
    const dates = base.map((x) => x.d); // 提到循环外：滚动分位要用日期二分，逐次 map 是 O(n²)
    const rows: Row[] = [];
    const closes: number[] = [];
    const volSeries: Array<number | null> = [];
    const dispSeries: Array<number | null> = [];
    const amountSeries: number[] = [];

    let indexClose = PARAMS.indexBase.value;
    let prevBucketBreadth: number | null = null;
    let runLen = 0;

    for (let i = 0; i < base.length; i += 1) {
        const b = base[i];
        indexClose *= 1 + b.ewRet;
        closes.push(indexClose);
        amountSeries.push(b.amount);

        // ---------- 动量：用等权指数点位（不是简单累加收益率，避免再投资误差）
        const momOf = (n: number): number | null => (i >= n ? closes[i] / closes[i - n] - 1 : null);
        const mom5 = momOf(PARAMS.momentum.shortDays);
        const mom20 = momOf(PARAMS.momentum.midDays);
        const mom60 = momOf(PARAMS.momentum.longDays);

        // ---------- 波动：20 日已实现，年化
        const w = base.slice(Math.max(0, i - 19), i + 1).map((x) => x.ewRet);
        const vol20 = w.length === 20 ? (() => {
            const sd = stddev(w);
            return sd === null ? null : sd * Math.sqrt(252);
        })() : null;
        volSeries.push(vol20);

        // ---------- 量能：成交额 / 过去 60 日均值
        let amountRel: number | null = null;
        if (i >= 60) {
            const win = amountSeries.slice(i - 59, i + 1);
            const m = win.reduce((a, c) => a + c, 0) / win.length;
            amountRel = m > 0 ? b.amount / m : null;
        }

        // ---------- 两融 T-1
        let mBal: number | null = null;
        let mIdx = -1;
        if (i > 0) {
            mIdx = lastIndexLE(marginDates, base[i - 1].d);
            if (mIdx >= 0) mBal = margins[mIdx].bal;
        }
        let marginRatio: number | null = null;
        let marginRatioPct: number | null = null;
        let marginPct: number | null = null;
        if (mBal !== null && mIdx >= PARAMS.margin.maDays - 1) {
            marginRatio = marginRatios[mIdx];

            const from = firstIndexGE(marginDates, shiftDays(margins[mIdx].d, -PARAMS.rolling.windowDays));
            const win3y = margins.slice(from, mIdx + 1).map((x) => x.bal);
            marginPct = pctRank(win3y, mBal, PARAMS.rolling.minObs);

            // 分档用的是**去趋势**的 ratio 分位：余额水平分位对上升趋势序列会长期贴顶
            if (marginRatio !== null) {
                const winRatio: number[] = [];
                for (let k = from; k <= mIdx; k += 1) {
                    const v = marginRatios[k];
                    if (v !== null) winRatio.push(v);
                }
                marginRatioPct = pctRank(winRatio, marginRatio, PARAMS.rolling.minObs);
            }
        }

        // ---------- 板块分化度
        const sec = sectors.get(b.d) ?? null;
        dispSeries.push(sec?.disp ?? null);
        let dispPct: number | null = null;
        if (sec?.disp != null) {
            const from = firstIndexGE(dates, shiftDays(b.d, -PARAMS.rolling.windowDays));
            const win: number[] = [];
            for (let k = from; k <= i; k += 1) {
                const v = dispSeries[k];
                if (v != null) win.push(v);
            }
            dispPct = pctRank(win, sec.disp, PARAMS.rolling.minObs);
        }

        // ---------- 波动分位（同样 PIT）
        let volPct: number | null = null;
        if (vol20 !== null) {
            const from = firstIndexGE(dates, shiftDays(b.d, -PARAMS.rolling.windowDays));
            const win: number[] = [];
            for (let k = from; k <= i; k += 1) {
                const v = volSeries[k];
                if (v != null) win.push(v);
            }
            volPct = pctRank(win, vol20, PARAMS.rolling.minObs);
        }

        // ---------- 档位
        const upRatio = b.up / b.traded;
        const lim = limits.get(b.d);
        const limitDownPct = lim ? lim.down / b.traded : 0;
        const limitUpPct = lim ? lim.up / b.traded : 0;
        const bucketBreadth = upRatio < PARAMS.breadth.low ? 0 : upRatio > PARAMS.breadth.high ? 2 : 1;
        const bucketLimit = limitDownPct < PARAMS.limit.low ? 0 : limitDownPct <= PARAMS.limit.mid ? 1 : 2;

        let quadrant: number | null = null;
        let bucketMomentum: number | null = null;
        if (mom5 !== null && mom60 !== null) {
            const s = mom5 > 0;
            const l = mom60 > 0;
            quadrant = s && l ? 3 : s && !l ? 2 : !s && l ? 1 : 0;
            // 双正→高、双负→低、分歧→中。分歧单独成档，因为它既不是趋势延续也不是趋势反转
            bucketMomentum = quadrant === 3 ? 2 : quadrant === 0 ? 0 : 1;
        }

        // ---------- 连续期
        if (prevBucketBreadth === bucketBreadth) runLen += 1; else runLen = 1;
        prevBucketBreadth = bucketBreadth;

        const last10 = base.slice(Math.max(0, i - 9), i + 1);
        const downDays10 = last10.length === 10 ? last10.filter((x) => x.ewRet < 0).length : null;

        rows.push({
            trade_date: b.d,
            traded_count: b.traded,
            breadth_up_ratio: upRatio,
            breadth_median_pct: b.medianPct,
            limit_up_count: lim?.up ?? 0,
            limit_down_count: lim?.down ?? 0,
            limit_up_pct: limitUpPct,
            limit_down_pct: limitDownPct,
            limit_net_pct: limitUpPct - limitDownPct,
            st_count: lim?.st ?? null,
            // 逐日判定：早期 namechange 覆盖不到 100%，那些天的 ST 会漏判，必须标出来
            limit_approx: lim && lim.total > 0 ? lim.named / lim.total < 0.999 : limitApprox,
            ew_ret: b.ewRet,
            ew_index_close: indexClose,
            mom_5: mom5,
            mom_20: mom20,
            mom_60: mom60,
            momentum_quadrant: quadrant,
            vol_20: vol20,
            margin_bal: mBal,
            margin_ratio: marginRatio,
            margin_ratio_pct: marginRatioPct,
            margin_pct_3y: marginPct,
            sector_count: sec?.sectors ?? null,
            sector_dispersion: sec?.disp ?? null,
            sector_pit: true,
            amount_total: b.amount,
            amount_rel: amountRel,
            days_in_bucket_breadth: runLen,
            down_days_10: downDays10,
            bucket_breadth: bucketBreadth,
            bucket_limit: bucketLimit,
            bucket_momentum: bucketMomentum,
            bucket_vol: bucketFromPct(volPct),
            bucket_margin: bucketFromPct(marginRatioPct),
            bucket_dispersion: bucketFromPct(dispPct),
        });
    }

    return rows;
}

// ---------------------------------------------------------------------------
// 6. 写库
// ---------------------------------------------------------------------------

const COLUMNS = [
    'trade_date', 'traded_count', 'breadth_up_ratio', 'breadth_median_pct',
    'limit_up_count', 'limit_down_count', 'limit_up_pct', 'limit_down_pct', 'limit_net_pct',
    'st_count', 'limit_approx',
    'ew_ret', 'ew_index_close', 'mom_5', 'mom_20', 'mom_60', 'momentum_quadrant', 'vol_20',
    'margin_bal', 'margin_ratio', 'margin_ratio_pct', 'margin_pct_3y',
    'sector_count', 'sector_dispersion', 'sector_pit',
    'amount_total', 'amount_rel',
    'days_in_bucket_breadth', 'down_days_10',
    'bucket_breadth', 'bucket_limit', 'bucket_momentum', 'bucket_vol', 'bucket_margin', 'bucket_dispersion',
    'spec_version', 'params',
];

async function writeRows(rows: Row[]): Promise<number> {
    const CHUNK = 100; // 100 × 36 = 3600 参数，远低于 65535 上限
    let written = 0;
    const paramsJson = JSON.stringify(PARAMS);

    for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const values: unknown[] = [];
        const tuples = chunk.map((r) => {
            const ph = COLUMNS.map((c) => {
                if (c === 'spec_version') { values.push(SPEC_VERSION); return `$${values.length}`; }
                if (c === 'params') { values.push(paramsJson); return `$${values.length}::jsonb`; }
                const v = r[c];
                values.push(v === undefined ? null : v);
                return `$${values.length}`;
            });
            return `(${ph.join(',')})`;
        });

        const res = await pool.query(
            `INSERT INTO state_daily (${COLUMNS.join(',')})
             VALUES ${tuples.join(',')}
             ON CONFLICT (trade_date) DO UPDATE SET
                ${COLUMNS.filter((c) => c !== 'trade_date')
                    .map((c) => `${c} = EXCLUDED.${c}`)
                    .join(',\n                ')},
                computed_at = now()`,
            values,
        );
        written += res.rowCount ?? 0;
        process.stdout.write(`\r  写入 ${written}/${rows.length}`);
    }
    process.stdout.write('\n');
    return written;
}

// ---------------------------------------------------------------------------
// 7. 自检
// ---------------------------------------------------------------------------

async function verify(): Promise<void> {
    console.log('\n=== 自检 ===');

    const cover = await pool.query(
        `SELECT count(*) AS rows,
                min(trade_date)::text AS d0,
                max(trade_date)::text AS d1,
                count(*) FILTER (WHERE bucket_breadth IS NULL)    AS null_breadth,
                count(*) FILTER (WHERE bucket_vol IS NULL)        AS null_vol,
                count(*) FILTER (WHERE bucket_margin IS NULL)     AS null_margin,
                count(*) FILTER (WHERE bucket_dispersion IS NULL) AS null_disp
           FROM state_daily WHERE spec_version = $1`,
        [SPEC_VERSION],
    );
    console.table(cover.rows[0]);

    // 交易日完整性：state_daily 的日期集合必须等于 stock_daily 的日期集合
    const gap = await pool.query(
        `SELECT (SELECT count(DISTINCT trade_date) FROM stock_daily) AS sd_days,
                (SELECT count(*) FROM state_daily WHERE spec_version = $1) AS st_days,
                (SELECT count(*) FROM (
                    SELECT DISTINCT trade_date FROM stock_daily
                    EXCEPT SELECT trade_date FROM state_daily WHERE spec_version = $1
                ) x) AS missing`,
        [SPEC_VERSION],
    );
    console.table(gap.rows[0]);

    // 档位分布：每档天数（用于预判 n_eff 是否够）
    const dist = await pool.query(
        `SELECT 'breadth' AS dim, bucket_breadth AS b, count(*) AS days FROM state_daily WHERE spec_version=$1 GROUP BY 2
         UNION ALL SELECT 'limit', bucket_limit, count(*) FROM state_daily WHERE spec_version=$1 GROUP BY 2
         UNION ALL SELECT 'momentum', bucket_momentum, count(*) FROM state_daily WHERE spec_version=$1 GROUP BY 2
         UNION ALL SELECT 'vol', bucket_vol, count(*) FROM state_daily WHERE spec_version=$1 GROUP BY 2
         UNION ALL SELECT 'margin', bucket_margin, count(*) FROM state_daily WHERE spec_version=$1 GROUP BY 2
         UNION ALL SELECT 'dispersion', bucket_dispersion, count(*) FROM state_daily WHERE spec_version=$1 GROUP BY 2
         ORDER BY 1, 2`,
        [SPEC_VERSION],
    );
    console.log('\n档位天数分布（20 日窗口下 ÷20 才是独立观测数）：');
    console.table(dist.rows.map((r) => ({ dim: r.dim, bucket: r.b, days: r.days, n_eff_20d: Math.round(Number(r.days) / 20) })));

    // 关键日核对
    const probes = await pool.query(
        `SELECT trade_date::text AS d, traded_count, round(breadth_up_ratio::numeric,3) AS up_r,
                round(breadth_median_pct::numeric,2) AS med, limit_up_count AS lu, limit_down_count AS ld,
                st_count, round(limit_down_pct::numeric,4) AS ld_pct,
                round(mom_5::numeric,4) AS mom5, momentum_quadrant AS quad,
                bucket_breadth AS bb, bucket_limit AS bl, bucket_momentum AS bm
           FROM state_daily
          WHERE trade_date IN ('2021-01-06','2024-01-22','2024-02-05','2018-10-19')
          ORDER BY trade_date`,
    );
    console.log('\n关键日核对（2024-02-05 应为 广度低档 + 跌停极多）：');
    console.table(probes.rows);

    // 等权指数与沪深300的背离（验证 2024-02-05 的口径差异）
    const diverge = await pool.query(
        `SELECT s.trade_date::text AS d,
                round(100 * (s.ew_ret)::numeric, 2) AS ew_pct,
                round(i.pct_chg::numeric, 2) AS hs300_pct
           FROM state_daily s JOIN index_daily i
             ON i.trade_date = s.trade_date AND i.ts_code = '000300.SH'
          WHERE s.trade_date IN ('2024-01-22','2024-02-05','2021-01-06')
          ORDER BY 1`,
    );
    console.log('\n等权 vs 沪深300（口径差异实证）：');
    console.table(diverge.rows);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const dry = hasFlag('dry');
    const dataStart = arg('data-start') ?? DATA_START;
    const start = arg('start') ?? dataStart;
    // end 缺省必须取库里真实最大交易日：写死未来日期会让 yearChunks 切出几十个空段
    const end = arg('end') ?? String(
        (await pool.query('SELECT max(trade_date)::text AS d FROM stock_daily')).rows[0].d ?? start,
    );

    const pre = await pool.query(
        `SELECT (SELECT count(*) FROM stock_name_hist) AS name_rows,
                (SELECT count(*) FROM stock_industry_hist) AS ind_rows`,
    );
    if (Number(pre.rows[0].name_rows) === 0 || Number(pre.rows[0].ind_rows) === 0) {
        throw new Error('参考表为空。先跑 scripts/backfill-state-refs.ts，否则 ST 与行业都会静默失真。');
    }

    const chunks = yearChunks(start, end);
    console.log(`区间 ${start} ~ ${end}，切 ${chunks.length} 段`);

    console.log('[1/4] 基础截面');
    const base = await buildBaseSeries(chunks);
    console.log(`  ${base.length} 个交易日`);

    console.log('[2/4] 涨跌停');
    const excl = await loadNewListingExclusions(dataStart);
    const limits = await buildLimitSeries(chunks, excl);
    console.log(`  ${limits.size} 天，剔除新股首 ${PARAMS.newListing.skipFirstTradingDays} 个交易日样本 ${excl.size} 条`);

    console.log('[3/4] 板块分化度');
    const sectors = await buildSectorSeries(chunks);
    console.log(`  ${sectors.size} 天`);

    console.log('[4/4] 两融 + 组装');
    const margins = await loadMarginSeries();
    console.log(`  ${margins.length} 个两融交易日（${PARAMS.margin.exchanges.join('+')}）`);

    const cov = await pool.query(
        `WITH s AS (SELECT DISTINCT ts_code FROM stock_daily WHERE trade_date = $1::date)
         SELECT count(*) AS traded, count(n.is_st) AS named
           FROM s LEFT JOIN LATERAL (
                SELECT is_st FROM stock_name_hist h
                 WHERE h.ts_code = s.ts_code AND h.start_date <= $1::date
                   AND (h.end_date IS NULL OR h.end_date >= $1::date)
                 ORDER BY h.start_date DESC LIMIT 1
           ) n ON true`,
        [base[base.length - 1].d],
    );
    const tradedN = Number(cov.rows[0].traded);
    const namedN = Number(cov.rows[0].named);
    const nameCoverage = tradedN > 0 ? namedN / tradedN : 0;
    if (nameCoverage < 0.99) {
        throw new Error(`名称覆盖率仅 ${(nameCoverage * 100).toFixed(2)}%，ST 判定会失真。先补 namechange。`);
    }
    const limitApprox = nameCoverage < 0.999;
    console.log(`  名称覆盖率 ${(nameCoverage * 100).toFixed(3)}%，limit_approx=${limitApprox}`);

    const rows = assemble(base, limits, sectors, margins, limitApprox);
    console.log(`  组装 ${rows.length} 行`);

    if (dry) {
        console.log('\n--dry 不写库。抽样：');
        const pick = ['2024-02-05', '2024-01-22', '2021-01-06', '2018-10-19'];
        console.table(rows.filter((r) => pick.includes(String(r.trade_date))).map((r) => ({
            d: r.trade_date, traded: r.traded_count,
            up_r: Number(r.breadth_up_ratio).toFixed(3), med: Number(r.breadth_median_pct).toFixed(2),
            lu: r.limit_up_count, ld: r.limit_down_count, st: r.st_count,
            ew: Number(r.ew_index_close).toFixed(1),
            mom5: r.mom_5 === null ? '-' : Number(r.mom_5).toFixed(4),
            quad: r.momentum_quadrant, bb: r.bucket_breadth, bl: r.bucket_limit,
        })));
        await pool.end();
        return;
    }

    // 覆盖度守卫：算出来的天数必须等于区间内 stock_daily 的实际交易日数。
    // 为什么需要：writeRows 是 upsert，只覆盖它算出的那些日期，
    // 其余日期会保留旧值。一旦 stock_daily 只回填了一部分（本地开发库常见），
    // 就会得到"一半新、一半旧"的表，而且没有任何报错 —— 这是最难查的那种错。
    const expect = await pool.query(
        `SELECT count(DISTINCT trade_date)::int AS n FROM stock_daily
          WHERE trade_date >= $1::date AND trade_date <= $2::date`,
        [start, end],
    );
    const expected = Number(expect.rows[0].n);
    if (rows.length !== expected) {
        throw new Error(
            `状态行数 ${rows.length} 与 stock_daily 区间内交易日数 ${expected} 不一致。` +
            '这通常意味着 stock_daily 只回填了一部分，继续写会把其余日期留成旧值。',
        );
    }

    const n = await writeRows(rows);
    console.log(`写库完成 ${n} 行`);
    await verify();
    await pool.end();
}

main().catch(async (e) => {
    console.error('\n失败：', e instanceof Error ? e.message : e);
    await pool.end().catch(() => undefined);
    process.exit(1);
});
