import { getDividend, tushareRequest } from './TushareService';
export const __selectionMarketDependencies = {
    request: tushareRequest, dividend: getDividend,
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
};

const RETRY_DELAYS_MS = [3000, 10000, 30000];
const TRANSIENT = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|socket hang up|aborted|timeout|fetch failed|HTTP错误: (429|5\d\d)|每分钟|每小时|频率|最多访问/i;
function transient(error: unknown): boolean {
    const e = error as { name?: string; code?: string; message?: string; cause?: { code?: string } } | null;
    return e?.name === 'AbortError' || e?.name === 'TimeoutError' || TRANSIENT.test(`${e?.code || ''} ${e?.cause?.code || ''} ${e?.message || ''}`);
}
/** Network failures and rate limits are retried; business errors (permissions, bad params) fail immediately. */
export async function selectionRetry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try { return await call(); }
        catch (error) {
            if (attempt >= RETRY_DELAYS_MS.length || !transient(error)) throw error;
            await __selectionMarketDependencies.sleep(RETRY_DELAYS_MS[attempt]);
        }
    }
}

/** Pagination must advance: reject duplicated/truncated pages instead of silently screening a partial universe. */
export async function selectionPages(api: string, params: Record<string, unknown>, fields: string, reportIdentity?: (row: Record<string, unknown>) => string, pageSize = 5000): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [], seen = new Set<string>();
    for (let offset = 0; offset < 100000; offset += pageSize) {
        const rows = await selectionRetry(() => __selectionMarketDependencies.request(api, { ...params, limit: pageSize, offset }, fields));
        const previousLength = all.length;
        for (const row of rows) {
            const key = reportIdentity ? reportIdentity(row) : `${row.ts_code}:${row.trade_date || ''}`;
            if (seen.has(key)) {
                if (reportIdentity) continue;
                throw new Error(`${api}分页未前进或包含重复数据`);
            }
            seen.add(key); all.push(row);
        }
        if (rows.length && all.length === previousLength) throw new Error(`${api}分页未前进`);
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
/** Suspended symbols per ISO date; a symbol missing from daily bars without a suspension is a vendor gap. */
export async function selectionSuspensions(start: string, end: string): Promise<Map<string, Set<string>>> {
    const rows = await selectionPages('suspend_d', { start_date: start.replace(/-/g, ''), end_date: end.replace(/-/g, ''), suspend_type: 'S' },
        'ts_code,trade_date,suspend_type');
    const byDate = new Map<string, Set<string>>();
    for (const row of rows) {
        const code = String(row.ts_code), date = iso(row.trade_date);
        if (!date || row.suspend_type !== 'S' || !/^\d{6}\.(SH|SZ|BJ)$/.test(code)) continue;
        byDate.set(date, (byDate.get(date) || new Set()).add(code.split('.')[0]));
    }
    return byDate;
}
export async function selectionBenchmark(start: string, end: string) {
    const rows = await selectionPages('index_daily', { ts_code: '000300.SH', start_date: start.replace(/-/g, ''), end_date: end.replace(/-/g, '') }, 'ts_code,trade_date,open,high,low,close,pct_chg,vol,amount');
    return rows.map(r => ({ date: iso(r.trade_date), open: numeric(r.open), high: numeric(r.high), low: numeric(r.low), close: numeric(r.close),
        volume: numeric(r.vol) * 100, amount: numeric(r.amount) * 1000, factor: 1, changePct: numeric(r.pct_chg) }));
}

export async function selectionUpperLimits(date: string): Promise<Map<string, number>> {
    const rows = await selectionPages('stk_limit', { trade_date: date.replace(/-/g, '') }, 'ts_code,trade_date,up_limit');
    const prices = new Map<string, number>();
    for (const row of rows) {
        const code = String(row.ts_code);
        const price = numeric(row.up_limit);
        if (iso(row.trade_date) === date && /^\d{6}\.(SH|SZ|BJ)$/.test(code) && Number.isFinite(price) && price > 0) {
            prices.set(code.split('.')[0], price);
        }
    }
    return prices;
}

/** Latest originally consolidated annual figures available by the selection date. */
async function annualRows(api: string, period: string, asOf: string, fields: string[]) {
    const rows = await selectionPages(api, { period, report_type: '1' },
        ['ts_code', 'end_date', 'ann_date', 'f_ann_date', 'report_type', ...fields].join(','),
        row => JSON.stringify(row));
    const byStock = new Map<string, { disclosed: string; values: number[] | null }>();
    for (const row of rows) {
        const actual = iso(row.f_ann_date);
        const announced = iso(row.ann_date);
        if (!actual || !announced || actual > asOf || announced > asOf || row.end_date !== period || String(row.report_type) !== '1') continue;
        const disclosed = actual > announced ? actual : announced;
        const code = String(row.ts_code);
        if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code)) continue;
        const symbol = code.split('.')[0];
        const old = byStock.get(symbol);
        if (old && old.disclosed > disclosed) continue;
        const values = fields.map(field => numeric(row[field]));
        if (old?.disclosed === disclosed) {
            if (old.values?.some((value, index) => value !== values[index])) old.values = null;
        } else {
            byStock.set(symbol, { disclosed, values: values.every(Number.isFinite) ? values : null });
        }
    }
    return byStock;
}

