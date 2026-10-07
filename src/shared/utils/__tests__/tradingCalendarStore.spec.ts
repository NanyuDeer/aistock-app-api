// 运行：node --import tsx --test src/shared/utils/__tests__/tradingCalendarStore.spec.ts
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { tradingCalendarStore, isWeekday, __tradingCalendarStoreDependencies } from '../tradingCalendarStore';
import { TradingCalendarRefreshService } from '../../../modules/market/TradingCalendarRefreshService';

const ROWS = [
    { cal_date: '2026-09-30', is_open: true,  pretrade_date: '2026-09-29' },
    { cal_date: '2026-10-01', is_open: false, pretrade_date: '2026-09-30' }, // 周四·国庆
    { cal_date: '2026-10-08', is_open: true,  pretrade_date: '2026-09-30' },
];

// 隔离声明：load() 设计上会触发一次 TradingCalendarRefreshService.refresh（拉 Tushare + 查 DB）。
// 单测只关心 store 自身的缓存/降级逻辑，故将 refresh 替换为 no-op，避免真实网络/DB 调用拖慢与 flaky。
// 注意：这里未修改 load() 实现，也未修改任何断言。
function mockRefreshNoop() {
    return mock.method(TradingCalendarRefreshService, 'refresh', async () => ({
        fetched: 0, upserted: 0, minDate: null, maxDate: null,
    }));
}

async function loadWith(rows: typeof ROWS) {
    const m = mock.method(__tradingCalendarStoreDependencies, 'query', async () => ({ rows }));
    const refreshMock = mockRefreshNoop();
    await tradingCalendarStore.load(new Date('2026-10-06T02:00:00.000Z'));
    m.mock.restore();
    refreshMock.mock.restore();
}

test.beforeEach(() => { tradingCalendarStore.__resetForTest(); });

test('isWeekday 只按周一到周五判断', () => {
    assert.equal(isWeekday('2026-10-01'), true);  // 周四
    assert.equal(isWeekday('2026-10-03'), false); // 周六
    assert.equal(isWeekday('2026-10-04'), false); // 周日
});

test('降级链第 1 级：命中覆盖范围 → 返回表内权威值（国庆为 false）', async () => {
    await loadWith(ROWS);
    assert.equal(tradingCalendarStore.isTradingDay('2026-10-01'), false);
    assert.equal(tradingCalendarStore.isTradingDay('2026-10-08'), true);
    assert.equal(tradingCalendarStore.getHealth().degraded, false);
});

test('降级链第 2 级：已加载但超出范围 → 周一~周五 + error 告警', async () => {
    await loadWith(ROWS);
    const errMock = mock.method(console, 'error', () => undefined);
    const result = tradingCalendarStore.isTradingDay('2027-01-04'); // 周一
    errMock.mock.restore();
    assert.equal(result, true);                            // 周一~周五 → true
    assert.equal(errMock.mock.calls.length, 1);            // 有告警，不静默
    assert.equal(tradingCalendarStore.getHealth().degraded, true);
});

test('降级链第 3 级：未加载 → 周一~周五 + warn 告警（每次进程只告警一次）', () => {
    const warnMock = mock.method(console, 'warn', () => undefined);
    assert.equal(tradingCalendarStore.isTradingDay('2026-10-01'), true); // 未加载 → 周四 → true（老行为）
    assert.equal(tradingCalendarStore.isTradingDay('2026-10-02'), true);
    warnMock.mock.restore();
    assert.equal(warnMock.mock.calls.length, 1, 'warn 只应打一次');
});

test('inCoverage 与 getPretradeDate', async () => {
    await loadWith(ROWS);
    assert.equal(tradingCalendarStore.inCoverage('2026-09-30'), true);
    assert.equal(tradingCalendarStore.inCoverage('2026-09-29'), false);
    assert.equal(tradingCalendarStore.getPretradeDate('2026-10-08'), '2026-09-30');
    assert.equal(tradingCalendarStore.getPretradeDate('2027-01-04'), null);
});

test('pg 返回 Date 实例（本地午夜）时日期不错位', async () => {
    // pg(postgres-date) 把裸 DATE 按本地时间解析为本地午夜 Date；
    // 若用 toISOString()，UTC+8 下会整体前移一天 → 键错位、判定全部 miss。
    const dateRows = [
        { cal_date: new Date(2026, 8, 30), is_open: true,  pretrade_date: new Date(2026, 8, 29) }, // 2026-09-30 本地
        { cal_date: new Date(2026, 9, 1),  is_open: false, pretrade_date: new Date(2026, 8, 30) }, // 2026-10-01 本地（周四·国庆）
    ];
    const m = mock.method(__tradingCalendarStoreDependencies, 'query', async () => ({ rows: dateRows }));
    const refreshMock = mockRefreshNoop();
    await tradingCalendarStore.load(new Date('2026-10-06T02:00:00.000Z'));
    refreshMock.mock.restore();
    m.mock.restore();
    assert.equal(tradingCalendarStore.isTradingDay('2026-10-01'), false); // 若错位会 miss 并退化为 true
    assert.equal(tradingCalendarStore.isTradingDay('2026-09-30'), true);
});

test('load 查表失败 → 保持未加载 + degraded，且不抛错', async () => {
    const m = mock.method(__tradingCalendarStoreDependencies, 'query', async () => { throw new Error('db down'); });
    const refreshMock = mockRefreshNoop();
    await assert.doesNotReject(() => tradingCalendarStore.load(new Date('2026-10-06T02:00:00.000Z')));
    m.mock.restore();
    refreshMock.mock.restore();
    assert.equal(tradingCalendarStore.getHealth().loadedAt, null);
    assert.equal(tradingCalendarStore.getHealth().degraded, true);
});

test('load 装载 0 行（表存在但为空）→ 覆盖为空 → degraded=true 且打 console.error', async () => {
    const errMock = mock.method(console, 'error', () => undefined);
    await loadWith([]);
    errMock.mock.restore();
    const health = tradingCalendarStore.getHealth();
    assert.notEqual(health.loadedAt, null, 'SELECT 成功即视为已加载');
    assert.equal(health.minDate, null);
    assert.equal(health.maxDate, null);
    assert.equal(health.degraded, true, '无覆盖必须判为降级（否则假健康）');
    assert.ok(errMock.mock.calls.length >= 1, '空覆盖降级绝不静默，必须有 console.error');
});

