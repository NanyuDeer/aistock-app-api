import { appendSignal, rankCandidates } from './rules';
import { Bar, Batch, Method, Stock } from './types';

export interface AnnualFinancials {
    year: number; disclosed: string; revenue: number; profit: number;
    operatingCash: number; assets: number; liabilities: number; equity: number;
}
export const FINANCIAL_METHODS = ['quality_growth', 'garp'] as const;
export const financialStockInScope = (s: Stock) => /^\d{6}$/.test(s.symbol) && Boolean(s.industry) && !/ST|退/i.test(s.name)
    && !/银行|证券|保险|金融|期货|信托/.test(s.industry);

export function addFinancialMethods(batch: Batch, stocks: Stock[], raw: Map<string, Bar[]>, dates: string[],
    financials?: ReadonlyMap<string, AnnualFinancials[]>, valuations?: ReadonlyMap<string, number | null>): void {
    const date = dates[dates.length - 1];
    const fiscalYear = Number(date.slice(0, 4)) - (date.slice(5) > '04-30' ? 1 : 2);
    const candidates = new Map(batch.stocks.map(stock => [stock.symbol, stock]));
    const peers = new Map<string, Array<number | null>>();
    const peerCounts = new Map<string, number>();
    for (const stock of stocks.filter(financialStockInScope)) {
        if (!stock.listDate || stock.listDate > date.replace(/-/g, '')) continue;
        const pe = valuations?.get(stock.symbol);
        peerCounts.set(stock.industry, (peerCounts.get(stock.industry) || 0) + 1);
        if (pe === undefined) continue;
        const values = peers.get(stock.industry) || [];
        values.push(pe);
        peers.set(stock.industry, values);
    }
    const medians = new Map<string, number>();
    for (const [industry, values] of peers) {
        const positive = values.filter((pe): pe is number => pe !== null && pe > 0).sort((a, b) => a - b);
        if (positive.length < 5 || values.length / peerCounts.get(industry)! < 0.8) continue;
        const mid = Math.floor(positive.length / 2);
        medians.set(industry, (positive[mid] + positive[Math.floor((positive.length - 1) / 2)]) / 2);
    }
    for (const method of FINANCIAL_METHODS) batch.methodStats[method] = { pass: 0, fail: 0, unavailable: 0, notApplicable: 0 };
    for (const stock of stocks) {
        const mark = (key: 'notApplicable' | 'unavailable' | 'fail') => {
            for (const method of FINANCIAL_METHODS) batch.methodStats[method][key]++;
        };
        if (!financialStockInScope(stock) || !stock.listDate || stock.listDate > `${fiscalYear - 2}0101`) { mark('notApplicable'); continue; }
        const bars = raw.get(stock.symbol) || [];
        const quote = bars.find(b => b.date === date);
        const years = financials?.get(stock.symbol);
        if (!quote || !years || years.length !== 3 || years.some((y, index) => y.year !== fiscalYear - 2 + index || y.disclosed > date)) {
            mark('unavailable');
            continue;
        }
        const [first, prior, last] = years;
        if (years.some(y => y.revenue <= 0 || y.profit <= 0 || y.assets <= 0 || y.equity <= 0 || y.liabilities < 0)) { mark('fail'); continue; }
        const revenueGrowth = (Math.sqrt(last.revenue / first.revenue) - 1) * 100;
        const profitGrowth = (Math.sqrt(last.profit / first.profit) - 1) * 100;
        const roe = last.profit / ((last.equity + prior.equity) / 2) * 100;
        const debtRatio = last.liabilities / last.assets * 100;
        const cashCoverage = years.reduce((sum, y) => sum + y.operatingCash, 0) / years.reduce((sum, y) => sum + y.profit, 0);
        const metrics = { revenueGrowth, profitGrowth, roe, debtRatio, cashCoverage, fiscalYear };
        const sustained = years.every((y, i) => i === 0 || (y.revenue > years[i - 1].revenue && y.profit > years[i - 1].profit))
            && first.profit / first.revenue >= 0.02 && last.operatingCash > 0;
        const reasons = [`截至${fiscalYear}年报，近三年营收和归母净利润连续增长，年化增幅分别为${revenueGrowth.toFixed(1)}%和${profitGrowth.toFixed(1)}%`,
            `最新年报平均净资产收益率${roe.toFixed(1)}%，三年经营现金流为同期归母净利润的${cashCoverage.toFixed(2)}倍`];
        const add = (method: Method, pass: boolean, score: number, reason: string[], extra = {}) => {
            batch.methodStats[method][pass ? 'pass' : 'fail']++;
            if (!pass) return;
            appendSignal(batch, candidates, stock, bars, dates, { method, score, rank: 0, reason, metrics: { ...metrics, ...extra },
                invalidation: '财报显示增长放缓、经营现金流转弱或估值超过筛选区间时重新评估' });
        };
        add('quality_growth', sustained && revenueGrowth >= 8 && profitGrowth >= 12 && roe >= 12 && cashCoverage >= 0.9 && debtRatio <= 65,
            Math.min(revenueGrowth, 35) + Math.min(profitGrowth, 40) + Math.min(roe, 25) + Math.min(cashCoverage, 2) * 8 - debtRatio / 5, reasons);
        const growth = sustained && revenueGrowth >= 6 && profitGrowth >= 10 && roe >= 9 && cashCoverage >= 0.8 && debtRatio <= 70;
        const pe = valuations?.get(stock.symbol), industryMedianPe = medians.get(stock.industry);
        if (growth && (pe == null || (pe > 0 && industryMedianPe === undefined))) batch.methodStats.garp.unavailable++;
        else {
            const peg = growth && pe != null ? pe / Math.min(profitGrowth, 30) : 0;
            add('garp', growth && pe != null && pe > 0 && industryMedianPe !== undefined
                && pe <= 35 && pe <= industryMedianPe && peg <= 1.5,
            Math.min(profitGrowth, 30) + Math.min(roe, 25) + (1.5 - peg) * 20,
            [...reasons, `市盈率TTM ${pe?.toFixed(1)}倍，同业正市盈率中位数${industryMedianPe?.toFixed(1)}倍`],
            { pe: pe ?? undefined, industryMedianPe, peg });
        }
    }
    rankCandidates(batch.stocks, FINANCIAL_METHODS);
}
