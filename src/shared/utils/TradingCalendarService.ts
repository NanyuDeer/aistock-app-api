/**
 * 交易日历服务
 *
 * 提供A股交易日判断，基于周末规则 + 按年度维护的休市日历。
 * 收盘快照只信任已覆盖年度；新年度日历未更新时必须失败关闭。
 */

/** A 股休市日历，按年度随官方休市安排更新。 */
const A_SHARE_HOLIDAYS_BY_YEAR: Readonly<Partial<Record<number, ReadonlySet<string>>>> = {
    2026: new Set([
        '2026-01-01', '2026-01-02', '2026-01-03', // 元旦
        '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', // 春节
        '2026-04-04', '2026-04-05', '2026-04-06', // 清明
        '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
        '2026-06-19', '2026-06-20', '2026-06-21', // 端午
        '2026-09-25', '2026-09-26', '2026-09-27', // 中秋
        '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', // 国庆
    ]),
};

const SHANGHAI_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
});

interface ShanghaiCalendarDate {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
}

function getShanghaiCalendarDate(date: Date): ShanghaiCalendarDate | null {
    if (Number.isNaN(date.getTime())) return null;

    const values = Object.fromEntries(
        SHANGHAI_DATE_TIME_FORMATTER.formatToParts(date)
            .filter(part => part.type !== 'literal')
            .map(part => [part.type, Number(part.value)]),
    );
    const { year, month, day, hour, minute, second } = values;
    if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;

    return { year, month, day, hour, minute, second, millisecond: date.getUTCMilliseconds() };
}

function toYyyymmdd(date: ShanghaiCalendarDate): string {
    return `${date.year}${String(date.month).padStart(2, '0')}${String(date.day).padStart(2, '0')}`;
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

export class TradingCalendarService {
    /**
     * 判断 YYYYMMDD 指定的 A 股交易日。
     * 日期已由调用方在目标时区归一化，因此使用 UTC 星期避免服务器本地时区影响。
     */
    static isTradingDayYyyymmdd(yyyymmdd: string): boolean {
        if (!/^\d{8}$/.test(yyyymmdd)) return false;

        const year = Number(yyyymmdd.slice(0, 4));
        const month = Number(yyyymmdd.slice(4, 6));
        const day = Number(yyyymmdd.slice(6, 8));
        const holidays = A_SHARE_HOLIDAYS_BY_YEAR[year];
        if (!holidays) return false;

        const date = new Date(Date.UTC(year, month - 1, day));
        if (
            date.getUTCFullYear() !== year
            || date.getUTCMonth() !== month - 1
            || date.getUTCDate() !== day
        ) return false;

        const weekday = date.getUTCDay();

        if (weekday === 0 || weekday === 6) return false;

        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        return !holidays.has(dateStr);
    }

    /**
     * 判断指定日期是否为A股交易日
     */
    static isTradingDay(date: Date = new Date()): boolean {
        // 周六、周日不交易
        const calendarDate = getShanghaiCalendarDate(date);
        return calendarDate ? this.isTradingDayYyyymmdd(toYyyymmdd(calendarDate)) : false;
    }

    /**
     * 获取最近的一个交易日（向前回溯）
     * 如果今天是交易日且在收盘后（15:00之后），返回今天
     * 如果今天不是交易日或在盘中，返回上一个交易日
     */
    static getRecentTradingDay(date: Date = new Date()): Date {
        let result = getShanghaiCalendarDate(date);
        if (!result) throw new Error('Invalid date');
        this.assertCalendarCoverage(result.year);
        // 如果在盘中（<15:00），回溯到上一个交易日
        if (result.hour < 15) {
            result = previousShanghaiCalendarDate(result);
        }
        while (true) {
            this.assertCalendarCoverage(result.year);
            if (this.isTradingDayYyyymmdd(toYyyymmdd(result))) return toDate(result);
            result = previousShanghaiCalendarDate(result);
        }
    }

    private static assertCalendarCoverage(year: number): void {
        if (!A_SHARE_HOLIDAYS_BY_YEAR[year]) {
            throw new Error(`Trading calendar is not available for ${year}`);
        }
    }

    /**
     * 根据当前时间动态计算快讯时间窗口（小时）
     *
     * 策略：
     * - 交易日盘中（9:30-15:00）：2小时（保持灵敏度）
     * - 交易日盘后（15:00-24:00）：6小时（覆盖盘后资讯）
     * - 交易日盘前（0:00-9:30）：12小时（覆盖前一日夜间资讯）
     * - 非交易日（周末/节假日）：72小时（3天，覆盖到上一个交易日）
     */
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

    /**
     * 获取飞书消息查询窗口（小时）
     *
     * 策略：
     * - 交易日：24小时（覆盖前一日讨论）
     * - 非交易日：72小时（3天滚动窗口）
     */
    static getFeishuWindowHours(): number {
        return this.isTradingDay() ? 24 : 72;
    }
}
