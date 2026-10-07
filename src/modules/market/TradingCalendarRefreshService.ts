/**
 * 交易日历刷新服务 —— 全仓**唯一**接触 Tushare trade_cal 的地方。
 *
 * 职责：按「前年 ~ 明年」窗口拉取日历并幂等 upsert 到 trading_calendar。
 * 失败策略：任何失败只告警不抛（保留表内旧数据继续服务），刷新健康信息记入 store（Task 2）。
 * 见 spec §4.2。
 */
import { tushareRequest, mapTradeCalRows } from '../quote/TushareService';
import pool from '../../core/db';
import { shanghaiDateTimeParts } from '../../shared/utils/shanghaiTime';

/**
 * 可替换依赖（测试注入点）。约定：
 * - `request`：以 `(apiName, params)` 调用 trade_cal，返回**原始** Tushare 行（YYYYMMDD/0/1 字符串），
 *   由本服务 `mapTradeCalRows` 统一映射，保证测试 mock 与生产链路语义一致。
 * - `query`：数据库查询。
 * - `now`：当前时间（默认取真实当前时刻；测试可注入）。
 */
export const __tradingCalendarRefreshDependencies = {
    request: (apiName: string, params: Record<string, unknown>) =>
        tushareRequest(apiName, params, 'exchange,cal_date,is_open,pretrade_date'),
    query: (sql: string, params?: unknown[]) => pool.query(sql, params as never[]),
    now: () => new Date(),
};

const UPSERT_SQL = `
    INSERT INTO trading_calendar (exchange, cal_date, is_open, pretrade_date, updated_at)
    VALUES ($1, $2::date, $3, $4::date, CURRENT_TIMESTAMP)
    ON CONFLICT (exchange, cal_date) DO UPDATE SET
        is_open = EXCLUDED.is_open,
        pretrade_date = EXCLUDED.pretrade_date,
        updated_at = CURRENT_TIMESTAMP
`;

/** 刷新窗口：前年的 1/1 ~ 明年的 12/31（覆盖跨年查询） */
function resolveWindow(now: Date): { startDate: string; endDate: string } {
    const parts = shanghaiDateTimeParts(now);
    const year = parts ? parts.year : new Date().getUTCFullYear();
    return { startDate: `${year - 2}0101`, endDate: `${year + 1}1231` };
}

export class TradingCalendarRefreshService {
    static async refresh(now: Date = __tradingCalendarRefreshDependencies.now()): Promise<{
        fetched: number; upserted: number; minDate: string | null; maxDate: string | null;
    }> {
        const { startDate, endDate } = resolveWindow(now);
        const empty = { fetched: 0, upserted: 0, minDate: null, maxDate: null };
        try {
            const rawRows = await __tradingCalendarRefreshDependencies.request('trade_cal', {
                exchange: 'SSE',
                start_date: startDate,
                end_date: endDate,
            });
            if (rawRows.length === 0) {
                // 窗口内确无数据：属正常（非错误），不告警
                console.log(`[TradingCalendarRefresh] trade_cal 返回 0 行 window=${startDate}~${endDate}`);
                return empty;
            }
            const rows = mapTradeCalRows(rawRows as Record<string, unknown>[]);
            let upserted = 0;
            for (const row of rows) {
                await __tradingCalendarRefreshDependencies.query(UPSERT_SQL, [
                    row.exchange, row.cal_date, row.is_open, row.pretrade_date,
                ]);
                upserted += 1;
            }
            const dates = rows.map(r => r.cal_date).sort();
            const minDate = dates[0];
            const maxDate = dates[dates.length - 1];
            console.log(`[TradingCalendarRefresh] 完成 fetched=${rows.length} upserted=${upserted} range=${minDate}~${maxDate}`);
            return { fetched: rows.length, upserted, minDate, maxDate };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[TradingCalendarRefresh] 刷新失败（保留旧数据）: ${msg}`);
            return empty;
        }
    }
}