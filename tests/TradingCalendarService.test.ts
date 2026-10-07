/**
 * TradingCalendarService.getPreviousTradingDay 单元测试
 *
 * 关键日期：2026-07-17(五)/2026-07-20(一) 为交易日；2026-07-18(六)/19(日) 休市。
 * 节假日：2026-10-01~07 国庆休市，2026-10-08(四) 为节后首个交易日。
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { TradingCalendarService } from '../src/shared/utils/TradingCalendarService'
import { tradingCalendarStore, __tradingCalendarStoreDependencies } from '../src/shared/utils/tradingCalendarStore'
import { TradingCalendarRefreshService } from '../src/modules/market/TradingCalendarRefreshService'

/** 生成"整段日历"fixture：周末与给定休市日 → false，其余 → true（模拟真实表里"每一天都有行"） */
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

test.before(() => {
    tradingCalendarStore.__setForTest(
        buildFixture('2026-07-01', '2026-12-31', HOLIDAYS_2026_NATIONAL_DAY),
        '2026-07-01',
        '2026-12-31',
    );
});

test('getPreviousTradingDay returns the prior Friday for a Monday 15:10', () => {
    const monday = new Date('2026-07-20T07:10:00.000Z') // 15:10 Asia/Shanghai
    const prev = TradingCalendarService.getPreviousTradingDay(monday)
    assert.equal(prev.toISOString().slice(0, 10), '2026-07-17')
})

test('getPreviousTradingDay returns Friday for a weekend daytime', () => {
    const sunday = new Date('2026-07-19T02:00:00.000Z') // 10:00 Asia/Shanghai
    const prev = TradingCalendarService.getPreviousTradingDay(sunday)
    assert.equal(prev.toISOString().slice(0, 10), '2026-07-17')
})

test('getPreviousTradingDay ignores wall-clock hour (03:00 same day)', () => {
    const mondayEarly = new Date('2026-07-19T19:00:00.000Z') // 周一 03:00 Asia/Shanghai
    const prev = TradingCalendarService.getPreviousTradingDay(mondayEarly)
    assert.equal(prev.toISOString().slice(0, 10), '2026-07-17')
})

test('getPreviousTradingDay skips long holidays backwards', () => {
    const afterHoliday = new Date('2026-10-08T02:00:00.000Z') // 周四 10:00 Asia/Shanghai
    const prev = TradingCalendarService.getPreviousTradingDay(afterHoliday)
    assert.equal(prev.toISOString().slice(0, 10), '2026-09-30')
})

test('getPreviousTradingDay fails closed when the calendar has no data for that date', () => {
    tradingCalendarStore.__setForTest({ '2027-01-01': true }, '2027-01-01', '2027-01-01');
    // 入参 2026-12-31T16:30Z = 上海 2027-01-01 00:30（在注入覆盖内）→ 回溯候选日为 2026-12-31（超出注入范围）→ 抛错
    assert.throws(
        () => TradingCalendarService.getPreviousTradingDay(new Date('2026-12-31T16:30:00.000Z')),
        /Trading calendar has no data for 2026-12-31/,
    );
});

test('isTradingDay 对国庆（周四）返回 false —— 不再受第三方可用性影响', () => {
    tradingCalendarStore.__setForTest({ '2026-10-01': false, '2026-10-08': true }, '2026-10-01', '2026-10-08');
    assert.equal(TradingCalendarService.isTradingDay(new Date('2026-10-01T02:00:00.000Z')), false);
    assert.equal(TradingCalendarService.isTradingDay(new Date('2026-10-08T02:00:00.000Z')), true);
    tradingCalendarStore.__resetForTest();
});

test('isTradingDay 在 store 未加载时退化为周一~周五且有 warn（降级不静默）', () => {
    tradingCalendarStore.__resetForTest();
    const warn = mock.method(console, 'warn', () => undefined);
    assert.equal(TradingCalendarService.isTradingDay(new Date('2026-10-01T02:00:00.000Z')), true);
    warn.mock.restore();
    assert.equal(warn.mock.calls.length, 1);
});

test('store 已加载但覆盖为空时日期推算不抛错（回落降级链）', async () => {
    // 真实复现：迁移已执行但 Tushare 首次刷新失败 → trading_calendar 表存在但为空 →
    // load() 装载 0 行（loadedAt 有值、minDate/maxDate 为 null）。
    const queryMock = mock.method(__tradingCalendarStoreDependencies, 'query', async () => ({ rows: [] }));
    const refreshMock = mock.method(TradingCalendarRefreshService, 'refresh', async () => ({
        fetched: 0, upserted: 0, minDate: null, maxDate: null,
    }));
    const errMock = mock.method(console, 'error', () => undefined);
    await tradingCalendarStore.load(new Date('2026-07-20T02:00:00.000Z'));
    queryMock.mock.restore();
    refreshMock.mock.restore();
    errMock.mock.restore();

    const health = tradingCalendarStore.getHealth();
    assert.ok(health.loadedAt, 'SELECT 成功即视为已加载');
    assert.equal(health.minDate, null);
    assert.equal(health.maxDate, null);
    assert.equal(health.degraded, true);

    // 覆盖为空 → 不 fail-closed，按降级链回落「周一~周五」（周一 2026-07-20 → 上周五 2026-07-17）
    const prev = TradingCalendarService.getPreviousTradingDay(new Date('2026-07-20T07:10:00.000Z'));
    assert.equal(prev.toISOString().slice(0, 10), '2026-07-17');
    tradingCalendarStore.__resetForTest();
});
