/**
 * 交易日历服务
 *
 * **唯一事实源**：`trading_calendar` 表（由 TradingCalendarRefreshService 以 Tushare trade_cal 刷新），
 * 经 `tradingCalendarStore` 提供同步读。本文件**不再维护任何硬编码节假日表**，
 * 也**不再依赖任何第三方节假日接口**。
 *
 * 两类函数、两种降级策略（spec §5，**有意不同，勿改**）：
 * - **判断类** `isTradingDay` / `isTradingDayYyyymmdd`：数据缺失时降级为「周一~周五」+ 告警。
 *   取向：宁可假期多跑几次幂等任务，也不因缺数据让受守卫任务停摆。
 * - **日期推算类** `getRecentTradingDay` / `getPreviousTradingDay` / `getNextTradingDay` /
 *   `getRecentTradingDays`：**store 已加载但表内无该日期时抛错**（fail-closed）。
 *   取向：`modules/calendar/MarketCalendarEventService` 依赖该契约（未覆盖时保留原始日期，不抛 502）。
 *   store **未加载**时不抛错（避免冷启期调用直接崩），按降级链结果继续回溯。
 */

import { shanghaiDateTimeParts, type ShanghaiDateTimeParts } from './shanghaiTime';
import { tradingCalendarStore } from './tradingCalendarStore';

type ShanghaiCalendarDate = ShanghaiDateTimeParts;

function getShanghaiCalendarDate(date: Date): ShanghaiCalendarDate | null {
    return shanghaiDateTimeParts(date);
}

function toIso(date: ShanghaiCalendarDate): string {
    return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function previousShanghaiCalendarDate(date: ShanghaiCalendarDate): ShanghaiCalendarDate {
    const previous = new Date(Date.UTC(date.year, date.month - 1, date.day - 1));
    return {
        ...date,
        year: previous.getUTCFullYear(),
        month: previous.getUTCMonth() + 1,
        day: previous.getUTCDate(),
    };
}

function nextShanghaiCalendarDate(date: ShanghaiCalendarDate): ShanghaiCalendarDate {
    const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
    return {
        ...date,
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate(),
    };
}

function toDate(date: ShanghaiCalendarDate): Date {
    return new Date(Date.UTC(
        date.year,
        date.month - 1,
        date.day,
        date.hour - 8,
        date.minute,
        date.second,
        date.millisecond,
    ));
}

/**
 * 日期推算类函数的 fail-closed 守卫：
 * - store **已加载** 且该日期**不在**表覆盖范围 → 抛错（保留既有契约）
 * - store **未加载** → 不抛错（由降级链给出「周一~周五」结果，避免冷启期崩）
 */
function assertCoveredOrDegrade(date: ShanghaiCalendarDate): void {
    const iso = toIso(date);
    if (tradingCalendarStore.getHealth().loadedAt && !tradingCalendarStore.inCoverage(iso)) {
        throw new Error(`Trading calendar has no data for ${iso}`);
    }
}

export class TradingCalendarService {
    /** 判断 YYYYMMDD 是否为 A 股交易日（判断类 → 降级为「周一~周五」+ 告警） */
    static isTradingDayYyyymmdd(yyyymmdd: string): boolean {
        if (!/^\d{8}$/.test(yyyymmdd)) return false;
        const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
        return tradingCalendarStore.isTradingDay(iso);
    }

    /** 判断指定日期是否为 A 股交易日 */
    static isTradingDay(date: Date = new Date()): boolean {
        const calendarDate = getShanghaiCalendarDate(date);
        return calendarDate ? tradingCalendarStore.isTradingDay(toIso(calendarDate)) : false;
    }

    static getRecentTradingDay(date: Date = new Date()): Date {
        let result = getShanghaiCalendarDate(date);
        if (!result) throw new Error('Invalid date');
        assertCoveredOrDegrade(result);
        if (result.hour < 15) {
            result = previousShanghaiCalendarDate(result);
        }
        while (true) {
            assertCoveredOrDegrade(result);
            if (tradingCalendarStore.isTradingDay(toIso(result))) return toDate(result);
            result = previousShanghaiCalendarDate(result);
        }
    }

    static getPreviousTradingDay(date: Date = new Date()): Date {
        let result = getShanghaiCalendarDate(date);
        if (!result) throw new Error('Invalid date');
        assertCoveredOrDegrade(result);
        result = previousShanghaiCalendarDate(result);
        while (true) {
            assertCoveredOrDegrade(result);
            if (tradingCalendarStore.isTradingDay(toIso(result))) {
                return toDate({ ...result, hour: 8, minute: 0, second: 0, millisecond: 0 });
            }
            result = previousShanghaiCalendarDate(result);
        }
    }

    static getNextTradingDay(date: Date = new Date()): Date {
        let result = getShanghaiCalendarDate(date);
        if (!result) throw new Error('Invalid date');
        assertCoveredOrDegrade(result);
        result = nextShanghaiCalendarDate(result);
        while (true) {
            assertCoveredOrDegrade(result);
            if (tradingCalendarStore.isTradingDay(toIso(result))) {
                return toDate({ ...result, hour: 8, minute: 0, second: 0, millisecond: 0 });
            }
            result = nextShanghaiCalendarDate(result);
        }
    }

    static getRecentTradingDays(date: Date = new Date(), count: number): Date[] {
        if (!Number.isInteger(count) || count < 1) count = 1;
        let result = getShanghaiCalendarDate(date);
        if (!result) throw new Error('Invalid date');
        assertCoveredOrDegrade(result);
        while (true) {
            assertCoveredOrDegrade(result);
            if (tradingCalendarStore.isTradingDay(toIso(result))) break;
            result = previousShanghaiCalendarDate(result);
        }
        const days: Date[] = [];
        for (let i = 0; i < count; i++) {
            days.push(toDate({ ...result, hour: 8, minute: 0, second: 0, millisecond: 0 }));
            result = previousShanghaiCalendarDate(result);
            while (true) {
                assertCoveredOrDegrade(result);
                if (tradingCalendarStore.isTradingDay(toIso(result))) break;
                result = previousShanghaiCalendarDate(result);
            }
        }
        return days;
    }

    /** 快讯时间窗口（**逻辑逐字保留，仅数据源换成新日历**） */
    static getDynamicWindowHours(): number {
        const now = new Date();

        if (!this.isTradingDay(now)) {
            // 非交易日：3天窗口
            return 72;
        }

        const hour = now.getHours();
        if (hour >= 9 && hour < 15) {
            // 交易日盘中：2小时
            return 2;
        } else if (hour >= 15) {
            // 交易日盘后：6小时
            return 6;
        } else {
            // 交易日盘前：12小时
            return 12;
        }
    }

    /** 飞书消息查询窗口（**逻辑逐字保留**） */
    static getFeishuWindowHours(): number {
        return this.isTradingDay() ? 24 : 72;
    }
}
