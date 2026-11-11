import { adjustBars, appendSignal, rankCandidates } from './rules';
import { Bar, Batch, Stock } from './types';

export interface ResearchForecast { symbol: string; reportDate: string; year: number; institution: string; profit: number }
export interface CompanyForecast { symbol: string; announced: string; period: string; firstAnnouncement: string; type: string; growth: number | null; profit: number | null }

function stockInScope(stock: Stock, tradeDate: string): boolean {
    return /^\d{6}$/.test(stock.symbol) && !/ST|退/i.test(stock.name)
        && Boolean(stock.listDate) && stock.listDate <= tradeDate.replace(/-/g, '');
}

function shiftDate(date: string, days: number): string {
    const shifted = new Date(`${date}T00:00:00Z`);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
}

export function addEarningsRevisions(batch: Batch, stocks: Stock[], raw: Map<string, Bar[]>, dates: string[], reports?: ResearchForecast[]): void {
    const tradeDate = dates[dates.length - 1];
    const cutoff = shiftDate(tradeDate, -20);
    const earliest = shiftDate(tradeDate, -75);
    const year = Number(tradeDate.slice(0, 4)) + 1;
    const byStock = new Map<string, Map<string, Map<string, number | null>>>();
    for (const report of reports || []) {
        if (report.year !== year || report.reportDate < earliest || report.reportDate >= tradeDate) continue;
        const byInstitution = byStock.get(report.symbol) || new Map();
        const byDate = byInstitution.get(report.institution) || new Map();
        const previous = byDate.get(report.reportDate);
        byDate.set(report.reportDate, previous !== undefined && previous !== report.profit ? null : report.profit);
        byInstitution.set(report.institution, byDate);
        byStock.set(report.symbol, byInstitution);
    }
    const stats = batch.methodStats.earnings_revision = { pass: 0, fail: 0, unavailable: 0, notApplicable: 0 };
    const candidates = new Map(batch.stocks.map(stock => [stock.symbol, stock]));
    for (const stock of stocks) {
        if (!stockInScope(stock, tradeDate)) { stats.notApplicable++; continue; }
        if (!reports) { stats.unavailable++; continue; }
        const institutions = byStock.get(stock.symbol);
        const revisions: number[] = [];
        for (const byDate of institutions?.values() || []) {
            const latest = [...byDate].sort(([a], [b]) => b.localeCompare(a));
            const current = latest[0];
            const baseline = latest.find(([date]) => date < cutoff);
            if (!current || current[0] < cutoff || !baseline || current[1] === null || baseline[1] === null || baseline[1] <= 0) continue;
            revisions.push((current[1] / baseline[1] - 1) * 100);
        }
        if (revisions.length < 2) { stats.notApplicable++; continue; }
        revisions.sort((a, b) => a - b);
        const median = (revisions[Math.floor(revisions.length / 2)] + revisions[Math.floor((revisions.length - 1) / 2)]) / 2;
        const upgraded = revisions.filter(revision => revision >= 3).length;
        const breadth = upgraded / revisions.length;
        if (median < 5 || breadth < 0.6) { stats.fail++; continue; }
        const bars = raw.get(stock.symbol) || [];
        if (!bars.some(bar => bar.date === tradeDate)) { stats.unavailable++; continue; }
        stats.pass++;
        appendSignal(batch, candidates, stock, bars, dates, { method: 'earnings_revision', rank: 0,
            score: Math.min(median, 30) * 2 + breadth * 25 + Math.min(revisions.length, 10) * 2,
            reason: [`同机构比较${year}财年净利润预测，${revisions.length}家机构可比，其中${upgraded}家上修至少3%`,
                `可比预测修正幅度中位数为+${median.toFixed(1)}%`],
            metrics: { fiscalYear: year, medianRevision: median, revisionBreadth: breadth, comparableInstitutions: revisions.length },
            invalidation: '后续机构下调预测，或业绩披露不支持原预测时重新评估' });
    }
    rankCandidates(batch.stocks, ['earnings_revision']);
}

export function addEventCatalysts(batch: Batch, stocks: Stock[], raw: Map<string, Bar[]>, dates: string[], forecasts?: CompanyForecast[]): void {
    const tradeDate = dates[dates.length - 1];
    const earliest = dates[dates.length - 4];
    const byStock = new Map<string, CompanyForecast>();
    const conflicted = new Set<string>();
    for (const event of forecasts || []) {
        if (event.announced < earliest || event.announced >= tradeDate) continue;
        const existing = byStock.get(event.symbol);
        if (!existing || event.announced > existing.announced) {
            byStock.set(event.symbol, event);
            conflicted.delete(event.symbol);
        } else if (existing.announced === event.announced && (existing.period !== event.period || existing.type !== event.type
            || existing.growth !== event.growth || existing.profit !== event.profit || existing.firstAnnouncement !== event.firstAnnouncement)) {
            conflicted.add(event.symbol);
        }
    }
    const stats = batch.methodStats.event_catalyst = { pass: 0, fail: 0, unavailable: 0, notApplicable: 0 };
    const candidates = new Map(batch.stocks.map(stock => [stock.symbol, stock]));
    for (const stock of stocks) {
        if (!stockInScope(stock, tradeDate)) { stats.notApplicable++; continue; }
        if (!forecasts) { stats.unavailable++; continue; }
        const event = byStock.get(stock.symbol);
        if (!event) { stats.notApplicable++; continue; }
        if (conflicted.has(stock.symbol)) { stats.unavailable++; continue; }
        if (event.firstAnnouncement !== event.announced || !['预增', '略增'].includes(event.type)
            || event.growth === null || event.growth < 30 || event.profit === null || event.profit <= 0) { stats.fail++; continue; }
        const firstSession = dates.findIndex(day => day > event.announced);
        if (firstSession < 20) { stats.unavailable++; continue; }
        const window = dates.slice(firstSession - 20);
        const stockBars = raw.get(stock.symbol) || [];
        const bars = adjustBars(stockBars, window);
        if (!bars) { stats.unavailable++; continue; }
        const reference = bars.slice(0, 20);
        const sinceEvent = bars.slice(20);
        const last = sinceEvent[sinceEvent.length - 1];
        const preClose = reference[19].close;
        const change = (last.close / preClose - 1) * 100;
        const average = reference.reduce((sum, bar) => sum + bar.amount, 0) / reference.length;
        const volumeConfirmation = Math.max(...sinceEvent.map(bar => bar.amount / average));
        if (change < 2 || change > 15 || average < 50_000_000 || volumeConfirmation < 1.5) { stats.fail++; continue; }
        stats.pass++;
        appendSignal(batch, candidates, stock, stockBars, dates, { method: 'event_catalyst', rank: 0,
            score: Math.min(event.growth, 100) * 0.3 + change * 2 + Math.min(volumeConfirmation, 4) * 8,
            reason: [`${event.announced}首次披露业绩预告，预计${event.period}净利润同比至少增长${event.growth.toFixed(1)}%`,
                `从公告次日起至信号日收盘累计上涨${change.toFixed(2)}%，单日成交额最高为反应窗口前20个交易日均值的${volumeConfirmation.toFixed(2)}倍`],
            metrics: { forecastGrowthLower: event.growth, postEventReturn: change, peakTurnoverMultiple: volumeConfirmation },
            invalidation: '公司修正业绩预告，或收盘跌回公告前基准价时重新评估' });
    }
    rankCandidates(batch.stocks, ['event_catalyst']);
}
