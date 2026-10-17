/**
 * 「立即检测」修复（2026-10-15）：
 * 用户侧 POST /api/cn/favorites/movements/detect 由「只检测建事件」升级为
 * 「检测 + 为当日 active 且当前修订缺归因 job 的事件补齐入队」，
 * 避免非交易时段（或 15:10 之后）产生"永远停在 active、无 job"的孤儿事件 → 卡片恒显「归因中」。
 *
 * Mock 策略（仓库惯例，参照 processPriceFactImmediate.spec.ts）：mock pool.query / pool.connect /
 * StockTraceJobService.enqueue / publishPending，断言"补哪些、补几次、是否发布"。
 * 运行：node --import tsx --test src/modules/stock-trace/__tests__/detectEnqueueAttribution.spec.ts
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import pool from '../../../core/db';
import { StockTraceService } from '../StockTraceService';
import { StockTraceJobService } from '../StockTraceJobService';
import { StockTraceController } from '../controller';
import { PriceTriggerDetector } from '../PriceTriggerDetector';

afterEach(() => {
    mock.restoreAll();
});

/** fake client：BEGIN/COMMIT/ROLLBACK 空操作，其余 SQL 返回空 rows */
function fakeClient() {
    return {
        async query(text: string | { text: string }): Promise<{ rows: unknown[] }> {
            const sql = typeof text === 'string' ? text : text.text;
            if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql)) return { rows: [] };
            return { rows: [] };
        },
        async release(): Promise<void> {},
    };
}

describe('enqueueAttributionForTodayActiveEvents（立即检测的归因补齐）', () => {
    it('为当日 active 且缺 job 的事件逐条入队，并发布一次 outbox', async () => {
        let scopedSql = '';
        let scopedParams: unknown[] = [];
        mock.method(pool, 'query', (async (text: string | { text: string }, params?: unknown[]) => {
            const sql = typeof text === 'string' ? text : text.text;
            if (/FROM stock_trace_events/i.test(sql)) {
                scopedSql = sql;
                scopedParams = params ?? [];
                return { rows: [
                    { event_id: 'e1', current_trigger_revision: 1 },
                    { event_id: 'e2', current_trigger_revision: 3 },
                ] };
            }
            return { rows: [] };
        }) as unknown as typeof pool.query);
        mock.method(pool, 'connect', (async () => fakeClient()) as unknown as typeof pool.connect);

        const enqueued: Array<{ eventId: string; triggerRevision: number }> = [];
        mock.method(StockTraceJobService, 'enqueue', (async (_client: unknown, input: { eventId: string; triggerRevision: number }) => {
            enqueued.push(input);
            return 'job-x';
        }) as unknown as typeof StockTraceJobService.enqueue);
        let published = 0;
        mock.method(StockTraceJobService, 'publishPending', (async () => {
            published += 1;
            return { published: 1, failed: 0 };
        }) as unknown as typeof StockTraceJobService.publishPending);

        const count = await StockTraceService.enqueueAttributionForTodayActiveEvents(['600418', '300862']);

        assert.equal(count, 2);
        assert.equal(enqueued.length, 2);
        assert.deepEqual(enqueued.map((item) => item.eventId), ['e1', 'e2']);
        assert.deepEqual(enqueued.map((item) => item.triggerRevision), [1, 3]);
        assert.equal(published, 1, '补齐后应发布一次 outbox');
        // 只补"缺 job"的事件：必须有 NOT EXISTS 守卫 + 当日 + active 过滤
        assert.match(scopedSql, /event_status = 'active'/);
        assert.match(scopedSql, /trading_date/);
        assert.match(scopedSql, /NOT EXISTS/i);
        assert.match(scopedSql, /stock_trace_jobs/);
        assert.deepEqual(scopedParams[0], ['600418', '300862'], '第一个参数应为 symbol 范围');
    });

    it('无缺失事件时不入队、不发布', async () => {
        mock.method(pool, 'query', (async () => ({ rows: [] })) as unknown as typeof pool.query);
        mock.method(pool, 'connect', (async () => fakeClient()) as unknown as typeof pool.connect);
        let enqueued = 0;
        let published = 0;
        mock.method(StockTraceJobService, 'enqueue', (async () => { enqueued += 1; return 'job-x'; }) as unknown as typeof StockTraceJobService.enqueue);
        mock.method(StockTraceJobService, 'publishPending', (async () => { published += 1; return { published: 0, failed: 0 }; }) as unknown as typeof StockTraceJobService.publishPending);

        const count = await StockTraceService.enqueueAttributionForTodayActiveEvents(['600418']);

        assert.equal(count, 0);
        assert.equal(enqueued, 0);
        assert.equal(published, 0);
    });

    it('空 symbol 列表短路返回 0（不触达数据库）', async () => {
        let queried = 0;
        mock.method(pool, 'query', (async () => { queried += 1; return { rows: [] }; }) as unknown as typeof pool.query);

        const count = await StockTraceService.enqueueAttributionForTodayActiveEvents([]);

        assert.equal(count, 0);
        assert.equal(queried, 0, '空列表不应发起任何查询（含 ensureSchema 的 DDL）');
    });
});

describe('StockTraceController.detect（立即检测端点）', () => {
    it('检测后补齐归因入队，并在响应中返回 enqueued 条数', async () => {
        let ran = 0;
        mock.method(PriceTriggerDetector, 'runOnceForce', (async () => { ran += 1; }) as unknown as typeof PriceTriggerDetector.runOnceForce);
        mock.method(StockTraceService, 'getFavoriteSecurities', (async () => [
            { symbol: '600418' }, { symbol: '300862' },
        ]) as unknown as typeof StockTraceService.getFavoriteSecurities);
        let scoped: string[] = [];
        mock.method(StockTraceService, 'enqueueAttributionForTodayActiveEvents', (async (symbols: string[]) => {
            scoped = symbols;
            return 2;
        }) as unknown as typeof StockTraceService.enqueueAttributionForTodayActiveEvents);

        let body: { code: number; data: { triggered: boolean; enqueued: number } } | undefined;
        const res = { json: (payload: typeof body) => { body = payload; } } as unknown as Response;

        await StockTraceController.detect({} as Request, res, (() => {}) as NextFunction);

        assert.equal(ran, 1, '应先跑一次强制检测');
        assert.deepEqual(scoped, ['600418', '300862'], '补齐范围应取自自选股');
        assert.equal(body?.code, 200);
        assert.equal(body?.data.triggered, true);
        assert.equal(body?.data.enqueued, 2);
    });
});
