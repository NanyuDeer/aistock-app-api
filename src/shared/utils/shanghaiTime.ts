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

/**
 * 匹配**不带时区**的北京时间串：`YYYY-MM-DD HH:mm[:ss[.SSS]]`（日期与时间之间允许空格或 T）。
 * 仅日期（`YYYY-MM-DD`）、带时区（`Z` / `±HH:MM`）的串不匹配，由调用方按各自语义处理。
 */
const NAIVE_BEIJING_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/**
 * 将**裸北京墙钟串**补上固定偏移 `+08:00`，得到带时区的 ISO 串；不匹配则**原样返回**。
 *
 * 为什么：上游（事件库 `scrape_at`、财联社 `time`、公告 `published_at`）给的是不带时区的
 * 北京时间串，直接 `new Date(text)` 会按**宿主机时区**解释 —— UTC 容器/runner 上整体偏移
 * +8 小时（中国无夏令时，固定 +08:00 成立）。先补偏移再解析即可与宿主机时区无关。
 *
 * 边界：带时区（`Z` / `±HH:MM`）或仅日期的串不匹配 → 原样返回（交给 `new Date` 按规范解释，
 * 语义与改动前一致）；本函数**不做 trim**，首尾空白由调用方负责（既有调用点均已 `.trim()`）。
 *
 * 例：`'2026-08-12 10:00:00' -> '2026-08-12T10:00:00+08:00'`；
 *     `'2026-08-12T10:00:00Z' -> 原样`；`'2026-08-12' -> 原样`。
 */
export function asBeijingAwareText(text: string): string {
    const matched = NAIVE_BEIJING_DATETIME.exec(text);
    if (!matched) return text;
    const [, datePart, hourMinute, second, millisecond] = matched;
    return `${datePart}T${hourMinute}:${second ?? '00'}${millisecond ? `.${millisecond}` : ''}+08:00`;
}
