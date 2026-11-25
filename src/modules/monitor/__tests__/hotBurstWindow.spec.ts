import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { HotBurstService, HotBurstHistoryError } from '../HotBurstService';
import { WindLeaderController } from '../windLeaderController';
import { TradingCalendarService } from '../../../shared/utils/TradingCalendarService';
import { TencentQuoteService } from '../../quote/TencentQuoteService';
import { MessagePushService } from '../../push/MessagePushService';
import pool from '../../../core/db';
import type { Request, Response } from 'express';

test('窗口取全只发一条SELECT，同时间同分的203条全部返回且排序含唯一ID', async t => {
    t.after(() => mock.restoreAll());
    mock.method(TradingCalendarService, 'getRecentTradingDays', () => [new Date('2026-11-20T00:00:00Z')]);
    const rows = Array.from({ length: 203 }, (_, i) => ({ id: i + 1, symbol: String(i) }));
    const sqls: string[] = [];
    mock.method(pool, 'query', async (sql: string) => { sqls.push(sql); return { rows }; });
    mock.method(TencentQuoteService, 'getCachedBatchQuotes', async () => []);
    const result = await HotBurstService.getHistory(50, 0, true, 30, 2, 3, true);
    assert.equal(sqls.length, 1);
    assert.match(sqls[0], /resonance_score DESC, id DESC/);
    assert.doesNotMatch(sqls[0], /LIMIT|OFFSET|COUNT\(/);
    assert.equal(result.total, 203);
    assert.equal(new Set(result.records.map(r => r.id)).size, 203);
    await assert.rejects(HotBurstService.getHistory(50, 0, true, 30, 2, 4, true), /1至3/);
});

test('重复股票只查询一次行情，逐symbol回填；错误行情保留原值，零涨幅有效', async t => {
    t.after(() => mock.restoreAll());
    const rows = [{ symbol: 'A', price: 1 }, { symbol: 'B', price: 2 }, { symbol: 'A', price: 3 }];
    mock.method(pool, 'query', async () => ({ rows }));
    mock.method(TencentQuoteService, 'getCachedBatchQuotes', async (symbols: string[]) => {
        assert.deepEqual(symbols, ['A', 'B']);
        return [{ 最新价: 10, 涨跌幅: 0 }, { 错误: 'missing' }];
    });
    const result = await HotBurstService.getHistory();
    assert.deepEqual(result.records.map(r => r.price), [10, 2, 10]);
    assert.equal(result.records[2].change_pct, 0);
});

test('all参数错误400、无法确定日历窗口503；包装器透传all', async t => {
    t.after(() => mock.restoreAll());
    mock.method(TradingCalendarService, 'getRecentTradingDays', () => []);
    await assert.rejects(HotBurstService.getHotBurstHistory({ tradingDays: 5, all: true }),
        (e: unknown) => e instanceof HotBurstHistoryError && e.statusCode === 400);
    await assert.rejects(HotBurstService.getHotBurstHistory({ tradingDays: 3, all: true }),
        (e: unknown) => e instanceof HotBurstHistoryError && e.statusCode === 503);
    for (const [value, expected] of [['5', 400], ['3', 503], ['3bad', 400]] as const) {
        let status = 0;
        const res = { status(n: number) { status = n; return this; }, json() { return this; } };
        await WindLeaderController.getHotBurstHistory({ query: { all: 'true', trading_days: value } } as unknown as Request, res as Response, () => {});
        assert.equal(status, expected);
    }
});

test('普通分页也使用唯一ID稳定排序', async t => {
    t.after(() => mock.restoreAll());
    const sqls: string[] = [];
    mock.method(pool, 'query', async (sql: string) => { sqls.push(sql); return { rows: [] }; });
    mock.method(TencentQuoteService, 'getCachedBatchQuotes', async () => []);
    for (const [only, minimum] of [[true, 2], [true, undefined], [false, undefined]] as const) {
        await HotBurstService.getHistory(50, 0, only, 3, minimum);
    }
    for (const sql of sqls.filter(s => s.includes('LIMIT'))) assert.match(sql, /resonance_score DESC, id DESC/);
});

test('发布失败：手动detect返回500，推送向上报错，不能作为空榜成功', async t => {
    t.after(() => mock.restoreAll());
    mock.method(HotBurstService, 'detectHotBurst', async () => { throw new Error('history write failed'); });
    let status = 0;
    let body: unknown;
    const res = { status(n: number) { status = n; return this; }, json(v: unknown) { body = v; return this; } };
    await WindLeaderController.detectHotBurst({} as Request, res as Response, () => {});
    assert.equal(status, 500);
    assert.match(JSON.stringify(body), /history write failed/);
    await assert.rejects(MessagePushService.executeOutbreakAndStockPush('test'), /history write failed/);
});
