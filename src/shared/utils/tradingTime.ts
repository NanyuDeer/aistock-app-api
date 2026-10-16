const INDEX_QUOTE_TRADING_TTL_BASE_SECONDS = 60;
const INDEX_QUOTE_TRADING_TTL_JITTER_SECONDS = 5;
const TRADING_OPEN_HOUR = 9;
const TRADING_OPEN_MINUTE = 15;
const NEXT_TRADING_SEARCH_MAX_DAYS = 30;
// 非交易时段缓存 TTL 上限，防止跨天/跨周末缓存过长导致交易日开盘后仍返回旧数据
const MAX_NON_TRADING_TTL_SECONDS = 4 * 60 * 60; // 4 小时

import { shanghaiDateTimeParts } from './shanghaiTime';
import { tradingCalendarStore } from './tradingCalendarStore';

interface ChinaDateTimeParts { year: number; month: number; day: number; hour: number; minute: number; second: number; }

export interface AShareTradingTimeOptions {
    now?: Date | number;
    /** @deprecated 不再用于节假日判定；保留字段仅为兼容既有调用方类型 */
    fetcher?: typeof fetch;
    afterCloseUpdateTime?: { hour: number; minute: number };
    /** 可选：覆盖交易日判定来源（测试注入用）；默认读 tradingCalendarStore（唯一事实源） */
    calendar?: { isTradingDay(isoDate: string): boolean };
}

