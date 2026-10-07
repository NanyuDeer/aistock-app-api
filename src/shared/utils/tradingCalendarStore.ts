/**
 * 交易日历内存缓存 —— 全仓**唯一**给出"是否交易日"判定（同步可读）的地方。
 *
 * 数据来自 `trading_calendar` 表（由 TradingCalendarRefreshService 以 Tushare trade_cal 刷新）。
 * 三级降级链（spec §5）：
 *   1. 已加载 且 命中覆盖范围 → 表内 is_open（权威）
 *   2. 已加载 但 超范围      → 「周一~周五」+ console.error（同一日期只告警一次）
 *   3. 未加载                → 「周一~周五」+ console.warn（每进程只告警一次）
 * 降级**绝不静默**：必有 warn/error，且 getHealth().degraded 置真。
 *
 * 为什么降级退化为「周一~周五」而不是判非交易日：见 spec §5 —— 避免"年末忘补表导致
 * 所有受守卫任务停摆一整年"；宁可假期多跑几次幂等任务（有告警可查）。
 */
import pool from '../../core/db';
import { TradingCalendarRefreshService } from '../../modules/market/TradingCalendarRefreshService';

export interface CalendarHealth {
    loadedAt: string | null;
    minDate: string | null;
    maxDate: string | null;
    lastRefreshAt: string | null;
    lastRefreshError: string | null;
    degraded: boolean;
}

export const __tradingCalendarStoreDependencies = {
    query: (sql: string) => pool.query(sql),
};

const SELECT_SQL = `
    SELECT cal_date, is_open, pretrade_date
      FROM trading_calendar
     WHERE exchange = 'SSE'
     ORDER BY cal_date
`;

let calendar = new Map<string, boolean>();
let pretrade = new Map<string, string | null>();
let minDate: string | null = null;
let maxDate: string | null = null;
let loadedAt: string | null = null;
let lastRefreshAt: string | null = null;
let lastRefreshError: string | null = null;
let outOfRangeWarned = new Set<string>();
let outOfRangeHit = false;
let unloadedWarned = false;

/** 仅按周一到周五判断（降级链用）。用 UTC 星期，免受服务器本地时区影响。 */
export function isWeekday(isoDate: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false;
    const y = Number(isoDate.slice(0, 4));
    const m = Number(isoDate.slice(5, 7));
    const d = Number(isoDate.slice(8, 10));
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
    const weekday = date.getUTCDay();
    return weekday !== 0 && weekday !== 6;
}

/** pg 返回的 DATE 可能是 Date 或 'YYYY-MM-DD' 字符串，统一归一为 ISO 日期 */
function toIso(value: unknown): string {
    if (value instanceof Date) {
        // pg(postgres-date) 把裸 DATE 按本地时间解析为**本地午夜**；
        // 用 toISOString() 会在 UTC+8 下整体前移一天，故必须用本地字段拼装。
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    return String(value).slice(0, 10);
}

export const tradingCalendarStore = {
    /** 从表加载进内存，并触发一次刷新（refresh 自身已吞错并告警） */
    async load(now: Date = new Date()): Promise<void> {
        try {
            const result = await __tradingCalendarStoreDependencies.query(SELECT_SQL);
            const rows = result.rows as Array<{ cal_date: unknown; is_open: unknown; pretrade_date: unknown }>;
            const next = new Map<string, boolean>();
            const nextPrev = new Map<string, string | null>();
            for (const row of rows) {
                const iso = toIso(row.cal_date);
                next.set(iso, Boolean(row.is_open));
                nextPrev.set(iso, row.pretrade_date ? toIso(row.pretrade_date) : null);
            }
            calendar = next;
            pretrade = nextPrev;
            outOfRangeWarned = new Set<string>();
            outOfRangeHit = false;
            loadedAt = new Date().toISOString();
            const dates = Array.from(next.keys()).sort();
            minDate = dates.length ? dates[0] : null;
            maxDate = dates.length ? dates[dates.length - 1] : null;
            console.log(`[TradingCalendar] 已加载 ${next.size} 天 range=${minDate}~${maxDate}`);
        } catch (err: unknown) {
            lastRefreshError = err instanceof Error ? err.message : String(err);
            console.error('[TradingCalendar] 加载失败（降级链生效）:', lastRefreshError);
        }
        try {
            await TradingCalendarRefreshService.refresh(now);
            lastRefreshAt = new Date().toISOString();
        } catch (err: unknown) {
            lastRefreshError = err instanceof Error ? err.message : String(err);
        }
    },

    /** 该日期是否落在已加载的范围 [minDate, maxDate] 内 */
    inCoverage(isoDate: string): boolean {
        if (!loadedAt || !minDate || !maxDate) return false;
        return isoDate >= minDate && isoDate <= maxDate;
    },

    /** 同步判定；三级降级链，降级必有告警 */
    isTradingDay(isoDate: string): boolean {
        if (loadedAt && minDate && maxDate) {
            const value = calendar.get(isoDate);
            if (value !== undefined) return value;   // 第 1 级：权威
            outOfRangeHit = true;                     // 第 2 级：已加载但表内无该日期
            if (!outOfRangeWarned.has(isoDate)) {
                outOfRangeWarned.add(isoDate);
                console.error(
                    `[TradingCalendar] 表内无该日期，降级按「周一~周五」判定 cal_date=${isoDate} range=${minDate}~${maxDate}`,
                );
            }
            return isWeekday(isoDate);
        }
        if (!unloadedWarned) {                        // 第 3 级：尚未加载
            unloadedWarned = true;
            console.warn(`[TradingCalendar] 日历尚未加载，降级按「周一~周五」判定 cal_date=${isoDate}（本进程仅告警一次）`);
        }
        return isWeekday(isoDate);
    },

    /** 表内记录的"上一个交易日"；无数据返回 null */
    getPretradeDate(isoDate: string): string | null {
        return pretrade.get(isoDate) ?? null;
    },

    getHealth(): CalendarHealth {
        return {
            loadedAt,
            minDate,
            maxDate,
            lastRefreshAt,
            lastRefreshError,
            degraded: !loadedAt || outOfRangeHit || Boolean(lastRefreshError),
        };
    },

    /** 仅测试用：清空全部模块级状态 */
    __resetForTest(): void {
        calendar = new Map();
        pretrade = new Map();
        minDate = null;
        maxDate = null;
        loadedAt = null;
        lastRefreshAt = null;
        lastRefreshError = null;
        outOfRangeWarned = new Set();
        outOfRangeHit = false;
        unloadedWarned = false;
    },

    /** 仅测试用：直接注入日历数据，避免测试依赖 DB 与 Tushare */
    __setForTest(map: Record<string, boolean>, min: string, max: string): void {
        calendar = new Map(Object.entries(map));
        pretrade = new Map();
        minDate = min;
        maxDate = max;
        loadedAt = new Date().toISOString();
        lastRefreshAt = null;
        lastRefreshError = null;
        outOfRangeWarned = new Set();
        outOfRangeHit = false;
        unloadedWarned = false;
    },
};
