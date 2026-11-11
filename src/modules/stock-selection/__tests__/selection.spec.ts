import { addEarningsRevisions, addEventCatalysts } from '../announcementRules';
import { addDividendMethod } from '../dividendRules';
import { addFinancialMethods } from '../financialRules';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustBars, combine, evaluateMarket } from '../rules';
import { parseQuery, SelectionService, SelectionSource } from '../SelectionService';
import { Run, SelectionStore } from '../SelectionStore';
import { Bar, Batch, Candidate, MarketDay, METHODS, Stock } from '../types';

const dates = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10));
const bars = (): Bar[] => dates.map((date, i) => ({ date, close: 50 + i * 0.6, open: 49.9 + i * 0.6, high: 50.5 + i * 0.6,
    low: 49.5 + i * 0.6, volume: 10_000_000, amount: 100_000_000, factor: 1, changePct: 1 }));
const stocks: Stock[] = Array.from({ length: 6 }, (_, i) => ({ symbol: `60000${i}`, name: `样本${i}`, industry: '测试行业', listDate: '20200101' }));
const benchmark = bars().map(b => ({ ...b, open: 100, high: 101, low: 99, close: 100 }));
function evaluate(first = bars()) {
    return evaluateMarket(stocks, new Map(stocks.map((s, i) => [s.symbol, i === 0 ? first : bars()])), dates, benchmark);
}
test('趋势和强势延续独立筛选，并保留真实指标与行业覆盖', () => {
    const batch = evaluate();
    const signals = batch.stocks[0].signals;
    assert.ok(signals.some(s => s.method === 'trend_following'));
    assert.ok(signals.some(s => s.method === 'momentum_continuation'));
    assert.ok(!signals.some(s => s.method === 'volume_breakout'));
    assert.equal(signals.find(s => s.method === 'momentum_continuation')!.metrics.industryPeerCount, 6);
    for (const m of METHODS) assert.equal(Object.values(batch.methodStats[m]).reduce((a, b) => a + b), stocks.length);
});
test('行业强势要求上涨扩散和持续性，覆盖不足独立标记', () => {
    const signal = evaluate().stocks[0].signals.find(s => s.method === 'industry_strength');
    assert.ok(signal);
    assert.equal(signal.metrics.breadth, 1);
    assert.equal(signal.metrics.strongWeeks, 4);
    const flat = bars().map(b => ({ ...b, open: 100, high: 101, low: 99, close: 100 }));
    const narrow = evaluateMarket(stocks, new Map(stocks.map((s, i) => [s.symbol, i < 2 ? bars() : flat])), dates, benchmark);
    assert.equal(narrow.methodStats.industry_strength.pass, 0);
    assert.equal(narrow.methodStats.industry_strength.fail, 6);
    const missing = evaluateMarket(stocks, new Map(stocks.slice(0, 4).map(s => [s.symbol, bars()])), dates, benchmark);
    assert.equal(missing.methodStats.industry_strength.unavailable, 6);
});
test('涨停打板用实际涨停价确认非一字封板，缺价格不可判定', () => {
    const history = bars();
    const close = history[89].close;
    const raw = new Map(stocks.map(stock => [stock.symbol, bars()]));
    const prices = new Map(stocks.slice(0, 5).map(stock => [stock.symbol, close + 1]));
    prices.set(stocks[0].symbol, close);
    prices.set(stocks[1].symbol, close);
    Object.assign(raw.get(stocks[1].symbol)![89], { low: close, high: close, open: close });
    const batch = evaluateMarket(stocks, raw, dates, benchmark, prices);
    assert.deepEqual(batch.stocks.filter(stock => stock.signals.some(signal => signal.method === 'limit_up_breakout')).map(stock => stock.symbol), [stocks[0].symbol]);
    assert.deepEqual(batch.methodStats.limit_up_breakout, { pass: 1, fail: 4, unavailable: 1, notApplicable: 0 });
});
test('成长方法按披露日取数，估值条件独立且可同类融合', () => {
    const history = bars();
    const raw = new Map(stocks.map(stock => [stock.symbol, history]));
    const financials = new Map(stocks.map(stock => [stock.symbol, [2023, 2024, 2025].map((year, i) => ({
        year, disclosed: `${year + 1}-04-15`, revenue: 100 + i * 20, profit: 15 + i * 4,
        operatingCash: 20 + i * 4, assets: 150, liabilities: 50, equity: 100,
    }))]));
    financials.get(stocks[5].symbol)![2].disclosed = '2026-12-01';
    const valuations = new Map(stocks.map((stock, i) => [stock.symbol, i === 0 ? 40 : 15]));
    const batch = evaluate();
    addFinancialMethods(batch, stocks, raw, dates, financials, valuations);
    assert.deepEqual(batch.methodStats.quality_growth, { pass: 5, fail: 0, unavailable: 1, notApplicable: 0 });
    assert.deepEqual(batch.methodStats.garp, { pass: 4, fail: 1, unavailable: 1, notApplicable: 0 });
    const fused = combine(batch.stocks, parseQuery({ horizon: 'long', methods: 'quality_growth,garp' }).methods, 15);
    assert.equal(fused.length, 4);
    assert.equal(fused[0].matchedMethods.length, 2);
    assert.ok(!fused.some(row => row.symbol === stocks[0].symbol));
    const missingValuation = evaluate();
    addFinancialMethods(missingValuation, stocks, raw, dates, financials);
    assert.equal(missingValuation.methodStats.quality_growth.pass, 5);
    assert.equal(missingValuation.methodStats.garp.unavailable, 6);
    assert.throws(() => parseQuery({ horizon: 'long', methods: 'garp,industry_strength' }));
});
test('盈利预期上修仅比较同机构同预测年度，矛盾报告不计入', () => {
    const stock = stocks[0];
    const raw = new Map([[stock.symbol, bars()]]);
    const reports = ['甲', '乙'].flatMap(institution => [
        { symbol: stock.symbol, reportDate: dates[60], institution, year: 2027, profit: 100 },
        { symbol: stock.symbol, reportDate: dates[80], institution, year: 2027, profit: 110 },
        { symbol: stock.symbol, reportDate: dates[89], institution, year: 2027, profit: 5 },
    ]);
    const batch = evaluate();
    addEarningsRevisions(batch, stocks, raw, dates, reports);
    assert.equal(batch.methodStats.earnings_revision.pass, 1);
    const conflict = evaluate();
    addEarningsRevisions(conflict, stocks, raw, dates, [...reports, { ...reports[1], profit: 90 }]);
    assert.equal(conflict.methodStats.earnings_revision.pass, 0);
});

