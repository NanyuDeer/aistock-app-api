import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { stockSelectionRouter, stockSelectionService, selectionContext, selectionTradeDate } from '../stockSelectionRouter';
import { tradingCalendarStore, __tradingCalendarStoreDependencies } from '../../../shared/utils/tradingCalendarStore';
import { TradingCalendarRefreshService } from '../../../modules/market/TradingCalendarRefreshService';
import { SelectionQuery } from '../../../modules/stock-selection/SelectionService';

test('盘后边界使用上海时区和权威交易日历，周末/假期回退，日历未加载拒绝', async () => {
    tradingCalendarStore.__resetForTest();
    assert.throws(() => selectionContext(new Date('2026-11-05T08:30:00Z')), /日历/);
    const rows = Array.from({ length: 300 }, (_, i) => {
        const d = new Date(Date.UTC(2026, 0, i + 1));
        return { cal_date: d.toISOString().slice(0, 10), is_open: ![0, 6].includes(d.getUTCDay()), pretrade_date: null };
    });
    const query = mock.method(__tradingCalendarStoreDependencies, 'query', async () => ({ rows }));
    const refresh = mock.method(TradingCalendarRefreshService, 'refresh', async () => ({ fetched: 0, upserted: 0, minDate: null, maxDate: null }));
    try {
        await tradingCalendarStore.load();
        assert.equal(selectionContext(new Date('2026-09-18T08:29:00Z')).tradeDate, '2026-09-17');
        assert.equal(selectionContext(new Date('2026-09-18T08:30:00Z')).tradeDate, '2026-09-18');
        assert.equal(selectionContext(new Date('2026-09-20T08:30:00Z')).tradeDate, '2026-09-18');
        assert.equal(selectionContext(new Date('2026-09-21T02:00:00Z')).dates.length, 90);
        // An unrelated caller requesting an uncovered future date must not poison a valid local window.
        tradingCalendarStore.isTradingDay('2028-01-01');
        assert.equal(tradingCalendarStore.getHealth().degraded, true);
        assert.equal(selectionContext(new Date('2026-09-18T08:30:00Z')).tradeDate, '2026-09-18');
        // A hole inside min/max coverage must not be accepted via weekday fallback.
        rows.splice(rows.findIndex(r => r.cal_date === '2026-09-17'), 1);
        await tradingCalendarStore.load();
        assert.throws(() => selectionContext(new Date('2026-09-18T08:29:00Z')), /日历/);
    } finally { query.mock.restore(); refresh.mock.restore(); tradingCalendarStore.__resetForTest(); }
});

test('读取只需最近盘后日期，生成仍严格要求90交易日；缺失历史行不能按工作日补造', async () => {
    const rows = [
        { cal_date: '2026-11-05', is_open: true, pretrade_date: null },
        { cal_date: '2026-11-06', is_open: true, pretrade_date: '2026-11-05' },
    ];
    const query = mock.method(__tradingCalendarStoreDependencies, 'query', async () => ({ rows }));
    const refresh = mock.method(TradingCalendarRefreshService, 'refresh', async () => ({ fetched: 0, upserted: 0, minDate: null, maxDate: null }));
    try {
        tradingCalendarStore.__resetForTest(); await tradingCalendarStore.load();
        assert.equal(selectionTradeDate(new Date('2026-11-06T02:00:00Z')), '2026-11-05');
        assert.throws(() => selectionContext(new Date('2026-11-06T02:00:00Z')), /历史覆盖不足/);
    } finally { query.mock.restore(); refresh.mock.restore(); tradingCalendarStore.__resetForTest(); }
});

test('统一HTTP接口校验同周期，生成鉴权失败不执行，读失败为503', async () => {
    const originalToken = process.env.INTERNAL_API_TOKEN;
    process.env.INTERNAL_API_TOKEN = 'selection-test-token';
    const result = mock.method(stockSelectionService, 'results', async (q: SelectionQuery) => ({ status: 'ready', methods: q.methods, stocks: [] }) as never);
    const generate = mock.method(stockSelectionService, 'generate', async () => ({ status: 'ready' }));
    const app = express(); app.use(express.json()); app.use('/api/stock-selection', stockSelectionRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/api/stock-selection`;
    try {
        assert.equal((await fetch(`${base}/results?horizon=short&methods=volume_breakout,momentum_continuation`)).status, 200);
        assert.equal(result.mock.calls.length, 1);
        assert.equal((await fetch(`${base}/results?horizon=short&methods=trend_following`)).status, 400);
        assert.equal((await fetch(`${base}/generate`, { method: 'POST' })).status, 403);
        assert.equal(generate.mock.calls.length, 0);
        const headers = { 'Content-Type': 'application/json', 'X-Internal-Token': 'selection-test-token' };
        assert.equal((await fetch(`${base}/generate`, { method: 'POST', headers, body: JSON.stringify({ tradeDate: '2020-01-01' }) })).status, 400);
        assert.equal((await fetch(`${base}/generate`, { method: 'POST', headers, body: '{}' })).status, 202);
        assert.equal(generate.mock.calls.length, 1);
        result.mock.mockImplementation(async () => { throw Object.assign(new Error('DB unavailable'), { code: 'ECONNREFUSED' }); });
        const dbFailure = await fetch(`${base}/results?horizon=short&methods=volume_breakout`);
        assert.equal(dbFailure.status, 503);
        assert.equal(((await dbFailure.json()) as { data: { reasonCode: string } }).data.reasonCode, 'DATABASE_UNAVAILABLE');
        result.mock.mockImplementation(async () => { throw Object.assign(new Error('calendar unavailable'), { code: 'CALENDAR_UNAVAILABLE' }); });
        const calendarFailure = await fetch(`${base}/results?horizon=short&methods=volume_breakout`);
        assert.equal(calendarFailure.status, 503);
        assert.equal(((await calendarFailure.json()) as { data: { reasonCode: string } }).data.reasonCode, 'CALENDAR_UNAVAILABLE');
    } finally {
        result.mock.restore(); generate.mock.restore();
        if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN; else process.env.INTERNAL_API_TOKEN = originalToken;
        server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    }
});
