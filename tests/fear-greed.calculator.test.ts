import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { computeJq, resolveSnapshotDate, __fearGreedDeps, type BreadthCache, type DailyLimit, type LimitCache, type TushareClient } from '../src/modules/fear-greed/calculator';
import { tradingCalendarStore } from '../src/shared/utils/tradingCalendarStore';

/** 生成连续 YYYYMMDD 日期（跳过周末简化） */
function genDates(n: number): string[] {
    const out: string[] = [];
    const base = new Date(2026, 0, 1);
    let added = 0;
    while (added < n) {
        const d = new Date(base);
        d.setDate(base.getDate() + added * 1);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        out.push(`${y}${m}${day}`);
        added += 1;
    }
    return out;
}

const DATES = genDates(50);

/**
 * 交易日历**统一来源**（tradingCalendarStore）在单测中注入为固定窗口 DATES，
 * 等价于改造前 `client.request('trade_cal')` 的返回值（50 天）。
 */
const originalRecentTradingDays = __fearGreedDeps.recentTradingDays;
beforeEach(() => {
    __fearGreedDeps.recentTradingDays = (n: number) => DATES.slice(-n);
});
afterEach(() => {
    __fearGreedDeps.recentTradingDays = originalRecentTradingDays;
});

/** 构造可控 mock tushare 客户端 */
function makeClient(): TushareClient {
    return {
        async request(apiName: string, params: Record<string, unknown>, fields = '') {
            switch (apiName) {
                // 交易日历必须走统一事实源（tradingCalendarStore），不得直连 Tushare trade_cal
                // → 故意不提供该 case，落到 default 抛错，锁死回归。
                case 'fund_daily':
                    // 50ETF：构造递减（波动升高）的收盘价
                    return DATES.map((trade_date, i) => ({ trade_date, close: 100 - i * 0.3 }));
                case 'moneyflow_hsgt':
                    // 北向资金：先负后正（近期流入增多）
                    return DATES.map((trade_date, i) => ({ trade_date, north_money: i < 20 ? -5 : 5 }));
                case 'index_weight':
                    return ['000001.SZ', '000002.SZ', '600000.SH'].flatMap((con_code) =>
                        DATES.map((trade_date) => ({ con_code, trade_date })));
                case 'daily': {
                    const p = params as { trade_date?: string; ts_code?: string; start_date?: string; end_date?: string };
                    if (p.trade_date) {
                        // 全市场按日：用于涨跌停推导（涨停=收盘达涨停价，炸板=触板未封，跌停=收盘达跌停价）
                        const i = DATES.indexOf(String(p.trade_date));
                        const late = i >= 40;
                        const base = 100;
                        const r2 = (v: number) => Math.round(v * 100) / 100;
                        const mk = (ts_code: string, pre: number, close: number, high: number) => ({
                            ts_code, pre_close: pre, close, high,
                            pct_chg: Math.round(((close - pre) / pre) * 10000) / 100,
                        });
                        return [
                            // 早段 1 只涨停，后段 2 只涨停（封板率抬升）；600001 全期封板 → 连板递增
                            mk('600001.SH', base, r2(base * 1.1), r2(base * 1.1)),
                            ...(late ? [mk('600002.SH', base, r2(base * 1.1), r2(base * 1.1))] : []),
                            // 创业板触板未封 → 炸板
                            mk('300001.SZ', base, base + 5, r2(base * 1.2)),
                            // 跌停
                            mk('600003.SH', base, r2(base * 0.9), r2(base * 0.9)),
                        ];
                    }
                    // 沪深300成分股：近期 pct_chg 正值占比升高 → 宽度走强
                    return ['000001.SZ', '000002.SZ', '600000.SH'].flatMap((ts_code) =>
                        DATES.map((trade_date, i) => ({
                            ts_code, trade_date,
                            pct_chg: i >= 40 ? 2 : -1,
                        })));
                }
                case 'fut_daily':
                    // IF 期货：后期升水（close > 现货）
                    return DATES.map((trade_date, i) => ({ trade_date, close: 100 + (i >= 40 ? 1.2 : -0.2) }));
                case 'index_daily': {
                    const tsCode = String(params.ts_code);
                    if (tsCode === '000012.SH') {
                        // 国债指数：平稳上行
                        return DATES.map((trade_date, i) => ({ trade_date, close: 150 + i * 0.1 }));
                    }
                    // 000300.SH / 000001.SH：现货波动上行
                    return DATES.map((trade_date, i) => ({ trade_date, close: 100 + i * 0.5 }));
                }
                case 'margin':
                    return DATES.map((trade_date, i) => ({ trade_date, rzmre: 5e9 + i * 1e8 }));
                default:
                    throw new Error(`unexpected api: ${apiName} ${JSON.stringify(params)} ${fields}`);
            }
        },
    };
}