test('事件催化要求首发利好和公告后量价，后续修正使旧事件失效', () => {
    const symbol = stocks[0].symbol;
    const history = bars();
    Object.assign(history[89], { close: 108, open: 103, high: 109, low: 103, amount: 180_000_000 });
    const raw = new Map([[symbol, history]]);
    const event = { symbol, announced: dates[87], firstAnnouncement: dates[87], period: '2026-12-31', type: '预增', growth: 45, profit: 100 };
    const batch = evaluate();
    addEventCatalysts(batch, stocks, raw, dates, [event, event]);
    assert.equal(batch.methodStats.event_catalyst.pass, 1);
    const revised = evaluate();
    addEventCatalysts(revised, stocks, raw, dates, [event, { ...event, announced: dates[88], type: '预减' }]);
    assert.equal(revised.methodStats.event_catalyst.pass, 0);
});

test('红利稳健核对三个财年的实际派息及现金流，数据失败与未连续派息区分', async () => {
    const raw = new Map(stocks.map(stock => [stock.symbol, bars()]));
    const financials = new Map(stocks.map(stock => [stock.symbol, [2023, 2024, 2025].map(year => ({
        year, disclosed: `${year + 1}-04-15`, revenue: 200, profit: 30,
        operatingCash: 40, assets: 150, liabilities: 50, equity: 100,
    }))]));
    const ratios = new Map(stocks.map(stock => [stock.symbol, { pe: 10, dividendYield: 4 }]));
    const payments = [2023, 2024, 2025].map(year => ({ year, exDate: `${year + 1}-06-01`, cash: 15 }));
    const batch = evaluate();
    await addDividendMethod(batch, stocks, raw, dates, financials, ratios, async () => new Map([
        [stocks[0].symbol, payments],
        [stocks[1].symbol, payments.slice(1)],
        [stocks[2].symbol, [{ ...payments[0], cash: 40 }, ...payments.slice(1)]],
    ]));
    assert.deepEqual(batch.methodStats.stable_dividend, { pass: 1, fail: 2, unavailable: 3, notApplicable: 0 });
    assert.deepEqual(combine(batch.stocks, ['stable_dividend'], 15).map(row => row.symbol), [stocks[0].symbol]);
});
test('突破区间和均量不含当日；未放量不入选', () => {
    const input = bars();
    const last = input[89];
    Object.assign(last, { close: 107, open: 104, high: 107.3, low: 103.8, volume: 20_000_000 });
    const signal = evaluate(input).stocks[0].signals.find(s => s.method === 'volume_breakout');
    assert.ok(signal);
    assert.equal(signal.metrics.priorHigh20, 103.3);
    assert.equal(signal.metrics.volumeRatio, 2);
    last.volume = 10_000_000;
    assert.ok(!evaluate(input).stocks[0].signals.some(s => s.method === 'volume_breakout'));
});
test('回踩必须有缩量支撑和当日转强；靠近均线本身不能入选', () => {
    const input = bars().map((b, i) => ({ ...b, close: 50 + i * .3, open: 49.9 + i * .3, high: 50.4 + i * .3, low: 49.6 + i * .3 }));
    Object.assign(input[81], { close: 79, open: 78, high: 80, low: 77.8 });
    for (let i = 84; i < 89; i++) Object.assign(input[i], { close: 75, open: 75.1, high: 75.5, low: 74, volume: 6_000_000 });
    Object.assign(input[89], { close: 77, open: 75, high: 77.4, low: 74.8 });
    assert.ok(evaluate(input).stocks[0].signals.some(s => s.method === 'pullback_stabilization'));
    Object.assign(input[89], { close: 75.2, high: 75.4 });
    assert.ok(!evaluate(input).stocks[0]?.signals.some(s => s.method === 'pullback_stabilization'));
});
test('前复权消除拆股假跳变，量能统一至信号日股本口径', () => {
    const raw = bars();
    const anchorClose = raw[89].close;
    for (let i = 0; i < 45; i++) {
        for (const key of ['open', 'high', 'low', 'close'] as const) raw[i][key] *= 2;
        raw[i].volume /= 2;
    }
    for (let i = 45; i < 90; i++) raw[i].factor = 2;
    const adjusted = adjustBars(raw, dates)!;
    assert.equal(adjusted[0].close, 50);
    assert.equal(adjusted[0].volume, 10_000_000);
    assert.equal(adjusted[89].close, anchorClose);
    raw[10].factor = Number.NaN;
    assert.equal(adjustBars(raw, dates), null);
});
test('停牌缺日、ST、缺行业、过热和缺基准分别处理，未来行情不会进入计算', () => {
    const missing = bars().filter((_, i) => i !== 80);
    assert.equal(evaluate(missing).methodStats.trend_following.unavailable, 1);
    const universe = stocks.map((s, i) => ({ ...s, name: i === 0 ? '*ST样本' : s.name, industry: '' }));
    const batch = evaluateMarket(universe, new Map(stocks.map(s => [s.symbol, bars()])), dates, benchmark);
    assert.equal(batch.methodStats.trend_following.notApplicable, 1);
    assert.equal(batch.methodStats.momentum_continuation.unavailable, 5);
    const future = [...bars(), { ...bars()[89], date: '2099-01-01', close: 100000 }];
    assert.deepEqual(evaluate(future), evaluate());
    assert.throws(() => evaluateMarket(stocks, new Map(), dates, benchmark.slice(1)), /基准/);
    const hot = bars();
    Object.assign(hot[89], { open: 150, close: 160, high: 161, low: 149 });
    assert.ok(!evaluate(hot).stocks.find(s => s.symbol === stocks[0].symbol));
});
test('同周期交集、去重、有限加分、单选和方法顺序无关；完整候选融合后才截断', () => {
    const batch = evaluate();
    const candidates: Candidate[] = batch.stocks;
    const single = combine(candidates, ['trend_following'], 15);
    assert.equal(single[0].compositeScore, 100);
    const multi = combine(candidates, ['trend_following', 'pullback_stabilization'], 15);
    assert.deepEqual(multi, []);
    const fusion = combine(candidates, ['volume_breakout', 'momentum_continuation'], 15);
    assert.equal(fusion.length, 0);
    assert.deepEqual(fusion, combine(candidates, ['momentum_continuation', 'volume_breakout'], 15));
    const both = combine(candidates, ['momentum_continuation', 'trend_following'], 15);
    assert.deepEqual(both, combine(candidates, ['trend_following', 'momentum_continuation', 'trend_following'], 15));
    assert.equal(both[0].compositeScore, 110);
    assert.equal(both[0].matchedTags.length, 2);
    assert.ok(both[0].riskTip.includes('收盘价成交'));
    assert.equal(combine(candidates, ['pullback_stabilization'], 15).length, 0);
});
test('接口参数拒绝跨周期、未知方法、数组、无效日期和错误条数', () => {
    const valid = { horizon: 'short', methods: 'momentum_continuation,volume_breakout,volume_breakout' };
    assert.equal(parseQuery(valid).methods.length, 2);
    for (const q of [ { ...valid, methods: 'trend_following' }, { ...valid, methods: 'unknown_method' }, { ...valid, methods: ['volume_breakout'] },
        { ...valid, limit: 50 }, { ...valid, date: '2026-02-30' }, { ...valid, mode: 'all' } ]) assert.throws(() => parseQuery(q));
});

