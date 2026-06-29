const TIMOR_HOLIDAY_API_BASE = 'https://timor.tech/api/holiday/info/';
const HOLIDAY_REQUEST_TIMEOUT_MS = 3500;
const INDEX_QUOTE_TRADING_TTL_BASE_SECONDS = 60;
const INDEX_QUOTE_TRADING_TTL_JITTER_SECONDS = 5;
const TRADING_OPEN_HOUR = 9;
const TRADING_OPEN_MINUTE = 15;
const NEXT_TRADING_SEARCH_MAX_DAYS = 30;

interface HolidayApiResponse {
    code: number;
    holiday: { holiday: boolean; name?: string; wage?: number; after?: boolean; target?: string; } | null;
}

interface ChinaDateTimeParts { year: number; month: number; day: number; hour: number; minute: number; second: number; }

export interface AShareTradingTimeOptions { now?: Date | number; fetcher?: typeof fetch; afterCloseUpdateTime?: { hour: number; minute: number }; }

const chinaDateFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, hourCycle: 'h23',
});

const holidayCache = new Map<string, boolean>();

function parseChinaDateTimeParts(date: Date): ChinaDateTimeParts {
    const parts = chinaDateFormatter.formatToParts(date);
    const partMap: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const part of parts) { if (part.type !== 'literal') partMap[part.type] = part.value; }
    const year = Number(partMap.year), month = Number(partMap.month), day = Number(partMap.day);
    const hour = Number(partMap.hour), minute = Number(partMap.minute), second = Number(partMap.second);
    if (![year, month, day, hour, minute, second].every(Number.isFinite)) throw new Error('Failed to parse China time components');
    return { year, month, day, hour, minute, second };
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

async function isChinaHoliday(dateKey: string, fetcher: typeof fetch): Promise<boolean> {
    const cached = holidayCache.get(dateKey);
    if (cached !== undefined) return cached;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HOLIDAY_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetcher(`${TIMOR_HOLIDAY_API_BASE}${dateKey}`, { method: 'GET', headers: { 'Accept': 'application/json' }, signal: controller.signal });
        if (!response.ok) { console.error(`[TradingTime] Holiday API failed: ${response.status}`); return true; }
        const data = await response.json() as HolidayApiResponse;
        if (data.code !== 0) { console.error(`[TradingTime] Holiday API returned code: ${data.code}`); return true; }
        const isHoliday = Boolean(data.holiday && data.holiday.holiday === true);
        holidayCache.set(dateKey, isHoliday);
        return isHoliday;
    } catch (err) { console.error('[TradingTime] Holiday API request error:', err); return true; }
    finally { clearTimeout(timer); }
}

async function getSecondsUntilNextTradingOpen(date: Date, fetcher: typeof fetch): Promise<number> {
    const nowMs = date.getTime();
    const chinaParts = parseChinaDateTimeParts(date);
    const today = { year: chinaParts.year, month: chinaParts.month, day: chinaParts.day };
    for (let offset = 0; offset <= NEXT_TRADING_SEARCH_MAX_DAYS; offset++) {
        const candidate = addCalendarDays(today, offset);
        if (isWeekendInChina(candidate)) continue;
        const candidateDateKey = formatDateKey(candidate);
        const holiday = await isChinaHoliday(candidateDateKey, fetcher);
        if (holiday) continue;
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
    const fetcher = options.fetcher ?? fetch;
    if (Number.isNaN(nowDate.getTime())) throw new Error('Invalid date input');
    const chinaParts = parseChinaDateTimeParts(nowDate);
    if (isWeekendInChina(chinaParts)) return false;
    if (!isWithinTradingWindows(chinaParts)) return false;
    const dateKey = formatDateKey(chinaParts);
    const holiday = await isChinaHoliday(dateKey, fetcher);
    return !holiday;
}

/**
 * 判断指定日期是否为A股交易日（不考虑具体时间，只判断日期）
 * @param options.now - 可选，指定日期（Date 或 timestamp），默认当前时间
 * @param options.fetcher - 可选，自定义 fetch 函数
 * @returns true 表示是交易日（非周末、非节假日），false 表示非交易日
 */
export async function isAShareTradingDay(options: AShareTradingTimeOptions = {}): Promise<boolean> {
    const nowInput = options.now ?? Date.now();
    const nowDate = nowInput instanceof Date ? nowInput : new Date(nowInput);
    const fetcher = options.fetcher ?? fetch;
    if (Number.isNaN(nowDate.getTime())) throw new Error('Invalid date input');
    const chinaParts = parseChinaDateTimeParts(nowDate);
    if (isWeekendInChina(chinaParts)) return false;
    const dateKey = formatDateKey(chinaParts);
    const holiday = await isChinaHoliday(dateKey, fetcher);
    return !holiday;
}

export async function getAShareAdaptiveCacheTtlSeconds(tradingTtlSeconds: number, options: AShareTradingTimeOptions = {}): Promise<number> {
    const resolvedTradingTtlSeconds = normalizePositiveTtlSeconds(tradingTtlSeconds);
    const nowInput = options.now ?? Date.now();
    const nowDate = nowInput instanceof Date ? nowInput : new Date(nowInput);
    const fetcher = options.fetcher ?? fetch;
    if (Number.isNaN(nowDate.getTime())) throw new Error('Invalid date input');
    const chinaParts = parseChinaDateTimeParts(nowDate);
    const dateKey = formatDateKey(chinaParts);
    const weekend = isWeekendInChina(chinaParts);
    const holiday = weekend ? true : await isChinaHoliday(dateKey, fetcher);
    const inTradingWindows = isWithinTradingWindows(chinaParts);
    if (!weekend && !holiday && inTradingWindows && !isClosingRefreshMoment(chinaParts)) return resolvedTradingTtlSeconds;

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

    return getSecondsUntilNextTradingOpen(nowDate, fetcher);
}

export async function getAShareIndexCacheTtlSeconds(options: AShareTradingTimeOptions = {}): Promise<number> {
    const tradingTtlSeconds = INDEX_QUOTE_TRADING_TTL_BASE_SECONDS + Math.floor(Math.random() * (INDEX_QUOTE_TRADING_TTL_JITTER_SECONDS + 1));
    return getAShareAdaptiveCacheTtlSeconds(tradingTtlSeconds, options);
}
