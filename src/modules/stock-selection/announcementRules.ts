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
    const byStock = new Map<string, Map<string, Map<string, number>>>();
    // A same-day conflict anywhere in the 75-day range makes the institution's series unreliable, not just that date.
    const conflicted = new Set<string>();
    for (const report of reports || []) {
        if (report.year !== year || report.reportDate < earliest || report.reportDate >= tradeDate) continue;
        const byInstitution = byStock.get(report.symbol) || new Map<string, Map<string, number>>();
        const byDate = byInstitution.get(report.institution) || new Map<string, number>();
        const previous = byDate.get(report.reportDate);
        if (previous !== undefined && previous !== report.profit) conflicted.add(`${report.symbol}:${report.institution}`);
        byDate.set(report.reportDate, report.profit);
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
        for (const [institution, byDate] of institutions || []) {
            if (conflicted.has(`${stock.symbol}:${institution}`)) continue;
            // Only the latest forecast must fall within 20 days; the baseline is the institution's preceding one.
            const [current, baseline] = [...byDate].sort(([a], [b]) => b.localeCompare(a));
            if (!current || current[0] < cutoff || !baseline || baseline[1] <= 0) continue;
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
            reason: [`同机构比较${year}财年最近两份净利润预测，${revisions.length}家机构可比，其中${upgraded}家上修至少3%`,
                `可比预测修正幅度中位数为+${median.toFixed(1)}%`],
            metrics: { fiscalYear: year, medianRevision: median, revisionBreadth: breadth, comparableInstitutions: revisions.length },
            invalidation: '后续机构下调预测，或业绩披露不支持原预测时重新评估' });
    }
    rankCandidates(batch.stocks, ['earnings_revision']);
}

export function addEventCatalysts(batch: Batch, stocks: Stock[], raw: Map<string, Bar[]>, dates: string[], forecasts?: CompanyForecast[]): void {
    const tradeDate = dates[dates.length - 1];
    const earliest = dates[dates.length - 4];
    // Keyed by stock and report period: a revision only supersedes the first announcement of its own period.
    const byPeriod = new Map<string, Map<string, CompanyForecast[]>>();
    for (const event of forecasts || []) {
        if (event.announced < earliest || event.announced >= tradeDate) continue;
        const periods = byPeriod.get(event.symbol) || new Map<string, CompanyForecast[]>();
        periods.set(event.period, [...(periods.get(event.period) || []), event]);
        byPeriod.set(event.symbol, periods);
    }
    const sameForecast = (a: CompanyForecast, b: CompanyForecast) => a.type === b.type && a.growth === b.growth
        && a.profit === b.profit && a.firstAnnouncement === b.firstAnnouncement;
    const stats = batch.methodStats.event_catalyst = { pass: 0, fail: 0, unavailable: 0, notApplicable: 0 };
    const candidates = new Map(batch.stocks.map(stock => [stock.symbol, stock]));
    for (const stock of stocks) {
        if (!stockInScope(stock, tradeDate)) { stats.notApplicable++; continue; }
        if (!forecasts) { stats.unavailable++; continue; }
        const periods = byPeriod.get(stock.symbol);
        if (!periods) { stats.notApplicable++; continue; }
        let conflicted = false;
        const qualified: Array<CompanyForecast & { growth: number }> = [];
        for (const events of periods.values()) {
            const latestDate = events.reduce((max, event) => event.announced > max ? event.announced : max, '');
            const latest = events.filter(event => event.announced === latestDate);
            if (latest.some(event => !sameForecast(event, latest[0]))) { conflicted = true; continue; }
            const event = latest[0];
            if (event.firstAnnouncement === event.announced && ['预增', '略增'].includes(event.type)
                && event.growth !== null && event.growth >= 30 && event.profit !== null && event.profit > 0) qualified.push({ ...event, growth: event.growth });
        }
        if (!qualified.length) { stats[conflicted ? 'unavailable' : 'fail']++; continue; }
        const stockBars = raw.get(stock.symbol) || [];
        // Any qualifying first announcement may trigger; check each newest first and keep the first that confirms.
        let unavailable = 0;
        let hit: { event: typeof qualified[number]; onTradingDay: boolean; fullChange: number; postChange: number; low: number; volumeConfirmation: number } | undefined;
        for (const event of qualified.sort((a, b) => b.announced.localeCompare(a.announced) || b.period.localeCompare(a.period))) {
            // The vendor gives no release time, so the reaction must qualify whether it began on the announcement
            // day (pre-market) or the next session (after close). The reference ends before the announcement day.
            const start = dates.findIndex(day => day >= event.announced);
            const window = dates.slice(start - 20);
            const bars = start >= 20 ? adjustBars(stockBars, window) : null;
            if (!bars) { unavailable++; continue; }
            const reference = bars.slice(0, 20);
            const onTradingDay = window[20] === event.announced;
            const after = bars.slice(onTradingDay ? 21 : 20);
            const last = bars[bars.length - 1];
            const fullChange = (last.close / reference[19].close - 1) * 100;
            const postChange = (last.close / (onTradingDay ? bars[20] : reference[19]).close - 1) * 100;
            const low = Math.min(fullChange, postChange), high = Math.max(fullChange, postChange);
            const average = reference.reduce((sum, bar) => sum + bar.amount, 0) / reference.length;
            const volumeConfirmation = Math.max(...after.map(bar => bar.amount / average));
            if (low < 2 || high > 15 || average < 50_000_000 || volumeConfirmation < 1.5) continue;
            hit = { event, onTradingDay, fullChange, postChange, low, volumeConfirmation };
            break;
        }
        // An undecidable announcement or conflicting period could still trigger on its own, so it outranks a failure.
        if (!hit) { stats[unavailable || conflicted ? 'unavailable' : 'fail']++; continue; }
        const { event, onTradingDay, fullChange, postChange, low, volumeConfirmation } = hit;
        stats.pass++;
        appendSignal(batch, candidates, stock, stockBars, dates, { method: 'event_catalyst', rank: 0,
            score: Math.min(event.growth, 100) * 0.3 + low * 2 + Math.min(volumeConfirmation, 4) * 8,
            reason: [`${event.announced}首次披露业绩预告，预计${event.period}净利润同比至少增长${event.growth.toFixed(1)}%`,
                onTradingDay
                    ? `公告次日起累计上涨${postChange.toFixed(2)}%，含公告当日为${fullChange.toFixed(2)}%；公告后单日成交额最高为公告前20个交易日均值的${volumeConfirmation.toFixed(2)}倍`
                    : `公告后累计上涨${postChange.toFixed(2)}%，单日成交额最高为公告前20个交易日均值的${volumeConfirmation.toFixed(2)}倍`],
            metrics: { forecastGrowthLower: event.growth, postEventReturn: postChange, fullEventReturn: fullChange, peakTurnoverMultiple: volumeConfirmation },
            invalidation: '公司修正业绩预告，或收盘跌回公告前基准价时重新评估' });
    }
    rankCandidates(batch.stocks, ['event_catalyst']);
}