class MemoryStore implements SelectionStore {
    current: Run | null = null;
    days = new Map<string, MarketDay>();
    async ensureSchema() {}
    async snapshot(date: string) { return this.days.get(date) || null; }
    async saveSnapshot(day: MarketDay) { this.days.set(day.date, day); }
    async latest() { return this.current; }
    async run(date: string, build: () => Promise<Batch>) {
        this.current = { id: '1', tradeDate: date, status: 'generating', generatedAt: null, dataAsOf: date, batch: null };
        try { this.current.batch = await build(); this.current.status = 'ready'; }
        catch (e) { this.current.status = 'failed'; throw e; }
        return { status: this.current.status };
    }
}
test('批量生成→持久化→单/多选读取；失败和过期不泄露旧结果，快照复用', async () => {
    const store = new MemoryStore();
    const universe = Array.from({ length: 1000 }, (_, i) => ({ ...stocks[0], symbol: String(600000 + i) }));
    let reads = 0;
    const source: SelectionSource = {
        context: () => ({ tradeDate: dates[89], dates }), stocks: async () => universe,
        benchmark: async () => benchmark,
        day: async date => { reads++; return { date, fetchedAt: new Date().toISOString(), bars: Object.fromEntries(universe.map(s => [s.symbol, bars()[dates.indexOf(date)]])) }; },
    };
    const service = new SelectionService(store, source);
    await service.generate();
    const query = parseQuery({ horizon: 'swing', methods: 'trend_following' });
    const result = await service.results(query);
    assert.equal(result.status, 'ready');
    assert.equal(result.stocks.length, 15);
    assert.equal(result.candidateCount, 1000);
    const intersection = await service.results(parseQuery({ horizon: 'swing', methods: 'trend_following,pullback_stabilization' }));
    assert.equal(intersection.status, 'ready');
    assert.equal(intersection.candidateCount, 0);
    assert.deepEqual(intersection.stocks, []);
    assert.equal(store.current!.batch!.stocks.length, 1000);
    assert.equal(reads, 90);
    await service.generate();
    assert.equal(reads, 90);
    store.current!.tradeDate = '2020-01-01';
    assert.equal((await service.results(query)).status, 'ready');
    assert.equal((await service.results(query)).tradeDate, '2020-01-01');
    assert.equal((await service.results({ ...query, date: dates[89] })).status, 'stale');
    store.current!.tradeDate = dates[89]; store.current!.status = 'failed';
    assert.deepEqual((await service.results(query)).stocks, []);
    store.days.clear();
    source.day = async date => ({ date, fetchedAt: '', bars: {} });
    await assert.rejects(service.generate(), /覆盖不足/);
    assert.equal(store.current!.status, 'failed');
});

