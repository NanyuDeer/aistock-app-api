import { combine, evaluateMarket } from './rules';
import { SelectionStore } from './SelectionStore';
import { Bar, Batch, FUSION_VERSION, HISTORY_DAYS, Horizon, MarketDay, Method, METHODS, METHOD_HORIZONS, RULE_VERSION, Stock } from './types';

export interface SelectionSource {
    /** Validated authoritative calendar, ascending dates, ending at the latest fully closed session. */
    context(): { tradeDate: string; dates: string[] };
    /** Read path only needs the latest closed session, not the full feature-generation window. */
    latestTradeDate?(): string;
    stocks(): Promise<Stock[]>;
    day(date: string): Promise<MarketDay>;
    benchmark(start: string, end: string): Promise<Bar[]>;
}
export interface SelectionQuery { horizon: Horizon; methods: Method[]; limit: number; date?: string }
export function parseQuery(query: Record<string, unknown>): SelectionQuery {
    if (query.horizon !== 'short' && query.horizon !== 'swing') throw new Error('horizon必须为short或swing');
    if (typeof query.methods !== 'string' || !query.methods.trim()) throw new Error('请选择methods');
    const methods = [...new Set(query.methods.split(',').map(v => v.trim()))];
    if (methods.some(m => !METHODS.includes(m as Method))) throw new Error('包含未上线或无效的方法');
    if (methods.some(m => METHOD_HORIZONS[m as Method] !== query.horizon)) throw new Error('只允许同一大类内多选');
    if (query.mode !== undefined && query.mode !== 'blend') throw new Error('目前仅支持blend模式');
    const limit = query.limit === undefined ? 15 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 10 || limit > 15) throw new Error('limit必须为10到15的整数');
    let date: string | undefined;
    if (query.date !== undefined) {
        const parsed = typeof query.date === 'string' ? new Date(`${query.date}T00:00:00Z`) : new Date(Number.NaN);
        if (typeof query.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(query.date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== query.date) throw new Error('date必须为有效的YYYY-MM-DD');
        date = query.date;
    }
    return { horizon: query.horizon, methods: (methods as Method[]).sort(), limit, date };
}

export class SelectionService {
    constructor(private store: SelectionStore, private source: SelectionSource) {}
    async generate() {
        const context = this.source.context();
        return this.store.run(context.tradeDate, () => this.build(context));
    }
    private async build(context: { tradeDate: string; dates: string[] }): Promise<Batch> {
        const { tradeDate, dates } = context;
        if (dates.length !== HISTORY_DAYS || dates[dates.length - 1] !== tradeDate) throw new Error('历史窗口不完整');
        const stocks = await this.source.stocks();
        const universeFetchedAt = new Date().toISOString();
        if (stocks.length < 1000 || new Set(stocks.map(s => s.symbol)).size !== stocks.length) throw new Error('全市场股票范围不完整或存在重复代码');
        const raw = new Map<string, Bar[]>();
        const snapshots: Array<{ date: string; fetchedAt: string }> = [];
        for (const date of dates) {
            let day = await this.store.snapshot(date);
            if (!day) {
                day = await this.source.day(date);
                const expected = stocks.filter(s => s.listDate && s.listDate <= date.replace(/-/g, '')).length;
                const covered = stocks.filter(s => day!.bars[s.symbol]).length;
                if (day.date !== date || covered < expected * 0.9 || Object.values(day.bars).some(b => b.date !== date)) throw new Error(`${date}行情或复权因子覆盖不足90%`);
                await this.store.saveSnapshot(day);
            }
            snapshots.push({ date, fetchedAt: day.fetchedAt });
            for (const stock of stocks) {
                const b = day.bars[stock.symbol];
                if (b) { const rows = raw.get(stock.symbol) || []; rows.push(b); raw.set(stock.symbol, rows); }
            }
        }
        const benchmark = await this.source.benchmark(dates[0], tradeDate);
        const batch = evaluateMarket(stocks, raw, dates, benchmark);
        batch.inputs = { provider: 'Tushare daily+adj_factor+stock_basic+index_daily', adjustment: 'signal-date-qfq;volume-adjusted',
            benchmark: '000300.SH', universeFetchedAt, universe: stocks,
            benchmarkCloses: benchmark.filter(b => dates.includes(b.date)).map(b => ({ date: b.date, close: b.close })), snapshots };
        const usable = batch.methodStats.trend_following;
        const applicable = usable.pass + usable.fail + usable.unavailable;
        if (!applicable || usable.unavailable / applicable > 0.2) throw new Error('连续历史数据覆盖不足80%，本次不发布');
        return batch;
    }
    async results(query: SelectionQuery) {
        const expectedDate = query.date || (this.source.latestTradeDate ? this.source.latestTradeDate() : this.source.context().tradeDate);
        await this.store.ensureSchema();
        const run = await this.store.latest(query.date);
        const base = { horizon: query.horizon, methods: query.methods, mode: 'blend', ruleVersion: RULE_VERSION, fusionVersion: FUSION_VERSION,
            expectedTradeDate: expectedDate, tradeDate: run?.tradeDate || null, runId: run?.id || null,
            dataAsOf: run?.dataAsOf || null, generatedAt: run?.generatedAt || null, candidateCount: 0,
            summary: '符合任一所选方法即可入选，综合表现优先。盘后确认，非实时买点。',
            methodStats: run?.batch?.methodStats || null };
        if (!run) return { ...base, status: 'empty', stocks: [] };
        if (run.tradeDate !== expectedDate) return { ...base, status: 'stale', stocks: [] };
        if (run.status !== 'ready' || !run.batch) return { ...base, status: run.status, stocks: [] };
        const unavailable = query.methods.filter(m => {
            const s = run.batch!.methodStats[m];
            const evaluated = s.pass + s.fail;
            return s.unavailable > 0 && evaluated / (evaluated + s.unavailable) < 0.8;
        });
        if (unavailable.length) return { ...base, status: 'unavailable', unavailableMethods: unavailable, stocks: [] };
        return { ...base, status: 'ready', candidateCount: run.batch.stocks.filter(c => c.signals.some(s => query.methods.includes(s.method))).length,
            stocks: combine(run.batch.stocks, query.methods, query.limit) };
    }
}
