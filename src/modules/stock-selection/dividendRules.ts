import { AnnualFinancials, financialStockInScope } from './financialRules';
import { appendSignal, rankCandidates } from './rules';
import { Bar, Batch, Stock } from './types';

export interface DividendPayment { year: number; exDate: string; cash: number }
export interface DailyRatios { pe: number | null; dividendYield: number | null }

function eligibility(stock: Stock, tradeDate: string, years: AnnualFinancials[] | undefined, ratios: DailyRatios | undefined) {
    const fiscalYear = Number(tradeDate.slice(0, 4)) - (tradeDate.slice(5) > '04-30' ? 1 : 2);
    if (!financialStockInScope(stock) || !stock.listDate || stock.listDate > `${fiscalYear - 2}0101`) return 'notApplicable';
    if (!ratios) return 'unavailable';
    if (ratios.dividendYield === null || ratios.dividendYield < 2.5) return 'notApplicable';
    if (!years || years.length !== 3 || years.some((y, i) => y.year !== fiscalYear - 2 + i || y.disclosed > tradeDate)) return 'unavailable';
    if (years.some(y => y.profit <= 0 || y.operatingCash <= 0 || y.assets <= 0 || y.liabilities < 0 || y.liabilities / y.assets > 0.7)) return 'notApplicable';
    return 'eligible';
}

export async function addDividendMethod(batch: Batch, stocks: Stock[], raw: Map<string, Bar[]>, dates: string[],
    financials?: ReadonlyMap<string, AnnualFinancials[]>, ratios?: ReadonlyMap<string, DailyRatios>,
    load?: (date: string, symbols: string[]) => Promise<Map<string, DividendPayment[]>>): Promise<void> {
    const tradeDate = dates[dates.length - 1];
    const candidates = new Map(batch.stocks.map(stock => [stock.symbol, stock]));
    const stats = batch.methodStats.stable_dividend = { pass: 0, fail: 0, unavailable: 0, notApplicable: 0 };
    const eligible = stocks.filter(stock => {
        const outcome = eligibility(stock, tradeDate, financials?.get(stock.symbol), ratios?.get(stock.symbol));
        if (outcome === 'eligible') return true;
        stats[outcome]++;
        return false;
    });
    if (!eligible.length) return;
    const payments = await load?.(tradeDate, eligible.map(stock => stock.symbol)).catch(error => {
        console.warn('[StockSelection] 分红来源不可用:', error instanceof Error ? error.message : String(error));
        return undefined;
    });
    for (const stock of eligible) {
        const history = payments?.get(stock.symbol);
        const bars = raw.get(stock.symbol) || [];
        if (!history || !bars.some(bar => bar.date === tradeDate)) { stats.unavailable++; continue; }
        const years = financials!.get(stock.symbol)!;
        const cash = years.map(y => history.filter(payment => payment.year === y.year && payment.exDate <= tradeDate)
            .reduce((sum, payment) => sum + payment.cash, 0));
        const payout = cash.map((amount, i) => amount / years[i].profit);
        const coverage = cash.map((amount, i) => years[i].operatingCash / amount);
        if (cash.some(amount => amount <= 0) || Math.max(...payout) > 0.85 || Math.min(...coverage) < 1.2) {
            stats.fail++;
            continue;
        }
        const dividendYield = ratios!.get(stock.symbol)!.dividendYield!;
        const maxPayout = Math.max(...payout), minCashCoverage = Math.min(...coverage);
        stats.pass++;
        appendSignal(batch, candidates, stock, bars, dates, { method: 'stable_dividend', rank: 0,
            score: Math.min(dividendYield, 7) * 8 + Math.min(minCashCoverage, 3) * 10 - maxPayout * 10,
            reason: [`近三个财年均已实施现金分红，近12个月股息率${dividendYield.toFixed(2)}%`,
                `三年最高派息率${(maxPayout * 100).toFixed(1)}%，经营现金流最低覆盖${minCashCoverage.toFixed(2)}倍`],
            metrics: { dividendYield, maxPayout, minCashCoverage, dividendYears: 3 },
            invalidation: '分红中断、派息超过利润承受能力或经营现金流走弱时重新评估' });
    }
    rankCandidates(batch.stocks, ['stable_dividend']);
}