test('读取不依赖交易日历，历史窗口不可用不阻断已保存结果；无缺失的空名单不是数据不可用', async () => {
    const store = new MemoryStore();
    const batch = evaluate();
    store.current = { id: '1', tradeDate: dates[89], status: 'ready', generatedAt: null, dataAsOf: dates[89], batch };
    const source: SelectionSource = {
        context: () => { throw new Error('90日历史未就绪'); },
        stocks: async () => [], day: async () => { throw new Error('读接口不采集行情'); }, benchmark: async () => [],
    };
    const service = new SelectionService(store, source);
    assert.equal((await service.results(parseQuery({ horizon: 'swing', methods: 'trend_following' }))).stocks.length, 6);
    const legacyStats: Partial<Batch['methodStats']> = batch.methodStats;
    delete legacyStats.industry_strength;
    store.current.ruleVersion = 'after-close.v1';
    const unsupported = await service.results(parseQuery({ horizon: 'swing', methods: 'industry_strength' }));
    assert.equal(unsupported.status, 'unavailable');
    assert.equal(unsupported.ruleVersion, 'after-close.v1');
    batch.stocks = []; batch.methodStats.trend_following = { pass: 0, fail: 0, unavailable: 0, notApplicable: stocks.length };
    const empty = await service.results(parseQuery({ horizon: 'swing', methods: 'trend_following' }));
    assert.equal(empty.status, 'ready'); assert.deepEqual(empty.stocks, []);
});

