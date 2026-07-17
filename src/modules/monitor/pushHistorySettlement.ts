import { TradingCalendarService } from '../../shared/utils/TradingCalendarService';
import { normalizeDateOnly } from './pushHistoryDates';

export type PushHistorySettlementRecord = {
    push_date?: unknown;
    latest_trade_date?: unknown;
    push_price?: unknown;
    latest_price?: unknown;
    realtime_time?: unknown;
};

type ShanghaiDateTime = {
    date: string;
    minutes: number;
};

const CLOSE_SETTLEMENT_MINUTES = 15 * 60 + 30;
const SHANGHAI_FORMATTER = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

function getShanghaiDateTime(now: Date): ShanghaiDateTime {
    const parts = Object.fromEntries(
        SHANGHAI_FORMATTER.formatToParts(now).map(part => [part.type, part.value]),
    );
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
}

function dateAtShanghaiNoon(date: string): Date {
    return new Date(`${date}T12:00:00+08:00`);
}

function previousDate(date: string): string {
    const value = dateAtShanghaiNoon(date);
    value.setUTCDate(value.getUTCDate() - 1);
    return value.toISOString().slice(0, 10);
}

function isTradingDate(date: string): boolean {
    return TradingCalendarService.isTradingDay(dateAtShanghaiNoon(date));
}

export function canRunCloseSettlement(now: Date = new Date()): boolean {
    const current = getShanghaiDateTime(now);
    return !isTradingDate(current.date) || current.minutes >= CLOSE_SETTLEMENT_MINUTES;
}

export function getExpectedCloseTradeDate(now: Date = new Date()): string {
    const current = getShanghaiDateTime(now);
    let candidate = current.date;
    if (isTradingDate(candidate) && current.minutes < CLOSE_SETTLEMENT_MINUTES) {
        candidate = previousDate(candidate);
    }
    while (!isTradingDate(candidate)) {
        candidate = previousDate(candidate);
    }
    return candidate;
}

function toPositiveNumber(value: unknown): number | null {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

export function isPushHistoryRecordSettled(record: PushHistorySettlementRecord): boolean {
    const pushDate = normalizeDateOnly(record.push_date);
    const latestTradeDate = normalizeDateOnly(record.latest_trade_date);
    const realtimeTime = String(record.realtime_time ?? '').trim();
    return Boolean(
        pushDate
        && latestTradeDate
        && latestTradeDate >= pushDate
        && realtimeTime
        && toPositiveNumber(record.push_price)
        && toPositiveNumber(record.latest_price),
    );
}

export function needsCloseSettlement(
    records: PushHistorySettlementRecord[],
    expectedTradeDate: string,
): boolean {
    return records.some(record => {
        const pushDate = normalizeDateOnly(record.push_date);
        if (!pushDate || pushDate > expectedTradeDate) return false;
        const settlementDate = normalizeDateOnly(record.realtime_time);
        return !settlementDate || settlementDate < expectedTradeDate;
    });
}
