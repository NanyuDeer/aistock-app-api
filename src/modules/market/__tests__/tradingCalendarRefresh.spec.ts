// 运行：node --import tsx --test src/modules/market/__tests__/tradingCalendarRefresh.spec.ts
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { TradingCalendarRefreshService, __tradingCalendarRefreshDependencies } from '../TradingCalendarRefreshService';
import { mapTradeCalRows } from '../../quote/TushareService';

test('mapTradeCalRows 把 Tushare 的 0/1 字符串映射为布尔', () => {
    const out = mapTradeCalRows([
        { exchange: 'SSE', cal_date: '20261001', is_open: '0', pretrade_date: '20260930' },
        { exchange: 'SSE', cal_date: '20261008', is_open: '1', pretrade_date: '20260930' },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { exchange: 'SSE', cal_date: '2026-10-01', is_open: false, pretrade_date: '2026-09-30' });
    assert.deepEqual(out[1], { exchange: 'SSE', cal_date: '2026-10-08', is_open: true, pretrade_date: '2026-09-30' });
});

test('mapTradeCalRows 对缺失/非法值宽松降级，不抛错', () => {
    const out = mapTradeCalRows([
        { cal_date: '20261001', is_open: '0' },                 // exchange 缺失
        { exchange: 'SSE', cal_date: '20261002', is_open: null }, // is_open 缺失 → 视为休市
        { exchange: 'SSE', is_open: '1' },                        // cal_date 缺失 → 丢弃该行
        { exchange: 'SSE', cal_date: '2026-10-03', is_open: '1' }, // 已是 ISO 格式 → 原样接受
    ]);
    assert.equal(out.length, 3);
    assert.equal(out[0].exchange, 'SSE');       // 默认补 'SSE'
    assert.equal(out[1].is_open, false);        // null → false
    assert.equal(out[2].cal_date, '2026-10-03');
});

test('refresh 用三个月窗口调用 trade_cal 并幂等 upsert', async (t) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const requestMock = mock.method(__tradingCalendarRefreshDependencies, 'request', async (api: string, params: Record<string, unknown>) => {
        assert.equal(api, 'trade_cal');
        assert.equal(params.exchange, 'SSE');
        assert.equal(params.start_date, '20240101');
        assert.equal(params.end_date, '20271231');
        return [{ exchange: 'SSE', cal_date: '20261001', is_open: '0', pretrade_date: '20260930' }];
    });
    const queryMock = mock.method(__tradingCalendarRefreshDependencies, 'query', async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
    });
    t.after(() => { requestMock.mock.restore(); queryMock.mock.restore(); });

    const result = await TradingCalendarRefreshService.refresh(new Date('2026-10-06T02:00:00.000Z'));

    assert.equal(result.fetched, 1);
    assert.equal(result.maxDate, '2026-10-01');
    assert.ok(calls.some(c => c.sql.includes('INSERT INTO trading_calendar')), '必须有 INSERT');
    assert.ok(calls.some(c => c.sql.includes('ON CONFLICT (exchange, cal_date) DO UPDATE')), '必须幂等');
});

test('refresh 在 Tushare 抛错时只告警不抛（保留旧数据）', async (t) => {
    const requestMock = mock.method(__tradingCalendarRefreshDependencies, 'request', async () => {
        throw new Error('Tushare trade_cal HTTP错误: 500');
    });
    t.after(() => requestMock.mock.restore());

    await assert.doesNotReject(() => TradingCalendarRefreshService.refresh(new Date('2026-10-06T02:00:00.000Z')));
});

test('refresh 在 Tushare 返回空数组时不视为错误（窗口内确无数据）', async (t) => {
    const requestMock = mock.method(__tradingCalendarRefreshDependencies, 'request', async () => []);
    const queryMock = mock.method(__tradingCalendarRefreshDependencies, 'query', async () => ({ rows: [] }));
    t.after(() => { requestMock.mock.restore(); queryMock.mock.restore(); });

    const result = await TradingCalendarRefreshService.refresh(new Date('2026-10-06T02:00:00.000Z'));
    assert.equal(result.fetched, 0);
    assert.equal(result.upserted, 0);
});