import { AnnualFinancials, annualWindow, dividendFiscalYear, financialStockInScope } from './financialRules';
import { appendSignal, rankCandidates } from './rules';
import { Bar, Batch, Stock } from './types';

export interface DividendPayment { year: number; exDate: string; cash: number }
/** pe is TTM (null when TTM profit is negative); dividendYield is TTM in percent; marketCap in yuan. */
export interface DailyRatios { pe: number | null; dividendYield: number | null; marketCap: number | null }

/** Each stage needs ≥80% coverage of the stocks reaching it; otherwise the whole method is unavailable rather than an empty list. */
const covered = (missing: number, reached: number) => missing * 4 <= reached - missing;

export async function addDividendMethod(batch: Batch, stocks: Stock[], raw: Map<string, Bar[]>, dates: string[],
    financials?: ReadonlyMap<string, AnnualFinancials[]>, ratios?: ReadonlyMap<string, DailyRatios>,
    load?: (date: string, symbols: string[]) => Promise<Map<string, DividendPayment[]>>): Promise<void> {
    const tradeDate = dates[dates.length - 1];
    const fiscalYear = dividendFiscalYear(tradeDate);
    const candidates = new Map(batch.stocks.map(stock => [stock.symbol, stock]));
    const stats = batch.methodStats.stable_dividend = { pass: 0, fail: 0, unavailable: 0, notApplicable: 0 };
    const scope = stocks.filter(stock => financialStockInScope(stock) && Boolean(stock.listDate) && stock.listDate <= `${fiscalYear - 2}0101`);
    stats.notApplicable = stocks.length - scope.length;
    const unavailable = () => { stats.pass = 0; stats.fail = 0; stats.unavailable = scope.length; };

    const quoted = scope.filter(stock => ratios?.get(stock.symbol)?.marketCap);
    if (!covered(scope.length - quoted.length, scope.length)) return unavailable();
    stats.unavailable += scope.length - quoted.length;
    // TTM profitability blocks payouts funded by a loss-making year outside the three-year window.
    const yielding = quoted.filter(stock => {
        const { dividendYield, pe } = ratios!.get(stock.symbol)!;
        return (dividendYield ?? 0) >= 2.5 && pe !== null && pe > 0;
    });
    stats.fail += quoted.length - yielding.length;

    const windows = new Map(yielding.flatMap(stock => {
        const years = annualWindow(financials?.get(stock.symbol), fiscalYear, tradeDate);
        return years ? [[stock.symbol, years] as const] : [];
    }));
    if (!covered(yielding.length - windows.size, yielding.length)) return unavailable();
    stats.unavailable += yielding.length - windows.size;
    const eligible = yielding.filter(stock => {
        const years = windows.get(stock.symbol);
        if (!years) return false;
        if (years.some(y => y.profit <= 0 || y.operatingCash <= 0 || y.assets <= 0 || y.liabilities < 0 || y.liabilities / y.assets > 0.7)) {
            stats.fail++;
            return false;
        }
        return true;
    });
    if (!eligible.length) return;

    const payments = await load?.(tradeDate, eligible.map(stock => stock.symbol)).catch(error => {
        console.warn('[StockSelection] 分红来源不可用:', error instanceof Error ? error.message : String(error));
        return undefined;
    });
    const ready = eligible.filter(stock => payments?.has(stock.symbol) && raw.get(stock.symbol)?.some(bar => bar.date === tradeDate));
    if (!covered(eligible.length - ready.length, eligible.length)) return unavailable();
    stats.unavailable += eligible.length - ready.length;
    for (const stock of ready) {
        const history = payments!.get(stock.symbol)!;
        const bars = raw.get(stock.symbol)!;
        const years = windows.get(stock.symbol)!;
        const cash = years.map(y => history.filter(payment => payment.year === y.year && payment.exDate <= tradeDate)
            .reduce((sum, payment) => sum + payment.cash, 0));
        const payout = cash.map((amount, i) => amount / years[i].profit);
        const coverage = cash.map((amount, i) => years[i].operatingCash / amount);
        if (cash.some(amount => amount <= 0) || Math.max(...payout) > 0.85 || Math.min(...coverage) < 1.2) {
            stats.fail++;
            continue;
        }
        const { dividendYield, marketCap, pe } = ratios!.get(stock.symbol)!;
        // Rank on the latest audited year's payout so one-off dividends outside the window cannot inflate the score.
        const fiscalYield = cash[2] / marketCap! * 100;
        const maxPayout = Math.max(...payout), minCashCoverage = Math.min(...coverage);
        stats.pass++;
        appendSignal(batch, candidates, stock, bars, dates, { method: 'stable_dividend', rank: 0,
            score: Math.min(fiscalYield, 7) * 8 + Math.min(minCashCoverage, 3) * 10 - maxPayout * 10,
            reason: [`近三个财年均已实施现金分红，${fiscalYear}财年派息对应股息率${fiscalYield.toFixed(2)}%（近12个月${dividendYield!.toFixed(2)}%）`,
                `三年最高派息率${(maxPayout * 100).toFixed(1)}%，经营现金流最低覆盖${minCashCoverage.toFixed(2)}倍`],
            metrics: { dividendYield: dividendYield!, fiscalYield, pe: pe!, maxPayout, minCashCoverage, dividendYears: 3, fiscalYear },
            invalidation: '分红中断、派息超过利润承受能力或经营现金流走弱时重新评估' });
    }
    rankCandidates(batch.stocks, ['stable_dividend']);
}