export async function selectionAnnualFinancials(asOf: string) {
    // Growth methods switch after the Apr 30 report deadline; dividend screening switches after Aug 31,
    // so May–Aug also needs the prior three-year window.
    const latestYear = Number(asOf.slice(0, 4)) - (asOf.slice(5) > '04-30' ? 1 : 2);
    const firstYear = Number(asOf.slice(0, 4)) - (asOf.slice(5) > '08-31' ? 1 : 2) - 2;
    const byStock = new Map<string, Array<{
        year: number; disclosed: string; revenue: number; profit: number;
        operatingCash: number; assets: number; liabilities: number; equity: number;
    }>>();
    for (let year = firstYear; year <= latestYear; year++) {
        const period = `${year}1231`;
        const income = await annualRows('income_vip', period, asOf, ['total_revenue', 'n_income_attr_p']);
        const cash = await annualRows('cashflow_vip', period, asOf, ['n_cashflow_act']);
        const balance = await annualRows('balancesheet_vip', period, asOf, ['total_assets', 'total_liab', 'total_hldr_eqy_exc_min_int']);
        for (const [symbol, i] of income) {
            const c = cash.get(symbol), b = balance.get(symbol);
            if (!i.values || !c?.values || !b?.values) continue;
            const [revenue, profit] = i.values;
            const [operatingCash] = c.values;
            const [assets, liabilities, equity] = b.values;
            const series = byStock.get(symbol) || [];
            series.push({ year, disclosed: [i.disclosed, c.disclosed, b.disclosed].sort()[2],
                revenue, profit, operatingCash, assets, liabilities, equity });
            byStock.set(symbol, series);
        }
    }
    return byStock;
}

export async function selectionDailyRatios(date: string) {
    const rows = await selectionPages('daily_basic', { trade_date: date.replace(/-/g, '') }, 'ts_code,trade_date,pe_ttm,dv_ttm,total_mv');
    return new Map(rows.filter(row => iso(row.trade_date) === date && /^\d{6}\.(SH|SZ|BJ)$/.test(String(row.ts_code)))
        .map(row => {
            const pe = numeric(row.pe_ttm);
            const yieldTtm = numeric(row.dv_ttm);
            const marketCap = numeric(row.total_mv) * 10_000;
            return [String(row.ts_code).split('.')[0], { pe: Number.isFinite(pe) ? pe : null,
                dividendYield: Number.isFinite(yieldTtm) ? yieldTtm : null,
                marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null }] as const;
        }));
}

