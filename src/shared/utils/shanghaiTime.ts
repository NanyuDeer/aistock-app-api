/**
 * 上海时区时间工具 — 项目统一的 Asia/Shanghai 时区日期/时间转换函数。
 *
 * 为什么需要：服务器可能运行在 UTC 或其他时区，直接用 `new Date().toISOString()`（UTC）
 * 会在北京时间凌晨 0-8 点错位成前一天（如 2026-08-06 02:45 写成 08-05 的线上事故）。
 * 所有"今日/交易日/归档日期"必须经本文件函数转成上海时区再使用。
 *
 * 使用 Intl.DateTimeFormat + formatToParts 而非手算偏移，避免夏令时/历史时区边界误差。
 */

const SHANGHAI_FULL_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
});

export interface ShanghaiDateTimeParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
}

/** 取上海时区的完整时间分量（年/月/日/时/分/秒/毫秒）。非法 Date 返回 null。 */
export function shanghaiDateTimeParts(date: Date = new Date()): ShanghaiDateTimeParts | null {
    if (Number.isNaN(date.getTime())) return null;
    const values = Object.fromEntries(
        SHANGHAI_FULL_FORMATTER.formatToParts(date)
            .filter(part => part.type !== 'literal')
            .map(part => [part.type, Number(part.value)]),
    );
    const { year, month, day, hour, minute, second } = values;
    if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
    return { year, month, day, hour, minute, second, millisecond: date.getUTCMilliseconds() };
}

/** 上海时区日期 YYYY-MM-DD（如 2026-08-06）。 */
export function shanghaiDateStr(date: Date = new Date()): string {
    const parts = shanghaiDateTimeParts(date);
    if (!parts) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** 上海时区日期 YYYYMMDD（如 20260806）。 */
export function shanghaiDateYyyymmdd(date: Date = new Date()): string {
    return shanghaiDateStr(date).replace(/-/g, '');
}

/** 上海时区的 { hour, minute }（用于收盘门禁等分钟级判断）。 */
export function shanghaiHourMinute(date: Date = new Date()): { hour: number; minute: number } {
    const parts = shanghaiDateTimeParts(date);
    return { hour: parts?.hour ?? 0, minute: parts?.minute ?? 0 };
}

/** 上海时区完整时间 YYYY-MM-DD HH:mm:ss（timestamp 为毫秒时间戳，默认当前时刻）。 */
export function shanghaiDateTimeStr(timestamp: number = Date.now()): string {
    return shanghaiDateTimeMsStr(timestamp).slice(0, 19);
}

/** 上海时区完整时间 YYYY-MM-DD HH:mm:ss.SSS（timestamp 为毫秒时间戳，默认当前时刻）。 */
export function shanghaiDateTimeMsStr(timestamp: number = Date.now()): string {
    const parts = shanghaiDateTimeParts(new Date(timestamp));
    if (!parts) return '';
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const pad3 = (n: number) => String(n).padStart(3, '0');
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ` +
        `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}.${pad3(parts.millisecond)}`;
}
