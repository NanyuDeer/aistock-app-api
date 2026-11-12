import { addEarningsRevisions, addEventCatalysts } from '../announcementRules';
import { addDividendMethod } from '../dividendRules';
import { addFinancialMethods } from '../financialRules';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustBars, combine, evaluateMarket } from '../rules';
import { parseQuery, SelectionService, SelectionSource } from '../SelectionService';
import { RefreshInputs, Run, SelectionStore } from '../SelectionStore';
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
    // Six valid peers out of eight members is 75% coverage: momentum peers are unavailable, not a thin average.
    const extra = [...stocks, ...['600010', '600011'].map(symbol => ({ ...stocks[0], symbol }))];
    const thin = evaluateMarket(extra, new Map(stocks.map(s => [s.symbol, bars()])), dates, benchmark);
    assert.deepEqual(thin.methodStats.momentum_continuation, { pass: 0, fail: 0, unavailable: 8, notApplicable: 0 });
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
    const emptyValuation = evaluate();
    addFinancialMethods(emptyValuation, stocks, raw, dates, financials, new Map());
    assert.deepEqual(emptyValuation.methodStats.garp, { pass: 0, fail: 0, unavailable: 6, notApplicable: 0 });
    const lossMaking = evaluate();
    addFinancialMethods(lossMaking, stocks, raw, dates, financials, new Map(stocks.map((stock, i) => [stock.symbol, i === 1 ? null : 15])));
    assert.deepEqual(lossMaking.methodStats.garp, { pass: 4, fail: 1, unavailable: 1, notApplicable: 0 });
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

    // A conflict on a date outside the compared pair still excludes the institution.
    const staleConflict = evaluate();
    addEarningsRevisions(staleConflict, stocks, raw, dates, [...reports,
        { symbol: stock.symbol, reportDate: dates[40], institution: '甲', year: 2027, profit: 80 },
        { symbol: stock.symbol, reportDate: dates[40], institution: '甲', year: 2027, profit: 81 }]);
    assert.deepEqual(staleConflict.methodStats.earnings_revision, { pass: 0, fail: 0, unavailable: 0, notApplicable: 6 });

    // 100 → 120 → 110 inside the window: the latest adjustment is a cut of 8.3%, not a rise of 10% versus 20 days ago.
    const reversal = evaluate();
    addEarningsRevisions(reversal, stocks, raw, dates, ['甲', '乙'].flatMap(institution => [
        { symbol: stock.symbol, reportDate: dates[60], institution, year: 2027, profit: 100 },
        { symbol: stock.symbol, reportDate: dates[75], institution, year: 2027, profit: 120 },
        { symbol: stock.symbol, reportDate: dates[85], institution, year: 2027, profit: 110 },
    ]));
    assert.equal(reversal.methodStats.earnings_revision.pass, 0);
    assert.equal(reversal.methodStats.earnings_revision.fail, 1);
    const recent = evaluate();
    addEarningsRevisions(recent, stocks, raw, dates, ['甲', '乙'].flatMap(institution => [
        { symbol: stock.symbol, reportDate: dates[75], institution, year: 2027, profit: 100 },
        { symbol: stock.symbol, reportDate: dates[85], institution, year: 2027, profit: 110 },
    ]));
    assert.equal(recent.methodStats.earnings_revision.pass, 1);
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

    // A revision of another period must not override this period's qualifying first announcement.
    const otherPeriod = evaluate();
    addEventCatalysts(otherPeriod, stocks, raw, dates, [event,
        { ...event, announced: dates[88], period: '2026-09-30', firstAnnouncement: dates[70], type: '预减', growth: -40 }]);
    assert.equal(otherPeriod.methodStats.event_catalyst.pass, 1);

    // Pre-market release: +18% on the announcement day then +3%. The full reaction exceeds the 15% cap.
    const jumped = bars();
    Object.assign(jumped[87], { open: 118, high: 121, low: 117, close: 120, amount: 300_000_000 });
    Object.assign(jumped[88], { open: 120, high: 122, low: 119, close: 121 });
    Object.assign(jumped[89], { open: 122, high: 124.5, low: 121, close: 123.6, amount: 180_000_000 });
    const gapped = evaluate();
    addEventCatalysts(gapped, stocks, new Map([[symbol, jumped]]), dates, [event]);
    assert.deepEqual(gapped.methodStats.event_catalyst, { pass: 0, fail: 1, unavailable: 0, notApplicable: 5 });

    // Two first announcements: the newer lacks post-announcement turnover, the older confirms and triggers.
    const twoReports = bars();
    Object.assign(twoReports[88], { amount: 180_000_000 });
    Object.assign(twoReports[89], { close: 108, open: 103, high: 109, low: 103 });
    const both = evaluate();
    addEventCatalysts(both, stocks, new Map([[symbol, twoReports]]), dates,
        [event, { ...event, announced: dates[88], firstAnnouncement: dates[88], period: '2026-09-30' }]);
    assert.equal(both.methodStats.event_catalyst.pass, 1);
    assert.equal(both.stocks.find(stock => stock.symbol === symbol)!.signals.find(signal => signal.method === 'event_catalyst')!.reason[0].startsWith(dates[87]), true);

    // The newer announcement fails and the older one's window misses a bar: undecidable, not a failure.
    const holed = bars().filter((_, i) => i !== 67);
    const partial = evaluate();
    addEventCatalysts(partial, stocks, new Map([[symbol, holed]]), dates,
        [event, { ...event, announced: dates[88], firstAnnouncement: dates[88], period: '2026-09-30' }]);
    assert.deepEqual(partial.methodStats.event_catalyst, { pass: 0, fail: 0, unavailable: 1, notApplicable: 5 });

    // Likewise when the qualifying announcement fails but another period has conflicting same-day records.
    const contested = evaluate();
    addEventCatalysts(contested, stocks, new Map([[symbol, bars()]]), dates,
        [event, { ...event, period: '2026-09-30' }, { ...event, period: '2026-09-30', growth: 10 }]);
    assert.deepEqual(contested.methodStats.event_catalyst, { pass: 0, fail: 0, unavailable: 1, notApplicable: 5 });
});