export async function selectionDividends(date: string, symbols: string[]) {
    const byStock = new Map<string, Array<{ year: number; exDate: string; cash: number }>>();
    const fiscalYear = Number(date.slice(0, 4)) - (date.slice(5) > '08-31' ? 1 : 2);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(symbols.length, 8) }, async () => {
        while (cursor < symbols.length) {
            const symbol = symbols[cursor++];
            try {
                const rows = await selectionRetry(() => __selectionMarketDependencies.dividend(symbol));
                const events = new Map<string, { year: number; exDate: string; cash: number }>();
                for (const row of rows) {
                    const year = Number(String(row.end_date).slice(0, 4));
                    if (year < fiscalYear - 2 || year > fiscalYear) continue;
                    const exDate = iso(row.ex_date), paid = iso(row.pay_date), announced = iso(row.imp_ann_date);
                    const perShare = numeric(row.cash_div_tax);
                    if (row.div_proc !== '实施' || !Number.isFinite(perShare) || perShare <= 0) continue;
                    if (!exDate || !paid || !announced) throw new Error('已实施现金分红缺少日期');
                    if (exDate > date || paid > date || announced > date) continue;
                    const period = iso(row.end_date);
                    const baseShares = numeric(row.base_share);
                    if (!period || !Number.isFinite(baseShares) || baseShares <= 0) throw new Error('缺少分红归属期或基准股本');
                    const cash = perShare * baseShares * 10_000;
                    const key = `${year}:${exDate}`;
                    const previous = events.get(key);
                    if (previous && previous.cash !== cash) throw new Error('同一除息日的分红金额冲突');
                    events.set(key, { year, exDate, cash });
                }
                byStock.set(symbol, [...events.values()]);
            } catch (error) {
                console.warn('[StockSelection] 分红记录读取失败', symbol, error instanceof Error ? error.message : String(error));
            }
        }
    }));
    return byStock;
}

export async function selectionResearch(date: string) {
    const end = new Date(`${date}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 74);
    const compact = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const rows = await selectionPages('report_rc', { start_date: compact(start), end_date: compact(end) },
        'ts_code,report_date,quarter,org_name,np', row => JSON.stringify(row), 3000);
    if (!rows.length) throw new Error('75日研报窗口没有数据');
    const year = Number(date.slice(0, 4)) + 1;
    return rows.flatMap(row => {
        const code = String(row.ts_code), reportDate = iso(row.report_date);
        const institution = String(row.org_name || '').normalize('NFKC').trim().replace(/\s+/g, '');
        const profit = numeric(row.np);
        if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code) || !reportDate || !institution || row.quarter !== `${year}Q4` || !Number.isFinite(profit)) return [];
        return [{ symbol: code.split('.')[0], reportDate, year, institution, profit }];
    });
}

export async function selectionCompanyForecasts(start: string, end: string) {
    const forecasts = [];
    for (const day = new Date(`${start}T00:00:00Z`); day.toISOString().slice(0, 10) < end; day.setUTCDate(day.getUTCDate() + 1)) {
        const ann_date = day.toISOString().slice(0, 10).replace(/-/g, '');
        const rows = await selectionPages('forecast', { ann_date },
            'ts_code,ann_date,end_date,type,p_change_min,net_profit_min,first_ann_date', row => JSON.stringify(row), 3000);
        for (const row of rows) {
            const code = String(row.ts_code), announced = iso(row.ann_date), period = iso(row.end_date);
            if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code) || row.ann_date !== ann_date || !announced || !period) continue;
            const growth = numeric(row.p_change_min), profit = numeric(row.net_profit_min);
            forecasts.push({ symbol: code.split('.')[0], announced, period,
                firstAnnouncement: iso(row.first_ann_date), type: String(row.type || ''),
                growth: Number.isFinite(growth) ? growth : null, profit: Number.isFinite(profit) ? profit : null });
        }
    }
    return forecasts;
}
