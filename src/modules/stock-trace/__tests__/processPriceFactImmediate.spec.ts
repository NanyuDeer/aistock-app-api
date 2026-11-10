/**
 * processPriceFact immediateEnqueue：immediateEnqueue=true 时创建分支应写入
 * stock_trace_jobs + stock_trace_outbox（幂等），默认 false 不写。
 * Mock 策略（仓库惯例，参照 listAnalysisStatus.spec.ts）：mock pool.connect 返回
 * fake client（BEGIN/COMMIT/ROLLBACK 空操作，其余 SQL 空 rows），mock pool.query。
 * 运行：node --import tsx --test src/modules/stock-trace/__tests__/processPriceFactImmediate.spec.ts
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../../core/db';
import { StockTraceService } from '../StockTraceService';
import { StockTraceJobService } from '../StockTraceJobService';
import { PRICE_TRIGGER_PERCENT } from '../types';

afterEach(() => {
    mock.restoreAll();
});

/** fake client：BEGIN/COMMIT/ROLLBACK 空操作，其余 SQL 返回空 rows（创建分支无历史事件）*/
function fakeClient() {
    return {
        async query(text: string | { text: string }, _params?: unknown[]): Promise<{ rows: unknown[] }> {
            const sql = typeof text === 'string' ? text : text.text;
            if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql)) return { rows: [] };
            return { rows: [] };
        },
        async release(): Promise<void> {},
    };
}

describe('processPriceFact immediateEnqueue', () => {
    const security = { symbol: '600000', stockName: '浦发银行', market: 'SH', listDate: null };
    const fact = {
        symbol: '600000', stockName: '浦发银行',
        latestPrice: 10.8, previousClose: 10, changePct: 8, observedAt: new Date('2026-08-30T03:00:00Z'),
    };

    function mockDbLayer(): void {
        // ensureSchema 的 DDL 与快照/来源查询全部返回空 rows；事务走 fake client
        mock.method(pool, 'query', (async () => ({ rows: [] })) as unknown as typeof pool.query);
        mock.method(pool, 'connect', (async () => fakeClient()) as unknown as typeof pool.connect);
    }

    it('immediateEnqueue=true 时创建分支调用 enqueue', async () => {
        mockDbLayer();
        let enqueued: Array<{ eventId: string; triggerRevision: number }> = [];
        mock.method(StockTraceJobService, 'enqueue', (async (_client: unknown, input: { eventId: string; triggerRevision: number }) => {
            enqueued.push(input);
            return 'job-1';
        }) as unknown as typeof StockTraceJobService.enqueue);
        // publishPending 置空防外部 Redis 依赖
        mock.method(StockTraceJobService, 'publishPending', (async () => ({ published: 0, failed: 0 })) as unknown as typeof StockTraceJobService.publishPending);

        const result = await StockTraceService.processPriceFact(security, fact, { immediateEnqueue: true });
        assert.equal(result.mutation, 'created');
        assert.equal(enqueued.length, 1, 'immediateEnqueue=true 应入队一次');
        assert.equal(enqueued[0]!.eventId, result.event!.eventId);
        assert.equal(enqueued[0]!.triggerRevision, 1);
    });

    it('默认（无 options）不调用 enqueue', async () => {
        mockDbLayer();
        let enqueued = 0;
        mock.method(StockTraceJobService, 'enqueue', (async () => { enqueued += 1; return 'job-x'; }) as unknown as typeof StockTraceJobService.enqueue);
        mock.method(StockTraceJobService, 'publishPending', (async () => ({ published: 0, failed: 0 })) as unknown as typeof StockTraceJobService.publishPending);

        await StockTraceService.processPriceFact(security, fact);
        assert.equal(enqueued, 0, '默认不应入队（保持落定后归因策略）');
    });

    it('涨跌幅低于阈值仍 ignored，不建事件不入队', async () => {
        mockDbLayer();
        let enqueued = 0;
        mock.method(StockTraceJobService, 'enqueue', (async () => { enqueued += 1; return 'job-x'; }) as unknown as typeof StockTraceJobService.enqueue);
        const lowFact = { ...fact, changePct: PRICE_TRIGGER_PERCENT - 1 };
        const result = await StockTraceService.processPriceFact(security, lowFact, { immediateEnqueue: true });
        assert.equal(result.mutation, 'ignored');
        assert.equal(enqueued, 0);
    });

    it('user_stocks 中 openid 为空的行应跳过（不违反 stock_trace_user_events.openid NOT NULL）', async () => {
        const insertedOpenids: unknown[] = [];
        let userStocksSql = '';
        const client = {
            async query(text: string | { text: string }, params?: unknown[]): Promise<{ rows: unknown[] }> {
                const sql = typeof text === 'string' ? text : text.text;
                if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql)) return { rows: [] };
                if (/FROM user_stocks WHERE symbol/.test(sql)) {
                    userStocksSql = sql;
                    const rows: Array<{ openid: string | null }> = [{ openid: 'o1' }, { openid: null }, { openid: 'o2' }];
                    // 模拟 PostgreSQL：SQL 带 openid IS NOT NULL 时才过滤空值（真实 DB 行为）
                    return { rows: sql.includes('openid IS NOT NULL') ? rows.filter((r) => r.openid !== null) : rows };
                }
                if (/INSERT INTO stock_trace_user_events/.test(sql)) {
                    insertedOpenids.push(params?.[2]);
                }
                return { rows: [] };
            },
            async release(): Promise<void> {},
        };
        mock.method(pool, 'query', (async () => ({ rows: [] })) as unknown as typeof pool.query);
        mock.method(pool, 'connect', (async () => client) as unknown as typeof pool.connect);
        mock.method(StockTraceJobService, 'publishPending', (async () => ({ published: 0, failed: 0 })) as unknown as typeof StockTraceJobService.publishPending);

        const result = await StockTraceService.processPriceFact(security, fact);
        assert.equal(result.mutation, 'created');
        assert.ok(userStocksSql.includes('openid IS NOT NULL'), '未过滤空 openid');
        assert.deepEqual(insertedOpenids, ['o1', 'o2'], '只应为有效用户建关联行');
    });
});