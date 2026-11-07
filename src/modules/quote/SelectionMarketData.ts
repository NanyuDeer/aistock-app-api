import { tushareRequest } from './TushareService';
export const __selectionMarketDependencies = { request: tushareRequest };

/** Pagination must advance: reject duplicated/truncated pages instead of silently screening a partial universe. */
export async function selectionPages(api: string, params: Record<string, unknown>, fields: string): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [], seen = new Set<string>();
    const pageSize = 5000;
    for (let offset = 0; offset < 100000; offset += pageSize) {
        const rows = await __selectionMarketDependencies.request(api, { ...params, limit: pageSize, offset }, fields);
        for (const row of rows) {
            const key = `${row.ts_code}:${row.trade_date || ''}`;
            if (seen.has(key)) throw new Error(`${api}分页未前进或包含重复数据`);
            seen.add(key); all.push(row);
        }
        if (rows.length < pageSize) return all;
    }
    throw new Error(`${api}分页超过上限`);
}
function numeric(value: unknown): number {
    return value === null || value === undefined || value === '' ? Number.NaN : Number(value);
}
function iso(date: unknown): string {
    const v = String(date);
    return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : '';
}
export async function selectionStocks() {
    const rows = await selectionPages('stock_basic', { list_status: 'L' }, 'ts_code,symbol,name,industry,list_date');
    return rows.filter(r => /^\d{6}\.(SH|SZ|BJ)$/.test(String(r.ts_code))).map(r => ({
        symbol: String(r.ts_code).split('.')[0], name: String(r.name || ''), industry: String(r.industry || ''), listDate: String(r.list_date || ''),
    }));
}
export async function selectionMarketDay(date: string) {
    const trade_date = date.replace(/-/g, '');
    const daily = await selectionPages('daily', { trade_date }, 'ts_code,trade_date,open,high,low,close,pct_chg,vol,amount');
    const factors = await selectionPages('adj_factor', { trade_date }, 'ts_code,trade_date,adj_factor');
    const factorMap = new Map(factors.filter(r => iso(r.trade_date) === date).map(r => [String(r.ts_code), numeric(r.adj_factor)]));
    const entries = daily.filter(r => iso(r.trade_date) === date && /^\d{6}\.(SH|SZ|BJ)$/.test(String(r.ts_code))).flatMap(r => {
        const factor = factorMap.get(String(r.ts_code));
        if (!factor || !Number.isFinite(factor)) return [];
        const bar = { date, open: numeric(r.open), high: numeric(r.high), low: numeric(r.low), close: numeric(r.close),
            volume: numeric(r.vol) * 100, amount: numeric(r.amount) * 1000, factor, changePct: numeric(r.pct_chg) };
        if (!Object.values(bar).every(v => typeof v === 'string' || Number.isFinite(v))) return [];
        return [[String(r.ts_code).split('.')[0], bar] as const];
    });
    return { date, bars: Object.fromEntries(entries), fetchedAt: new Date().toISOString() };
}
export async function selectionBenchmark(start: string, end: string) {
    const rows = await selectionPages('index_daily', { ts_code: '000300.SH', start_date: start.replace(/-/g, ''), end_date: end.replace(/-/g, '') }, 'ts_code,trade_date,open,high,low,close,pct_chg,vol,amount');
    return rows.map(r => ({ date: iso(r.trade_date), open: numeric(r.open), high: numeric(r.high), low: numeric(r.low), close: numeric(r.close),
        volume: numeric(r.vol) * 100, amount: numeric(r.amount) * 1000, factor: 1, changePct: numeric(r.pct_chg) }));
}
