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
test('同周期并集、去重、有限加分、单选和方法顺序无关；完整候选融合后才截断', () => {
    const batch = evaluate();
    const candidates: Candidate[] = batch.stocks;
    const single = combine(candidates, ['trend_following'], 15);
    assert.equal(single[0].compositeScore, 100);
    const multi = combine(candidates, ['trend_following', 'pullback_stabilization'], 15);
    assert.deepEqual(single, multi);
    const fusion = combine(candidates, ['volume_breakout', 'momentum_continuation'], 15);
    assert.equal(fusion.length, 6);
    assert.equal(new Set(fusion.map(s => s.symbol)).size, 6);
    assert.deepEqual(fusion, combine(candidates, ['momentum_continuation', 'volume_breakout'], 15));
    const both = combine(candidates, ['momentum_continuation', 'trend_following'], 15);
    assert.equal(both[0].compositeScore, 110);
    assert.equal(both[0].matchedTags.length, 2);
    assert.ok(both[0].riskTip.includes('收盘价成交'));
    assert.equal(combine(candidates, ['pullback_stabilization'], 15).length, 0);
});
test('接口参数拒绝跨周期、未知方法、数组、无效日期和错误条数', () => {
    const valid = { horizon: 'short', methods: 'momentum_continuation,volume_breakout,volume_breakout' };
    assert.equal(parseQuery(valid).methods.length, 2);
    for (const q of [ { ...valid, methods: 'trend_following' }, { ...valid, methods: 'event_catalyst' }, { ...valid, methods: ['volume_breakout'] },
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
    const query = parseQuery({ horizon: 'swing', methods: 'trend_following,pullback_stabilization' });
    const result = await service.results(query);
    assert.equal(result.status, 'ready');
    assert.equal(result.stocks.length, 15);
    assert.equal(result.candidateCount, 1000);
    assert.equal(store.current!.batch!.stocks.length, 1000);
    assert.equal(reads, 90);
    await service.generate();
    assert.equal(reads, 90);
    store.current!.tradeDate = '2020-01-01';
    assert.equal((await service.results(query)).status, 'stale');
    assert.deepEqual((await service.results(query)).stocks, []);
    store.current!.tradeDate = dates[89]; store.current!.status = 'failed';
    assert.deepEqual((await service.results(query)).stocks, []);
    store.days.clear();
    source.day = async date => ({ date, fetchedAt: '', bars: {} });
    await assert.rejects(service.generate(), /覆盖不足/);
    assert.equal(store.current!.status, 'failed');
});

test('读取使用独立交易日期依赖，历史窗口不可用不阻断已保存结果；无缺失的空名单不是数据不可用', async () => {
    const store = new MemoryStore();
    const batch = evaluate();
    store.current = { id: '1', tradeDate: dates[89], status: 'ready', generatedAt: null, dataAsOf: dates[89], batch };
    const source: SelectionSource = {
        context: () => { throw new Error('90日历史未就绪'); }, latestTradeDate: () => dates[89],
        stocks: async () => [], day: async () => { throw new Error('读接口不采集行情'); }, benchmark: async () => [],
    };
    const service = new SelectionService(store, source);
    assert.equal((await service.results(parseQuery({ horizon: 'swing', methods: 'trend_following' }))).stocks.length, 6);
    batch.stocks = []; batch.methodStats.trend_following = { pass: 0, fail: 0, unavailable: 0, notApplicable: stocks.length };
    const empty = await service.results(parseQuery({ horizon: 'swing', methods: 'trend_following' }));
    assert.equal(empty.status, 'ready'); assert.deepEqual(empty.stocks, []);
});
