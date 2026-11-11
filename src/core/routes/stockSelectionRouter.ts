import { Router } from 'express';
import { createResponse } from '../../shared/utils/response';
import { shanghaiDateStr, shanghaiHourMinute } from '../../shared/utils/shanghaiTime';
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService';
import { tradingCalendarStore } from '../../shared/utils/tradingCalendarStore';
import { selectionStocks, selectionMarketDay, selectionBenchmark, selectionUpperLimits, selectionAnnualFinancials, selectionDailyRatios, selectionDividends, selectionResearch, selectionCompanyForecasts } from '../../modules/quote/SelectionMarketData';
import { SelectionService, parseQuery } from '../../modules/stock-selection/SelectionService';
import { PostgresSelectionStore } from '../../modules/stock-selection/SelectionStore';
import { HISTORY_DAYS } from '../../modules/stock-selection/types';

class CalendarUnavailableError extends Error {
    readonly code = 'CALENDAR_UNAVAILABLE';
}
function assertCalendarRange(start: string, end: string): void {
    for (let day = new Date(`${start}T00:00:00Z`); day.toISOString().slice(0, 10) <= end; day.setUTCDate(day.getUTCDate() + 1)) {
        if (!tradingCalendarStore.hasDate(day.toISOString().slice(0, 10))) throw new CalendarUnavailableError('选股所需交易日历记录不完整');
    }
}
export function selectionTradeDate(now = new Date()): string {
    const today = shanghaiDateStr(now);
    if (!tradingCalendarStore.hasDate(today)) throw new CalendarUnavailableError('权威交易日历尚未就绪');
    const clock = shanghaiHourMinute(now);
    // Daily is published 15:00–16:00. Leave a buffer; before 16:30 use the preceding session.
    const reference = clock.hour * 60 + clock.minute < 990 ? new Date(`${today}T14:00:00+08:00`) : now;
    try {
        const tradeDate = shanghaiDateStr(TradingCalendarService.getRecentTradingDay(reference));
        assertCalendarRange(tradeDate, today);
        return tradeDate;
    } catch { throw new CalendarUnavailableError('权威交易日历记录不足，无法确定最近盘后交易日'); }
}
export function selectionContext(now = new Date()) {
    const tradeDate = selectionTradeDate(now);
    try {
        const dates = TradingCalendarService.getRecentTradingDays(new Date(`${tradeDate}T16:30:00+08:00`), HISTORY_DAYS).map(shanghaiDateStr).reverse();
        assertCalendarRange(dates[0], tradeDate);
        return { tradeDate, dates };
    } catch { throw new CalendarUnavailableError('权威交易日历历史覆盖不足，无法生成90交易日选股特征'); }
}
export function nextQuoteTradeDate(date: string): string | null {
    if (!tradingCalendarStore.hasDate(date)) return null;
    try {
        const next = shanghaiDateStr(TradingCalendarService.getNextTradingDay(new Date(`${date}T16:30:00+08:00`)));
        assertCalendarRange(date, next);
        return next;
    } catch {
        return null;
    }
}

const store = new PostgresSelectionStore();
export const stockSelectionService = new SelectionService(store, {
    context: () => selectionContext(), nextTradingDate: nextQuoteTradeDate, stocks: selectionStocks, day: selectionMarketDay, upperLimits: selectionUpperLimits, financials: selectionAnnualFinancials, ratios: selectionDailyRatios, dividends: selectionDividends,
    research: selectionResearch, companyForecasts: selectionCompanyForecasts, benchmark: selectionBenchmark,
});
export const ensureStockSelectionSchema = () => store.ensureSchema();
export const triggerStockSelection = () => stockSelectionService.generate();
export const stockSelectionRouter: Router = Router();
stockSelectionRouter.get('/results', async (req, res) => {
    let query;
    try { query = parseQuery(req.query); }
    catch (e) { createResponse(res, 400, e instanceof Error ? e.message : '参数错误'); return; }
    try { createResponse(res, 200, 'success', await stockSelectionService.results(query)); }
    catch (e) {
        console.error('[StockSelection] read failed:', e);
        const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
        const reasonCode = code === 'CALENDAR_UNAVAILABLE' ? code
            : /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|08\w{3}|28\w{3}|42\w{3}|53\w{3}|57\w{3})$/.test(code) ? 'DATABASE_UNAVAILABLE' : 'RESULTS_UNAVAILABLE';
        const message = reasonCode === 'CALENDAR_UNAVAILABLE' ? '选股交易日历尚未就绪，请稍后刷新'
            : reasonCode === 'DATABASE_UNAVAILABLE' ? '选股数据库暂不可用，请检查数据库连接及表权限' : '盘后选股数据暂不可用，请稍后重试';
        createResponse(res, 503, message, { reasonCode });
    }
});
stockSelectionRouter.post('/generate', async (req, res) => {
    const expected = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN;
    if (!expected || req.headers['x-internal-token'] !== expected) { createResponse(res, 403, '仅允许内部任务生成'); return; }
    // No client-supplied dates/universe: this release cannot reconstruct historical stock metadata.
    if (req.body && Object.keys(req.body).length) { createResponse(res, 400, '仅生成最近完整盘后交易日，不接受自定义参数'); return; }
    res.status(202).json({ code: 202, message: '盘后选股任务已接受', data: { status: 'generating' } });
    void triggerStockSelection().catch(e => console.error('[StockSelection] manual generation failed:', e));
});
