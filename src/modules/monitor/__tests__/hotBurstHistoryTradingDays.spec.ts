// 运行：node --import tsx --test src/modules/monitor/__tests__/hotBurstHistoryTradingDays.spec.ts
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { HotBurstService, resolveTradingDaysStart } from '../HotBurstService';
import pool from '../../../core/db';
import { tradingCalendarStore } from '../../../shared/utils/tradingCalendarStore';

/** 整段日历 fixture：周末与给定休市日 → false，其余 → true */
function buildFixture(startIso: string, endIso: string, closedIso: string[]): Record<string, boolean> {
    const closed = new Set(closedIso);
    const out: Record<string, boolean> = {};
    for (let t = Date.parse(`${startIso}T00:00:00Z`); t <= Date.parse(`${endIso}T00:00:00Z`); t += 86400000) {
        const d = new Date(t);
        const iso = d.toISOString().slice(0, 10);
        const dow = d.getUTCDay();
        out[iso] = dow !== 0 && dow !== 6 && !closed.has(iso);
    }
    return out;
}

const HOLIDAYS_2026_NATIONAL_DAY = [
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
];

/** 起点换算（核心逻辑）—— 用固定 now + 注入日历，期望值可精确断言 */
test('resolveTradingDaysStart：长假期间取「节前最后 3 个交易日」的最早那天 00:00', () => {
    tradingCalendarStore.__setForTest(
        buildFixture('2026-07-01', '2026-12-31', HOLIDAYS_2026_NATIONAL_DAY), '2026-07-01', '2026-12-31',
    );
    // now = 2026-10-06（周二·国庆休市）→ 最近 3 个交易日 = 09-30 / 09-29 / 09-28 → 最早 09-28
    const start = resolveTradingDaysStart(3, new Date('2026-10-06T02:00:00.000Z'));
    tradingCalendarStore.__resetForTest();
    assert.equal(start, '2026-09-28T00:00:00+08:00');
});

test('resolveTradingDaysStart：交易日当天包含在内', () => {
    tradingCalendarStore.__setForTest(
        buildFixture('2026-07-01', '2026-12-31', HOLIDAYS_2026_NATIONAL_DAY), '2026-07-01', '2026-12-31',
    );
    // now = 2026-10-08（复牌首日，周四）→ 最近 3 个交易日 = 10-08 / 09-30 / 09-29 → 最早 09-29
    const start = resolveTradingDaysStart(3, new Date('2026-10-08T02:00:00.000Z'));
    tradingCalendarStore.__resetForTest();
    assert.equal(start, '2026-09-29T00:00:00+08:00');
});

test('resolveTradingDaysStart：缺失/非法入参 → null（回落自然日语义）', () => {
    assert.equal(resolveTradingDaysStart(undefined, new Date('2026-10-06T02:00:00.000Z')), null);
    assert.equal(resolveTradingDaysStart(0, new Date('2026-10-06T02:00:00.000Z')), null);
    assert.equal(resolveTradingDaysStart(61, new Date('2026-10-06T02:00:00.000Z')), null);
    assert.equal(resolveTradingDaysStart(1.5, new Date('2026-10-06T02:00:00.000Z')), null);
});

test('getHistory 传 tradingDays → SQL 用 $2::timestamptz 起点，不再用 INTERVAL', async (t) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const m = mock.method(pool, 'query', async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
    });
    t.after(() => m.mock.restore());

    await HotBurstService.getHistory(50, 0, true, 30, 2, 3);

    const countCall = calls[0];
    assert.ok(countCall.sql.includes('detected_at >= $2::timestamptz'), 'count 起点应用 $2 参数');
    assert.equal(countCall.sql.includes('INTERVAL'), false, 'trading_days 分支不得再用 INTERVAL');
    assert.equal(typeof countCall.params[1], 'string');
    assert.ok(String(countCall.params[1]).endsWith('T00:00:00+08:00'));
    const selectCall = calls[1];
    assert.ok(selectCall.sql.includes('detected_at >= $4::timestamptz'), 'select 起点应用 $4 参数');
});

test('getHistory 不传 tradingDays → 行为与改动前完全一致（自然日 days + INTERVAL）', async (t) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const m = mock.method(pool, 'query', async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
    });
    t.after(() => m.mock.restore());

    await HotBurstService.getHistory(50, 0, true, 30, 2);

    assert.ok(calls[0].sql.includes("' days')::interval"), '未传时保留原 INTERVAL 写法');
    assert.deepEqual(calls[0].params, [2, 30]);
});