/** 上海时区时间分量，统一走 shared/utils/shanghaiTime 通用函数 */
function parseChinaDateTimeParts(date: Date): ChinaDateTimeParts {
    const parts = shanghaiDateTimeParts(date);
    if (!parts) throw new Error('Failed to parse China time components');
    return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

function formatDateKey(parts: Pick<ChinaDateTimeParts, 'year' | 'month' | 'day'>): string {
    const pad = (value: number) => value.toString().padStart(2, '0');
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function isWeekendInChina(parts: Pick<ChinaDateTimeParts, 'year' | 'month' | 'day'>): boolean {
    const weekDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    return weekDay === 0 || weekDay === 6;
}

function isWithinTradingWindows(parts: Pick<ChinaDateTimeParts, 'hour' | 'minute' | 'second'>): boolean {
    const seconds = parts.hour * 3600 + parts.minute * 60 + parts.second;
    const inAuction = seconds >= (9 * 3600 + 15 * 60) && seconds <= (9 * 3600 + 25 * 60);
    const inMorning = seconds >= (9 * 3600 + 30 * 60) && seconds <= (11 * 3600 + 30 * 60);
    const inAfternoon = seconds >= (13 * 3600) && seconds <= (15 * 3600);
    return inAuction || inMorning || inAfternoon;
}

function isClosingRefreshMoment(parts: Pick<ChinaDateTimeParts, 'hour' | 'minute'>): boolean {
    return parts.hour === 15 && parts.minute === 0;
}

function normalizePositiveTtlSeconds(value: number): number {
    if (!Number.isFinite(value)) throw new Error('Invalid ttl seconds');
    return Math.max(60, Math.floor(value));
}

function addCalendarDays(parts: Pick<ChinaDateTimeParts, 'year' | 'month' | 'day'>, offset: number): Pick<ChinaDateTimeParts, 'year' | 'month' | 'day'> {
    const utcDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
    return { year: utcDate.getUTCFullYear(), month: utcDate.getUTCMonth() + 1, day: utcDate.getUTCDate() };
}

function chinaDateTimeToTimestampMs(parts: Pick<ChinaDateTimeParts, 'year' | 'month' | 'day'>, hour: number, minute: number, second = 0): number {
    return Date.UTC(parts.year, parts.month - 1, parts.day, hour - 8, minute, second);
}

async function getSecondsUntilNextTradingOpen(date: Date, calendar: { isTradingDay(isoDate: string): boolean }): Promise<number> {
    const nowMs = date.getTime();
    const chinaParts = parseChinaDateTimeParts(date);
    const today = { year: chinaParts.year, month: chinaParts.month, day: chinaParts.day };
    for (let offset = 0; offset <= NEXT_TRADING_SEARCH_MAX_DAYS; offset++) {
        const candidate = addCalendarDays(today, offset);
        if (isWeekendInChina(candidate)) continue;
        const candidateDateKey = formatDateKey(candidate);
        if (!calendar.isTradingDay(candidateDateKey)) continue;
        const openMs = chinaDateTimeToTimestampMs(candidate, TRADING_OPEN_HOUR, TRADING_OPEN_MINUTE, 0);
        if (openMs <= nowMs) continue;
        return Math.max(60, Math.ceil((openMs - nowMs) / 1000));
    }
    console.warn('[TradingTime] failed to locate next trading open day, fallback to 12h');
    return 12 * 60 * 60;
}

export async function isAShareTradingTime(options: AShareTradingTimeOptions = {}): Promise<boolean> {
    const nowInput = options.now ?? Date.now();
    const nowDate = nowInput instanceof Date ? nowInput : new Date(nowInput);
    if (Number.isNaN(nowDate.getTime())) throw new Error('Invalid date input');
    const chinaParts = parseChinaDateTimeParts(nowDate);
    if (isWeekendInChina(chinaParts)) return false;
    if (!isWithinTradingWindows(chinaParts)) return false;
    const dateKey = formatDateKey(chinaParts);
    return (options.calendar ?? tradingCalendarStore).isTradingDay(dateKey);
}

/**
 * 判断指定日期是否为A股交易日（不考虑具体时间，只判断日期）
 * @param options.now - 可选，指定日期（Date 或 timestamp），默认当前时间
 * @param options.fetcher - 已废弃，不再用于节假日判定
 * @returns true 表示是交易日（非周末、非节假日），false 表示非交易日
 */
export async function isAShareTradingDay(options: AShareTradingTimeOptions = {}): Promise<boolean> {
    const nowInput = options.now ?? Date.now();
    const nowDate = nowInput instanceof Date ? nowInput : new Date(nowInput);
    if (Number.isNaN(nowDate.getTime())) throw new Error('Invalid date input');
    const chinaParts = parseChinaDateTimeParts(nowDate);
    if (isWeekendInChina(chinaParts)) return false;
    const dateKey = formatDateKey(chinaParts);
    return (options.calendar ?? tradingCalendarStore).isTradingDay(dateKey);
}

export async function getAShareAdaptiveCacheTtlSeconds(tradingTtlSeconds: number, options: AShareTradingTimeOptions = {}): Promise<number> {
    const resolvedTradingTtlSeconds = normalizePositiveTtlSeconds(tradingTtlSeconds);
    const nowInput = options.now ?? Date.now();
    const nowDate = nowInput instanceof Date ? nowInput : new Date(nowInput);
    if (Number.isNaN(nowDate.getTime())) throw new Error('Invalid date input');
    const chinaParts = parseChinaDateTimeParts(nowDate);
    const dateKey = formatDateKey(chinaParts);
    const weekend = isWeekendInChina(chinaParts);
    const holiday = weekend || !(options.calendar ?? tradingCalendarStore).isTradingDay(dateKey);
    const inTradingWindows = isWithinTradingWindows(chinaParts);
    if (!weekend && !holiday && inTradingWindows && !isClosingRefreshMoment(chinaParts)) return resolvedTradingTtlSeconds;

    // 交易日但不在交易窗口内：计算到同一日下一个交易窗口的短 TTL，避免午休/竞价间隙产生超长缓存
    if (!weekend && !holiday) {
        const seconds = chinaParts.hour * 3600 + chinaParts.minute * 60 + chinaParts.second;

        // 盘前：00:00 - 09:15 → 缓存到 09:15 集合竞价
        if (seconds < 9 * 3600 + 15 * 60) {
            return Math.max(60, (9 * 3600 + 15 * 60) - seconds);
        }
        // 竞价与连续竞价之间：09:25 - 09:30 → 缓存到 09:30
        if (seconds >= 9 * 3600 + 25 * 60 && seconds < 9 * 3600 + 30 * 60) {
            return Math.max(60, (9 * 3600 + 30 * 60) - seconds);
        }
        // 午休：11:30 - 13:00 → 缓存到 13:00
        if (seconds >= 11 * 3600 + 30 * 60 && seconds < 13 * 3600) {
            return Math.max(60, (13 * 3600) - seconds);
        }
    }

    // 盘后定时更新逻辑：如果指定了 afterCloseUpdateTime，则计算到该时间点的 TTL
    if (options.afterCloseUpdateTime && !weekend && !holiday) {
        const { hour: updateHour, minute: updateMinute } = options.afterCloseUpdateTime;
        const nowSeconds = chinaParts.hour * 3600 + chinaParts.minute * 60 + chinaParts.second;
        const updateSeconds = updateHour * 3600 + updateMinute * 60;

        if (nowSeconds < updateSeconds) {
            // 还没到更新时间，缓存到更新时刻
            const ttl = updateSeconds - nowSeconds;
            return Math.max(60, ttl);
        }
        // 已过更新时间，缓存到次日更新时刻
        const tomorrow = addCalendarDays({ year: chinaParts.year, month: chinaParts.month, day: chinaParts.day }, 1);
        const tomorrowUpdateMs = chinaDateTimeToTimestampMs(tomorrow, updateHour, updateMinute, 0);
        const ttl = Math.ceil((tomorrowUpdateMs - nowDate.getTime()) / 1000);
        return Math.max(60, ttl);
    }

    // 非交易日（周末/节假日）或盘后无 afterCloseUpdateTime：缓存到下一交易日开盘
    // 但设置 TTL 上限，防止跨天/跨周末缓存过长导致交易日开盘后仍返回旧数据
    const nextOpenTtl = await getSecondsUntilNextTradingOpen(nowDate, options.calendar ?? tradingCalendarStore);
    return Math.min(nextOpenTtl, MAX_NON_TRADING_TTL_SECONDS);
}

export async function getAShareIndexCacheTtlSeconds(options: AShareTradingTimeOptions = {}): Promise<number> {
    const tradingTtlSeconds = INDEX_QUOTE_TRADING_TTL_BASE_SECONDS + Math.floor(Math.random() * (INDEX_QUOTE_TRADING_TTL_JITTER_SECONDS + 1));
    return getAShareAdaptiveCacheTtlSeconds(tradingTtlSeconds, options);
}