/** 内存版 breadth 缓存 */
function makeCache(): BreadthCache & { upserted: number } {
    const map = new Map<string, number>();
    return {
        map,
        upserted: 0,
        async getAll() { return map; },
        async upsert(rows) {
            for (const r of rows) {
                map.set(r.tradeDate, r.upRatio);
                this.upserted += 1;
            }
        },
    };
}

/** 内存版 limit 缓存 */
function makeLimitCache(): LimitCache & { upserted: number } {
    const map = new Map<string, DailyLimit>();
    return {
        map,
        upserted: 0,
        async getAll() { return map; },
        async upsert(rows) {
            for (const r of rows) {
                map.set(r.date, r);
                this.upserted += 1;
            }
        },
    };
}

test('computeJq 返回完整结构（key/name/10 指标/合成指数）', async () => {
    const cache = makeCache();
    const result = await computeJq(makeClient(), cache, makeLimitCache());

    assert.equal(result.key, 'jq');
    assert.equal(result.name, '韭圈儿恐贪指数');
    assert.equal(result.indicators.length, 10);
    assert.ok(result.composite >= 0 && result.composite <= 100);
    assert.ok(typeof result.label === 'string' && result.label.length > 0);
    // 综合指数历史存在
    assert.ok(result.history.dates.length > 0);
    assert.equal(result.history.dates.length, result.history.scores.length);
    // 二次百分位：composite = 最新日在历史序列中的百分位排名（= 历史序列首位）
    assert.equal(result.composite, result.history.scores[0], 'composite 应为当前日在全历史窗口中的百分位排名');
    // 分布展开：对 500 日窗口做百分位排名，历史两端应接近 0/100
    assert.ok(Math.min(...result.history.scores) <= 10, '历史应覆盖到恐惧端（<=10）');
    assert.ok(Math.max(...result.history.scores) >= 90, '历史应覆盖到贪婪端（>=90）');
});

test('margin 指标标记 excluded（不计入综合指数）', async () => {
    const result = await computeJq(makeClient(), makeCache(), makeLimitCache());
    const margin = result.indicators.find((i) => i.key === 'margin');
    assert.ok(margin);
    assert.equal(margin.excluded, true);
});

test('breadth 缓存 upsert 被调用并写入缺失日期', async () => {
    const cache = makeCache();
    await computeJq(makeClient(), cache, makeLimitCache());
    assert.ok(cache.upserted > 0, 'breadth 应写入增量缓存');
    const all = await cache.getAll();
    assert.ok(all.size > 0);
});

test('limit 缓存 upsert 被调用并写入缺失日期', async () => {
    const cache = makeLimitCache();
    await computeJq(makeClient(), makeCache(), cache);
    assert.ok(cache.upserted > 0, 'limit 应写入增量缓存');
    const all = await cache.getAll();
    assert.ok(all.size > 0);
    // 每个缓存日期的涨跌停聚合应有推导结果
    const sample = [...all.values()][0];
    assert.ok(sample.sealCount > 0, '封板数应 > 0');
    assert.ok(sample.breakCount > 0, '炸板数应 > 0');
    assert.ok(sample.downCount > 0, '跌停数应 > 0');
});

test('breadth 在 daily 无数据的交易日不落库占位 50，最新值回退最后有效日', async () => {
    // 模拟 Tushare EOD 尚未发布：最近两个交易日没有任何成分股日线
    const unpublished = new Set([DATES[DATES.length - 2], DATES[DATES.length - 1]]);
    const base = makeClient();
    const client: TushareClient = {
        async request(apiName, params, fields) {
            const p = params as { trade_date?: string };
            if (apiName === 'daily' && !p.trade_date) {
                const rows = await base.request(apiName, params, fields);
                return rows.filter((r) => !unpublished.has(String(r.trade_date)));
            }
            return base.request(apiName, params, fields);
        },
    };
    const cache = makeCache();
    const result = await computeJq(client, cache, makeLimitCache());

    const all = await cache.getAll();
    for (const d of unpublished) {
        assert.equal(all.has(d), false, `无 EOD 数据的交易日不得落库占位 50: ${d}`);
    }
    const breadth = result.indicators.find((i) => i.key === 'breadth')!;
    // 占位 50 会把“最新一日”伪造成中性；应回退到最后一个有真实数据的交易日
    assert.equal(breadth.history.dates[0], DATES[DATES.length - 3]);
    assert.equal(breadth.raw, 100, '最新值应为最后有效日的真实宽度（3/3 上涨）');
});

