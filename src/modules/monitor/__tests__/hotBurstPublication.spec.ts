import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { HotBurstService } from '../HotBurstService';
import pool from '../../../core/db';
import { TencentQuoteService } from '../../quote/TencentQuoteService';

test('DB兜底先按共振筛选再LIMIT，不污染全局缓存，保留0%涨跌幅', async t => {
    const service = HotBurstService as unknown as {
        lastDetectResult: unknown; lastDetectTime: number;
        fallbackFromDB: (h: number, n: number) => ReturnType<typeof HotBurstService.getRecentBursts>;
    };
    const previous = service.lastDetectResult, previousTime = service.lastDetectTime;
    const cached = { outbreaks: [] };
    service.lastDetectResult = cached;
    service.lastDetectTime = 123;
    t.after(() => { mock.restoreAll(); service.lastDetectResult = previous; service.lastDetectTime = previousTime; });
    mock.method(pool, 'query', async (sql: string, params: unknown[]) => {
        assert.match(sql, /WHERE resonance_count >= \$2[\s\S]*LIMIT 50/);
        assert.deepEqual(params, [6, 4]);
        return { rows: [{ symbol: '000001', resonance_count: 4, change_pct: '0.00' }] };
    });
    mock.method(TencentQuoteService, 'getCachedBatchQuotes', async () => []);
    const result = await service.fallbackFromDB(6, 4);
    assert.equal(result?.outbreaks[0].changePct, 0);
    assert.equal(service.lastDetectResult, cached);
    assert.equal(service.lastDetectTime, 123);
});

test('缓存、重新检测、DB兜底及limit的resonance_count均等于返回条数', async t => {
    const service = HotBurstService as unknown as {
        lastDetectTime: number; lastDetectResult: unknown;
        fallbackFromDB: (h: number, n: number) => ReturnType<typeof HotBurstService.getRecentBursts>;
    };
    const previous = service.lastDetectResult, previousTime = service.lastDetectTime;
    t.after(() => { mock.restoreAll(); service.lastDetectResult = previous; service.lastDetectTime = previousTime; });
    const result = { update_time: '2026-11-20T00:00:00Z', resonance_count: 3,
        outbreaks: [2, 3, 4].map((n, i) => ({ symbol: String(i), resonanceCount: n })) } as Awaited<ReturnType<typeof HotBurstService.detectHotBurst>>;
    mock.method(TencentQuoteService, 'getCachedBatchQuotes', async () => []);
    mock.method(HotBurstService, 'detectHotBurst', async () => result);
    mock.method(pool, 'query', async () => ({ rows: [2, 3, 4].map((n, i) => ({ symbol: String(i), resonance_count: n })) }));
    service.lastDetectResult = result; service.lastDetectTime = Date.now();
    assert.equal((await HotBurstService.getRecentBursts(6, 4))?.resonance_count, 1);
    assert.equal((await HotBurstService.getHotBurst({ minResonanceCount: 2, limit: 1 }))?.resonance_count, 1);
    service.lastDetectTime = 0;
    assert.equal((await HotBurstService.getRecentBursts(6, 4))?.resonance_count, 1);
    assert.equal((await service.fallbackFromDB(6, 4))?.resonance_count, 1);
});

test('四源筛选透传至历史SQL，不混入三源', async t => {
    const calls: unknown[][] = [];
    t.after(() => mock.restoreAll());
    mock.method(pool, 'query', async (_sql: string, args: unknown[]) => {
        calls.push(args);
        return { rows: [] };
    });
    mock.method(TencentQuoteService, 'getCachedBatchQuotes', async () => []);
    await HotBurstService.getHistory(50, 0, true, 3, 4);
    assert.equal(calls[0][0], 4);
    assert.equal(calls[1][2], 4);
});

test('写历史失败向上传递，不能报告发布成功', async t => {
    t.after(() => mock.restoreAll());
    mock.method(pool, 'query', async () => { throw new Error('write failed'); });
    const result = {
        update_time: new Date().toISOString(),
        outbreaks: [{ resonanceCount: 2, triggerTags: [], symbol: '000001' }],
    } as unknown as Parameters<typeof HotBurstService.saveHistory>[0];
    await assert.rejects(HotBurstService.saveHistory(result), /write failed/);
});

test('检测失败保留上次缓存，但仍按请求的四源门槛过滤', async t => {
    const service = HotBurstService as unknown as {
        lastDetectTime: number;
        lastDetectResult: unknown;
    };
    const previous = service.lastDetectResult;
    const previousTime = service.lastDetectTime;
    service.lastDetectTime = 0;
    service.lastDetectResult = {
        update_time: '2026-11-19T06:30:00Z', resonance_count: 2,
        outbreaks: [{ symbol: '000001', resonanceCount: 2 }, { symbol: '000002', resonanceCount: 4 }],
    };
    t.after(() => {
        mock.restoreAll();
        service.lastDetectResult = previous;
        service.lastDetectTime = previousTime;
    });
    mock.method(HotBurstService, 'detectHotBurst', async () => { throw new Error('source down'); });
    const result = await HotBurstService.getRecentBursts(6, 4);
    assert.deepEqual(result?.outbreaks.map(s => s.symbol), ['000002']);
    assert.equal(result?.resonance_count, 1);
    assert.equal(result?.update_time, '2026-11-19T06:30:00Z');
});
