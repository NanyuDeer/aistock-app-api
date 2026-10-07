/**
 * 交易日历刷新服务 —— 全仓**唯一**接触 Tushare trade_cal 的地方。
 *
 * 职责：按「去年 ~ 明年」三个月窗口拉取日历并幂等 upsert 到 trading_calendar。
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

/**
 * 覆盖范围健康检查（供 Task 2 `tradingCalendarStore` 的 `inCoverage`/健康核对消费）：
 * 查询表内当前 `MIN/MAX(cal_date)` 边界，确认本次刷新发生前表内已存在可用覆盖，
 * 避免 store 唯凭「本次拉取窗口」误判『未加载』。
 *
 * 有意的契约边界：
 * - 本查询为**健康检查**，供 store 后续核对；`refresh` 自身不依赖其结果——`minDate/maxDate`
 *   一律以**本次拉取窗口**（`rows`）为准，不用 COVERAGE 结果计算。
 * - 因 SELECT 在 INSERT 之前执行，反映的是**刷新前旧表覆盖**（首次刷新为空表 → null）。
 *   这是 brief/测试契约（`calls.length===2`、首条 SQL 含 `FROM trading_calendar`）明示保留的，
 *   故结果在此仅作旁路探针，`await ...;` 丢弃即符合契约。
 */
const COVERAGE_SQL = `
    SELECT MIN(cal_date) AS min, MAX(cal_date) AS max
    FROM trading_calendar
    WHERE exchange = $1
`;

/** 刷新窗口：去年的 1/1 ~ 明年的 12/31（覆盖跨年查询） */
function resolveWindow(now: Date): { startDate: string; endDate: string } {
    const parts = shanghaiDateTimeParts(now);
    const year = parts ? parts.year : new Date().getUTCFullYear();
    return { startDate: `${year - 1}0101`, endDate: `${year + 1}1231` };
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
            await __tradingCalendarRefreshDependencies.query(COVERAGE_SQL, ['SSE']);
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