test('红利稳健核对三个财年的实际派息及现金流，数据失败与未连续派息区分', async () => {
    const raw = new Map(stocks.map(stock => [stock.symbol, bars()]));
    const financials = new Map(stocks.map(stock => [stock.symbol, [2022, 2023, 2024, 2025].map(year => ({
        year, disclosed: `${year + 1}-04-15`, revenue: 200, profit: 30,
        operatingCash: 40, assets: 150, liabilities: 50, equity: 100,
    }))]));
    // Stock 3 has a high TTM yield from a one-off payout outside the window; its FY yield is 1% versus 3%.
    const ratios = new Map(stocks.map((stock, i) => [stock.symbol, { pe: 10, dividendYield: i === 3 ? 9 : 4, marketCap: i === 3 ? 1500 : 500 }]));
    // Signal date 2026-08-29 precedes the Sept 1 switch, so FY2025 final dividends are not yet required.
    const payments = [2022, 2023, 2024].map(year => ({ year, exDate: `${year + 1}-06-01`, cash: 15 }));
    const batch = evaluate();
    await addDividendMethod(batch, stocks, raw, dates, financials, ratios, async () => new Map([
        [stocks[0].symbol, payments], [stocks[3].symbol, payments], [stocks[4].symbol, payments],
        [stocks[1].symbol, payments.slice(1)],
        [stocks[2].symbol, [{ ...payments[0], cash: 40 }, ...payments.slice(1)]],
    ]));
    assert.deepEqual(batch.methodStats.stable_dividend, { pass: 3, fail: 2, unavailable: 1, notApplicable: 0 });
    assert.deepEqual(combine(batch.stocks, ['stable_dividend'], 15).map(row => row.symbol), [0, 4, 3].map(i => stocks[i].symbol));
    const metrics = batch.stocks[0].signals.find(signal => signal.method === 'stable_dividend')!.metrics;
    assert.equal(metrics.fiscalYear, 2024);
    assert.equal(metrics.fiscalYield, 3);

    const lossMaking = new Map([...ratios].map(([symbol, row], i) => [symbol, i === 0 ? { ...row, pe: null } : row]));
    const loss = evaluate();
    await addDividendMethod(loss, stocks, raw, dates, financials, lossMaking, async () => new Map(stocks.slice(1).map(stock => [stock.symbol, payments])));
    assert.deepEqual(loss.methodStats.stable_dividend, { pass: 5, fail: 1, unavailable: 0, notApplicable: 0 });

    const sparse = evaluate();
    await addDividendMethod(sparse, stocks, raw, dates, financials, ratios, async () => new Map([[stocks[0].symbol, payments]]));
    assert.deepEqual(sparse.methodStats.stable_dividend, { pass: 0, fail: 0, unavailable: 6, notApplicable: 0 });
    assert.ok(!sparse.stocks.some(stock => stock.signals.some(signal => signal.method === 'stable_dividend')));

    const lowYield = new Map(stocks.map((stock, i) => [stock.symbol, { pe: 10, dividendYield: i < 5 ? 1 : 4, marketCap: 500 }]));
    const screened = evaluate();
    await addDividendMethod(screened, stocks, raw, dates, financials, lowYield, async () => new Map([[stocks[5].symbol, payments]]));
    assert.deepEqual(screened.methodStats.stable_dividend, { pass: 1, fail: 5, unavailable: 0, notApplicable: 0 });

    const noRatios = evaluate();
    await addDividendMethod(noRatios, stocks, raw, dates, financials, new Map(), async () => new Map());
    assert.deepEqual(noRatios.methodStats.stable_dividend, { pass: 0, fail: 0, unavailable: 6, notApplicable: 0 });
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
    async run(date: string, build: () => Promise<Batch>, refresh?: RefreshInputs) {
        const ready = this.current?.status === 'ready' && this.current.tradeDate === date ? this.current : null;
        if (ready && !(await refresh?.(ready.batch?.inputs?.snapshots ?? null))) return { status: 'ready' };
        const run: Run = { id: '1', tradeDate: date, status: 'generating', generatedAt: null, dataAsOf: date, batch: null };
        this.current = run;
        try { run.batch = await build(); run.status = 'ready'; }
        catch (e) {
            // Like PostgresSelectionStore.latest(), a failed rebuild leaves the published batch visible.
            run.status = 'failed';
            if (ready) this.current = ready;
            throw e;
        }
        return { status: run.status };
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
    const source: SelectionSource = {
        context: () => { throw new Error('读取不需要日历'); }, previousTradingDate: date => dates[dates.indexOf(date) - 1] ?? null,
        stocks: async () => [], day: async () => { throw new Error('读取不采集行情'); }, benchmark: async () => [],
    };
    const service = new SelectionService(store, source);
    const query = parseQuery({ horizon: 'swing', methods: 'trend_following' });
    const result = await service.results(query);
    const entry = (symbol: string) => result.stocks.find(stock => stock.symbol === symbol)?.entry;
    assert.equal(entry(stocks[0].symbol)?.sessions, 1);
    assert.equal(entry(stocks[0].symbol)?.closeReturn, 0);
    assert.equal(entry(stocks[1].symbol)?.sessions, 3);
    assert.equal(entry(stocks[1].symbol)?.date, dates[87]);
    assert.ok(Math.abs(entry(stocks[1].symbol)!.closeReturn! - 10) < 1e-9);

    // dates[88] has no published batch: the streak stops instead of jumping to dates[87].
    const gapStore = Object.assign(new MemoryStore(), {
        async previousPublished(before: string) { return [{ tradeDate: dates[87], batch }].filter(day => day.tradeDate < before); },
    });
    gapStore.current = store.current;
    gapStore.days = store.days;
    const gap = await new SelectionService(gapStore, source).results(query);
    assert.ok(gap.stocks.every(stock => stock.entry?.sessions === 1));

    // The batch's own window says dates[88] was not a session (holiday), so dates[87] is adjacent.
    const holiday = { ...batch, inputs: { snapshots: [dates[86], dates[87], dates[89]].map(date => ({ date, fetchedAt: date })) } } as unknown as Batch;
    gapStore.current = { ...store.current!, batch: holiday };
    const bridged = await new SelectionService(gapStore, { ...source, previousTradingDate: undefined }).results(query);
    assert.equal(bridged.stocks.find(stock => stock.symbol === stocks[1].symbol)?.entry?.sessions, 2);
});

test('快照缺少未停牌个股时补全并重建已就绪批次；停牌缺口不重抓，跨日快照按倍增间隔重抓，版本落后于已发布批次时持续重算', async () => {
    const store = new MemoryStore();
    const universe = Array.from({ length: 1000 }, (_, i) => ({ ...stocks[0], symbol: String(600000 + i) }));
    const [suspendedSymbol, lateSymbol] = [universe[998].symbol, universe[999].symbol];
    const full = (date: string, close?: number) => {
        const day = Object.fromEntries(universe.map(s => [s.symbol, { ...bars()[dates.indexOf(date)], ...(close ? { close } : {}) }]));
        if (date === last) delete day[suspendedSymbol];
        return day;
    };
    const last = dates[89];
    const partial = full(last);
    delete partial[lateSymbol];
    store.days.set(last, { date: last, fetchedAt: `${last}T08:40:00.000Z`, bars: partial });
    const reads: string[] = [];
    const fetchedAt = `${last}T11:30:00.000Z`;
    const source: SelectionSource = {
        context: () => ({ tradeDate: last, dates }), stocks: async () => universe, benchmark: async () => benchmark,
        suspensions: async () => new Map([[last, new Set([suspendedSymbol])]]),
        day: async date => { reads.push(date); return { date, fetchedAt, bars: full(date, date === last ? 999 : undefined) }; },
    };
    const service = new SelectionService(store, source);
    await service.generate();
    const merged = store.days.get(last)!;
    assert.equal(Object.keys(merged.bars).length, 999);
    assert.equal(merged.bars[universe[0].symbol].close, bars()[89].close);
    assert.equal(merged.bars[lateSymbol].close, 999);
    assert.equal(reads.filter(date => date === last).length, 1);

    // Evening rerun: the only remaining gap is a suspension, so the ready batch is reused without refetching.
    const published = store.current!.batch;
    reads.length = 0;
    await service.generate();
    assert.equal(store.current!.batch, published);
    assert.equal(reads.length, 0);

    // A vendor gap in a final snapshot is refetched, and the new bar rebuilds the ready batch.
    const vendorGap = universe[5].symbol;
    delete store.days.get(dates[50])!.bars[vendorGap];
    await service.generate();
    assert.deepEqual(reads, [dates[50]]);
    assert.notEqual(store.current!.batch, published);
    assert.ok(store.days.get(dates[50])!.bars[vendorGap]);
    assert.equal(store.days.get(dates[50])!.refreshes, 1);

    // Bars filled by a refresh whose rebuild failed still rebuild later, because the batch used an older version.
    const flaky = universe[11].symbol;
    delete store.days.get(dates[55])!.bars[flaky];
    source.suspensions = async () => new Map([[last, new Set([suspendedSymbol])], [dates[55], new Set([flaky])]]);
    await service.generate();
    const stale = store.current!.batch!;
    assert.equal(stale.inputs!.snapshots[55].bars, 999);
    source.suspensions = async () => new Map([[last, new Set([suspendedSymbol])]]);
    source.benchmark = async () => { throw new Error('基准下载失败'); };
    reads.length = 0;
    await assert.rejects(service.generate());
    assert.deepEqual(reads, [dates[55]]);
    assert.ok(store.days.get(dates[55])!.bars[flaky]);
    assert.equal(store.current!.batch, stale);
    source.benchmark = async () => benchmark;
    reads.length = 0;
    await service.generate();
    assert.equal(reads.length, 0);
    assert.notEqual(store.current!.batch, stale);
    assert.equal(store.current!.batch!.inputs!.snapshots[55].bars, 1000);

    // A vendor that keeps omitting a stock is retried at doubling intervals, so a late row is still picked up.
    const missing = universe[7].symbol;
    delete store.days.get(dates[60])!.bars[missing];
    const now = () => new Date().toISOString();
    source.day = async date => { reads.push(date); const day = full(date); delete day[missing]; return { date, fetchedAt: now(), bars: day }; };
    reads.length = 0;
    await service.generate();
    const rebuilt = store.current!.batch;
    for (let i = 0; i < 4; i++) await service.generate();
    assert.deepEqual(reads, [dates[60]]);
    assert.equal(store.current!.batch, rebuilt);
    assert.equal(store.days.get(dates[60])!.refreshes, 1);
    store.days.get(dates[60])!.fetchedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    source.day = async date => { reads.push(date); return { date, fetchedAt: now(), bars: full(date) }; };
    await service.generate();
    assert.deepEqual(reads, [dates[60], dates[60]]);
    assert.ok(store.days.get(dates[60])!.bars[missing]);
    assert.notEqual(store.current!.batch, rebuilt);

    // Without the suspension list final snapshots are still refetched, on the same schedule.
    const unseen = universe[9].symbol;
    delete store.days.get(dates[65])!.bars[unseen];
    source.suspensions = async () => { throw new Error('停牌接口不可用'); };
    reads.length = 0;
    await service.generate();
    assert.ok(reads.includes(dates[65]));
    assert.ok(store.days.get(dates[65])!.bars[unseen]);

    // Refetch failures keep the stored data.
    source.suspensions = async () => new Map([[last, new Set([suspendedSymbol])]]);
    delete store.days.get(dates[70])!.bars[missing];
    const before = store.days.get(dates[70]);
    source.day = async () => { throw new Error('网络中断'); };
    await service.generate();
    assert.equal(store.days.get(dates[70]), before);
});

test('连续入选按请求条数回溯：昨日第12名今日进前10，查询前10名时为首次入选', async () => {
    const universe = Array.from({ length: 20 }, (_, i) => ({ ...stocks[0], symbol: String(600000 + i) }));
    const today = evaluateMarket(universe, new Map(universe.map(s => [s.symbol, bars()])), dates, benchmark);
    const yesterday = structuredClone(today);
    yesterday.stocks.forEach((stock, i) => {
        stock.signals.find(signal => signal.method === 'trend_following')!.rank = i < 3 ? 11 + i : i < 13 ? i - 2 : i + 1;
    });
    const store = Object.assign(new MemoryStore(), {
        async previousPublished(before: string) { return [{ tradeDate: dates[88], batch: yesterday }].filter(day => day.tradeDate < before); },
    });
    store.current = { id: '1', tradeDate: dates[89], status: 'ready', generatedAt: null, dataAsOf: dates[89], batch: today };
    const service = new SelectionService(store, {
        context: () => { throw new Error('读取不需要日历'); }, previousTradingDate: date => dates[dates.indexOf(date) - 1] ?? null,
        stocks: async () => [], day: async () => { throw new Error('读取不采集行情'); }, benchmark: async () => [],
    });
    const sessions = async (limit: string) => Object.fromEntries((await service.results(parseQuery({ horizon: 'swing', methods: 'trend_following', limit })))
        .stocks.map(stock => [stock.symbol, stock.entry?.sessions]));
    const top10 = await sessions('10');
    assert.deepEqual([0, 1, 2, 3, 9].map(i => top10[universe[i].symbol]), [1, 1, 1, 2, 2]);
    const top15 = await sessions('15');
    assert.equal(top15[universe[0].symbol], 2);
});