test('连续入选以有效名单的前15只为准，断档重置并按复权因子计算', async () => {
    const batch = evaluate();
    const store = Object.assign(new MemoryStore(), {
        async previousPublished(before: string) {
            return [
                { tradeDate: dates[88], batch: { ...batch, stocks: batch.stocks.slice(1) } },
                { tradeDate: dates[87], batch },
            ].filter(day => day.tradeDate < before);
        },
    });
    store.current = { id: '1', tradeDate: dates[89], status: 'ready', generatedAt: null, dataAsOf: dates[89], batch };
    for (const index of [87, 89]) {
        const date = dates[index];
        store.days.set(date, { date, fetchedAt: date, bars: Object.fromEntries(stocks.map(stock => [
            stock.symbol, { ...bars()[index], close: index === 87 ? 100 : 55, factor: index === 87 ? 1 : 2 },
        ])) });
    }
    const service = new SelectionService(store, {
        context: () => { throw new Error('读取不需要日历'); },
        stocks: async () => [], day: async () => { throw new Error('读取不采集行情'); }, benchmark: async () => [],
    });
    const result = await service.results(parseQuery({ horizon: 'swing', methods: 'trend_following' }));
    const entry = (symbol: string) => result.stocks.find(stock => stock.symbol === symbol)?.entry;
    assert.equal(entry(stocks[0].symbol)?.sessions, 1);
    assert.equal(entry(stocks[0].symbol)?.closeReturn, 0);
    assert.equal(entry(stocks[1].symbol)?.sessions, 3);
    assert.equal(entry(stocks[1].symbol)?.date, dates[87]);
    assert.ok(Math.abs(entry(stocks[1].symbol)!.closeReturn! - 10) < 1e-9);
});
