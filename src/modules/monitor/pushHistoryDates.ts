type PushHistoryDateSource = {
    push_id?: unknown;
    push_batch_id?: unknown;
    push_time?: unknown;
    push_date?: unknown;
    latest_trade_date?: unknown;
};

function isValidDateParts(year: number, month: number, day: number): boolean {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

export function normalizeDateOnly(value: unknown): string | null {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const year = value.getFullYear();
        const month = value.getMonth() + 1;
        const day = value.getDate();
        return isValidDateParts(year, month, day)
            ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
            : null;
    }

    const text = String(value ?? '').trim();
    if (!text) return null;

    const compactMatch = text.match(/^(\d{4})(\d{2})(\d{2})(?:\d{6})?$/);
    const separatedMatch = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    const match = compactMatch || separatedMatch;
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!isValidDateParts(year, month, day)) return null;

    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateFromPushIdentity(value: unknown): string | null {
    const text = String(value ?? '').trim();
    const match = text.match(/^windleader_(\d{8})(?:_|$)/);
    return match ? normalizeDateOnly(match[1]) : null;
}

export function resolvePushDate(record: PushHistoryDateSource): string {
    return dateFromPushIdentity(record.push_id)
        || dateFromPushIdentity(record.push_batch_id)
        || normalizeDateOnly(record.push_time)
        || normalizeDateOnly(record.push_date)
        || '';
}

export function normalizePushHistoryRecord<T extends PushHistoryDateSource>(record: T): T & {
    push_date: string;
    latest_trade_date: string;
} {
    const pushDate = resolvePushDate(record);
    return {
        ...record,
        push_date: pushDate,
        latest_trade_date: normalizeDateOnly(record.latest_trade_date) || pushDate,
    };
}

export function getQuoteTradeDate(quote: Record<string, unknown> | undefined): string | null {
    return normalizeDateOnly(quote?.['行情时间']);
}
