import { addDividendMethod, DailyRatios, DividendPayment } from './dividendRules';
import { addEarningsRevisions, addEventCatalysts, CompanyForecast, ResearchForecast } from './announcementRules';
import { addFinancialMethods, AnnualFinancials } from './financialRules';
import { combine, evaluateMarket, matchesAllMethods } from './rules';
import { SelectionStore } from './SelectionStore';
import { Bar, Batch, FUSION_VERSION, HISTORY_DAYS, Horizon, MarketDay, Method, METHODS, METHOD_HORIZONS, RULE_VERSION, Stock } from './types';

export interface SelectionSource {
    /** Validated authoritative calendar, ascending dates, ending at the latest fully closed session. */
    context(): { tradeDate: string; dates: string[] };
    nextTradingDate?(date: string): string | null;
    previousTradingDate?(date: string): string | null;
    stocks(): Promise<Stock[]>;
    day(date: string): Promise<MarketDay>;
    upperLimits?(date: string): Promise<Map<string, number>>;
    financials?(date: string): Promise<Map<string, AnnualFinancials[]>>;
    ratios?(date: string): Promise<Map<string, DailyRatios>>;
    dividends?(date: string, symbols: string[]): Promise<Map<string, DividendPayment[]>>;
    research?(date: string): Promise<ResearchForecast[]>;
    companyForecasts?(start: string, end: string): Promise<CompanyForecast[]>;
    benchmark(start: string, end: string): Promise<Bar[]>;
    /** Suspended symbols per ISO date within the window. */
    suspensions?(start: string, end: string): Promise<Map<string, Set<string>>>;
}
export interface SelectionQuery { horizon: Horizon; methods: Method[]; limit: number; date?: string }
export function parseQuery(query: Record<string, unknown>): SelectionQuery {
    if (query.horizon !== 'short' && query.horizon !== 'swing' && query.horizon !== 'long') throw new Error('horizon必须为short、swing或long');
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

function methodAvailable(batch: Batch, method: Method): boolean {
    const stats = batch.methodStats[method];
    return Boolean(stats && stats.unavailable * 4 <= stats.pass + stats.fail);
}
/** Vendors can add late rows on the trade date itself; only a fetch on a later Shanghai date is final. */
function settled(day: MarketDay): boolean {
    const fetched = Date.parse(day.fetchedAt);
    return Number.isFinite(fetched) && new Date(fetched + 8 * 3600_000).toISOString().slice(0, 10) > day.date;
}

interface Universe {
    stocks: Stock[]; fetchedAt: string;
    /** null when the suspension list is unavailable: suspended stocks then also count as gaps. */
    suspended: Map<string, Set<string>> | null;
    checked: Set<string>;
}
const DAY_MS = 86_400_000;

export class SelectionService {
    constructor(private store: SelectionStore, private source: SelectionSource) {}
    async generate() {
        const context = this.source.context();
        let universe: Promise<Universe> | undefined;
        const load = () => universe ??= this.universe(context.dates);
        return this.store.run(context.tradeDate, async () => this.build(context, await load()), async used => {
            const loaded = await load();
            // Snapshots only gain bars, so the bar count is their version. Any mismatch with what the published
            // batch used means it is stale, including bars filled by an earlier refresh whose rebuild failed.
            const recorded = new Map((used || []).map(snapshot => [snapshot.date, snapshot.bars]));
            let changed = false;
            for (const date of context.dates) {
                const refreshed = await this.marketDay(date, loaded, true);
                const before = recorded.get(date);
                changed = refreshed.changed || (before !== undefined && refreshed.day !== null && Object.keys(refreshed.day.bars).length !== before) || changed;
            }
            return changed;
        });
    }
    private async universe(dates: string[]): Promise<Universe> {
        const stocks = await this.source.stocks();
        if (stocks.length < 1000 || new Set(stocks.map(s => s.symbol)).size !== stocks.length) throw new Error('全市场股票范围不完整或存在重复代码');
        const fetchedAt = new Date().toISOString();
        const suspended = this.source.suspensions
            ? await this.source.suspensions(dates[0], dates[dates.length - 1]).catch(error => {
                console.warn('[StockSelection] 停牌列表读取失败:', error instanceof Error ? error.message : String(error));
                return null;
            })
            : null;
        return { stocks, fetchedAt, suspended, checked: new Set() };
    }
    private async build(context: { tradeDate: string; dates: string[] }, universe: Universe): Promise<Batch> {
        const { tradeDate, dates } = context;
        if (dates.length !== HISTORY_DAYS || dates[dates.length - 1] !== tradeDate) throw new Error('历史窗口不完整');
        const { stocks, fetchedAt: universeFetchedAt } = universe;
        const raw = new Map<string, Bar[]>();
        const snapshots: Array<{ date: string; fetchedAt: string; bars: number }> = [];
        for (const date of dates) {
            const day = (await this.marketDay(date, universe, false)).day!;
            snapshots.push({ date, fetchedAt: day.fetchedAt, bars: Object.keys(day.bars).length });
            for (const stock of stocks) {
                const b = day.bars[stock.symbol];
                if (b) { const rows = raw.get(stock.symbol) || []; rows.push(b); raw.set(stock.symbol, rows); }
            }
        }
        const benchmark = await this.source.benchmark(dates[0], tradeDate);
        const upperLimits = await this.source.upperLimits?.(tradeDate).catch(error => {
            console.warn('[StockSelection] 涨停价读取失败:', error instanceof Error ? error.message : String(error));
            return undefined;
        });
        const batch = evaluateMarket(stocks, raw, dates, benchmark, upperLimits);
        batch.inputs = { provider: upperLimits?.size ? 'Tushare daily+adj_factor+stock_basic+index_daily+stk_limit' : 'Tushare daily+adj_factor+stock_basic+index_daily',
            adjustment: 'signal-date-qfq;volume-adjusted',
            benchmark: '000300.SH', universeFetchedAt, universe: stocks,
            benchmarkCloses: benchmark.filter(b => dates.includes(b.date)).map(b => ({ date: b.date, close: b.close })), snapshots };
        const usable = batch.methodStats.trend_following;
        const applicable = usable.pass + usable.fail + usable.unavailable;
        if (!applicable || usable.unavailable / applicable > 0.2) throw new Error('连续历史数据覆盖不足80%，本次不发布');
        const optional = async <T>(name: string, data: Promise<T> | undefined) => {
            try { return await data; }
            catch (error) { console.warn(`[StockSelection] ${name}读取失败:`, error); return undefined; }
        };
        const [financials, ratios, research, forecasts] = await Promise.all([
            optional('批量年报', this.source.financials?.(tradeDate)),
            optional('日度估值和股息率', this.source.ratios?.(tradeDate)),
            optional('研报预测', this.source.research?.(tradeDate)),
            optional('业绩预告', this.source.companyForecasts?.(dates[dates.length - 4], tradeDate)),
        ]);
        const valuations = ratios && new Map([...ratios].map(([symbol, row]) => [symbol, row.pe]));
        addFinancialMethods(batch, stocks, raw, dates, financials, valuations);
        addEarningsRevisions(batch, stocks, raw, dates, research);
        addEventCatalysts(batch, stocks, raw, dates, forecasts);
        await addDividendMethod(batch, stocks, raw, dates, financials, ratios, this.source.dividends);
        return batch;
    }
    /**
     * A stored snapshot is refetched when a listed stock lacks a bar without being suspended: every generation while
     * the snapshot was taken on its own trade date, afterwards at doubling intervals (1, 2, 4… days since the last
     * fetch) so late vendor rows are still picked up at bounded cost. Stored bars always win.
     */
    private needsRefresh(stored: MarketDay, universe: Universe): boolean {
        const compact = stored.date.replace(/-/g, '');
        const suspended = universe.suspended?.get(stored.date);
        const gap = universe.stocks.some(s => s.listDate && s.listDate <= compact && !stored.bars[s.symbol] && !suspended?.has(s.symbol));
        if (!gap) return false;
        if (!settled(stored)) return true;
        return Date.now() - Date.parse(stored.fetchedAt) >= 2 ** (stored.refreshes ?? 0) * DAY_MS;
    }
    private async marketDay(date: string, universe: Universe, storedOnly: boolean): Promise<{ day: MarketDay | null; changed: boolean }> {
        const stored = await this.store.snapshot(date);
        if (stored ? universe.checked.has(date) || !this.needsRefresh(stored, universe) : storedOnly) return { day: stored, changed: false };
        universe.checked.add(date);
        let fresh: MarketDay;
        try {
            fresh = await this.source.day(date);
            if (fresh.date !== date || Object.values(fresh.bars).some(b => b.date !== date)) throw new Error(`${date}行情日期不一致`);
        } catch (error) {
            if (stored) return { day: stored, changed: false };
            throw error;
        }
        const day: MarketDay = { date, fetchedAt: fresh.fetchedAt, bars: { ...fresh.bars, ...stored?.bars },
            refreshes: stored && settled(stored) ? (stored.refreshes ?? 0) + 1 : stored?.refreshes };
        if (!stored) {
            const expected = universe.stocks.filter(s => s.listDate && s.listDate <= date.replace(/-/g, '')).length;
            if (universe.stocks.filter(s => day.bars[s.symbol]).length < expected * 0.9) throw new Error(`${date}行情或复权因子覆盖不足90%`);
        }
        await this.store.saveSnapshot(day);
        return { day, changed: Boolean(stored) && Object.keys(day.bars).length > Object.keys(stored!.bars).length };
    }
    private previousSession(batch: Batch, date: string): string | null {
        const window = batch.inputs?.snapshots?.map(snapshot => snapshot.date);
        if (window && window.length >= 2 && window[window.length - 1] === date) return window[window.length - 2];
        try { return this.source.previousTradingDate?.(date) ?? null; }
        catch { return null; }
    }
    /** Streaks are measured against the list the caller sees, so the lookback uses the requested limit. */
    private async trackEntries(run: { tradeDate: string; batch: Batch }, methods: Method[], limit: number) {
        const entries = new Map(combine(run.batch.stocks, methods, limit).map(stock => [stock.symbol, {
            date: run.tradeDate, sessions: 1, price: stock.price,
        }]));
        const active = new Set(entries.keys());
        let before = run.tradeDate;
        let expected = this.previousSession(run.batch, run.tradeDate);
        // A missing or unusable batch on the preceding trading day ends every streak; weekends and holidays are not sessions.
        scan: while (active.size && expected && this.store.previousPublished) {
            const history = await this.store.previousPublished(before);
            if (!history.length) break;
            for (const day of history) {
                if (day.tradeDate !== expected || !methods.every(method => methodAvailable(day.batch, method))) break scan;
                const members = new Map(combine(day.batch.stocks, methods, limit).map(stock => [stock.symbol, stock]));
                for (const symbol of active) {
                    const member = members.get(symbol);
                    if (!member) active.delete(symbol);
                    else entries.set(symbol, { date: day.tradeDate, sessions: entries.get(symbol)!.sessions + 1, price: member.price });
                }
                expected = this.previousSession(day.batch, day.tradeDate);
                if (!active.size || !expected) break scan;
            }
            before = history[history.length - 1].tradeDate;
        }
        const dates = new Set([run.tradeDate, ...[...entries.values()].map(entry => entry.date)]);
        const snapshots = new Map(await Promise.all([...dates].map(async date => [date, await this.store.snapshot(date)] as const)));
        return new Map([...entries].map(([symbol, entry]) => {
            const first = snapshots.get(entry.date)?.bars[symbol];
            const latest = snapshots.get(run.tradeDate)?.bars[symbol];
            const adjusted = first && latest && first.factor > 0 && latest.factor > 0
                ? first.close * first.factor / latest.factor : null;
            const closeReturn = entry.date === run.tradeDate ? 0
                : adjusted && latest ? (latest.close / adjusted - 1) * 100 : null;
            return [symbol, { ...entry, closeReturn }] as const;
        }));
    }

    async results(query: SelectionQuery) {
        const expectedDate = query.date ?? null;
        await this.store.ensureSchema();
        const run = await this.store.latest(query.date);
        const base = { horizon: query.horizon, methods: query.methods, mode: 'blend', ruleVersion: run?.ruleVersion || RULE_VERSION, fusionVersion: FUSION_VERSION,
            expectedTradeDate: expectedDate, tradeDate: run?.tradeDate || null, runId: run?.id || null,
            dataAsOf: run?.dataAsOf || null, generatedAt: run?.generatedAt || null, candidateCount: 0,
            summary: '同时符合全部所选方法才可入选，综合表现优先。盘后确认，非实时买点。',
            methodStats: run?.batch?.methodStats || null };
        if (!run) return { ...base, status: 'empty', stocks: [] };
        if (expectedDate && run.tradeDate !== expectedDate) return { ...base, status: 'stale', stocks: [] };
        if (run.status !== 'ready' || !run.batch) return { ...base, status: run.status, stocks: [] };
        const unavailable = query.methods.filter(method => !methodAvailable(run.batch!, method));
        if (unavailable.length) return { ...base, status: 'unavailable', unavailableMethods: unavailable, stocks: [] };
        const stocks = combine(run.batch.stocks, query.methods, query.limit);
        const entries = stocks.length ? await this.trackEntries({ tradeDate: run.tradeDate, batch: run.batch }, query.methods, query.limit) : new Map();
        return { ...base, status: 'ready', nextQuoteTradeDate: this.source.nextTradingDate?.(run.tradeDate) ?? null, candidateCount: run.batch.stocks.filter(c => matchesAllMethods(c, query.methods)).length,
            stocks: stocks.map(stock => ({ ...stock, entry: entries.get(stock.symbol) })) };
    }
}