test('limit 在 daily 无数据的交易日不落库全 0，指标取最后有效日', async () => {
    const unpublished = DATES[DATES.length - 1];
    const base = makeClient();
    const client: TushareClient = {
        async request(apiName, params, fields) {
            const p = params as { trade_date?: string };
            if (apiName === 'daily' && p.trade_date === unpublished) return [];
            return base.request(apiName, params, fields);
        },
    };
    const limitCache = makeLimitCache();
    const result = await computeJq(client, makeCache(), limitCache);

    const all = await limitCache.getAll();
    assert.equal(all.has(unpublished), false, '无数据的交易日不得落库全 0 占位');

    const seal = result.indicators.find((i) => i.key === 'seal_rate')!;
    const streak = result.indicators.find((i) => i.key === 'streak')!;
    assert.equal(seal.raw, 66.67, '封板率应取最后有效日（2 封板 / 1 炸板）');
    assert.ok(streak.raw > 0, '连板高度应取最后有效日，不得被占位 0 覆盖');
    assert.equal(seal.history.dates[0], DATES[DATES.length - 2]);
});

test('limit 缓存中的历史占位行（全 0）会被重新推导覆盖', async () => {
    const dirtyDate = DATES[DATES.length - 1];
    const limitCache = makeLimitCache();
    limitCache.map.set(dirtyDate, {
        date: dirtyDate,
        sealCount: 0,
        breakCount: 0,
        downCount: 0,
        maxStreak: 0,
        sealCodes: [],
    });
    await computeJq(makeClient(), makeCache(), limitCache);

    const healed = (await limitCache.getAll()).get(dirtyDate)!;
    assert.ok(healed.sealCount > 0, '历史全 0 占位行应视为缺失并回补');
});

test('快照日期取最新已算出的交易日，跨 UTC 零点不写错日期', () => {
    // 上海 2026-11-03 07:30 = UTC 2026-11-02 23:30；若用 UTC 当日会错写成 11-02
    const now = new Date('2026-11-02T23:30:00.000Z');
    assert.equal(resolveSnapshotDate(['20261102', '20261030'], now), '2026-11-02');
    assert.equal(resolveSnapshotDate([], now), '2026-11-03', '无历史时退回上海当日');
});

test('交易日历未加载时拒绝计算（不按工作日降级写节假日占位）', () => {
    const prev = __fearGreedDeps.recentTradingDays;
    tradingCalendarStore.__resetForTest();
    __fearGreedDeps.recentTradingDays = originalRecentTradingDays;
    try {
        assert.throws(
            () => __fearGreedDeps.recentTradingDays(10),
            /trading_calendar_not_loaded/,
            '日历未加载时按「周一~周五」降级会把节假日写进缓存（2026-11-02 事故脏行来源）',
        );
    } finally {
        __fearGreedDeps.recentTradingDays = prev;
    }
});

test('收盘前剔除今日（EOD 未发布），收盘后纳入', () => {
    tradingCalendarStore.__setForTest(
        {
            '2026-10-29': true,
            '2026-10-30': true,
            '2026-11-01': false,
            '2026-11-02': true,
            '2026-11-03': true,
            '2026-11-04': true,
        },
        '2026-10-29',
        '2026-11-04',
    );
    const prev = __fearGreedDeps.recentTradingDays;
    __fearGreedDeps.recentTradingDays = originalRecentTradingDays;
    try {
        // 上海 2026-11-03 09:30（UTC 01:30）：今日 EOD 未发布，窗口应止于 11-02
        assert.deepEqual(originalRecentTradingDays(2, new Date('2026-11-03T01:30:00Z')), [
            '20261030',
            '20261102',
        ]);
        // 上海 2026-11-03 16:30（UTC 08:30）：收盘后纳入今日
        assert.deepEqual(originalRecentTradingDays(2, new Date('2026-11-03T08:30:00Z')), [
            '20261102',
            '20261103',
        ]);
    } finally {
        __fearGreedDeps.recentTradingDays = prev;
        tradingCalendarStore.__resetForTest();
    }
});

test('指标历史序列为倒序（最新在前）且数值 0-100', async () => {
    const result = await computeJq(makeClient(), makeCache(), makeLimitCache());
    for (const ind of result.indicators) {
        assert.ok(ind.score >= 0 && ind.score <= 100, `${ind.key} score 越界: ${ind.score}`);
        assert.equal(ind.history.scores.length, ind.history.dates.length, `${ind.key} 历史序列长度不一致`);
        for (const s of ind.history.scores) {
            assert.ok(s >= 0 && s <= 100, `${ind.key} 历史分数越界: ${s}`);
        }
    }
});
