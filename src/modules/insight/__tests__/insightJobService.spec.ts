/**
 * InsightJobService 单元测试（enqueue 幂等 + publishPending 写流/重试）
 *
 * 仓库惯例：Node 内建 test runner（node:test）+ .spec.ts 命名 + __tests__ 目录。
 * mock 方式与 insightService.spec.ts 一致：mock pool.query / pool.connect / redis.xadd，
 * 不触碰真实数据库与 Redis。
 *
 * 运行：`node --import tsx --test src/modules/insight/__tests__/insightJobService.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../../core/db';
import redis from '../../../core/redis';
import {
    enqueue,
    publishPending,
    WATCHLIST_INSIGHT_STREAM,
    WATCHLIST_INSIGHT_ANALYSIS_VERSION,
} from '../InsightJobService';

afterEach(() => {
    mock.restoreAll();
});

// ==================== enqueue ====================

describe('enqueue', () => {
    it('同一 event 第二次不产生新 job / outbox（ON CONFLICT DO NOTHING 幂等），走 ROLLBACK', async () => {
        let jobInsertCalls = 0;
        let outboxInsertCalls = 0;
        const tx: string[] = [];
        const clientQuery = (async (text: string) => {
            if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
                tx.push(text);
                return { rows: [] };
            }
            if (text.includes('INSERT INTO watchlist_insight_jobs')) {
                jobInsertCalls++;
                return { rows: jobInsertCalls === 1 ? [{ job_id: '11111111-1111-4111-8111-111111111111' }] : [] };
            }
            if (text.includes('INSERT INTO watchlist_insight_outbox')) {
                outboxInsertCalls++;
                return { rows: [] };
            }
            return { rows: [] };
        }) as unknown as typeof pool.query;
        const client = { query: clientQuery, release: () => {} };
        mock.method(pool, 'connect', (async () => client) as unknown as typeof pool.connect);
        // enqueue 事务提交后触发 publishPending：mock 为无 pending，避免 Redis 交互
        mock.method(pool, 'query', (async () => ({ rows: [] })) as unknown as typeof pool.query);
        mock.method(redis, 'xadd', (async () => '0-0') as unknown as typeof redis.xadd);

        const eventId = 'wi_20260805_000962_limit_up';
        await enqueue(eventId);
        await enqueue(eventId);

        assert.equal(jobInsertCalls, 2, '两次入队都执行 job INSERT');
        assert.equal(outboxInsertCalls, 1, 'outbox 只插入一次');
        assert.equal(tx.filter(t => t === 'BEGIN').length, 2);
        assert.equal(tx.filter(t => t === 'COMMIT').length, 1);
        assert.equal(tx.filter(t => t === 'ROLLBACK').length, 1);
    });

    it('job INSERT 列清单与 016 迁移一致（(event_id, analysis_version) 唯一键幂等）', async () => {
        let capturedSql = '';
        const clientQuery = (async (text: string) => {
            if (text.includes('INSERT INTO watchlist_insight_jobs')) {
                capturedSql = text;
                return { rows: [{ job_id: 'j1' }] };
            }
            return { rows: [] };
        }) as unknown as typeof pool.query;
        mock.method(pool, 'connect', (async () => ({ query: clientQuery, release: () => {} })) as unknown as typeof pool.connect);
        mock.method(pool, 'query', (async () => ({ rows: [] })) as unknown as typeof pool.query);
        mock.method(redis, 'xadd', (async () => '0-0') as unknown as typeof redis.xadd);

        await enqueue('wi_e1');

        assert.ok(capturedSql.includes('INSERT INTO watchlist_insight_jobs (event_id, analysis_version)'));
        assert.ok(capturedSql.includes('ON CONFLICT (event_id, analysis_version) DO NOTHING'));
    });
});

// ==================== publishPending ====================

describe('publishPending', () => {
    it('xadd 写流后 outbox 置 published、jobs 置 published + stream_message_id', async () => {
        const pendingRows = [
            { outbox_id: 'o1', job_id: 'j1', payload: { eventId: 'wi_e1' } },
            { outbox_id: 'o2', job_id: 'j2', payload: { eventId: 'wi_e2' } },
        ];
        const executed: string[] = [];
        const queryMock = (async (text: string) => {
            if (text.includes('FROM watchlist_insight_outbox o')) return { rows: pendingRows };
            executed.push(text);
            return { rows: [] };
        }) as unknown as typeof pool.query;
        mock.method(pool, 'query', queryMock);

        const xaddCalls: string[][] = [];
        mock.method(redis, 'xadd', (async (key: string, ...rest: string[]) => {
            xaddCalls.push([key, ...rest]);
            return `stream-${xaddCalls.length}`;
        }) as unknown as typeof redis.xadd);

        const published = await publishPending(2);

        assert.equal(published, 2);
        assert.equal(xaddCalls.length, 2);
        assert.ok(xaddCalls.every(call => call[0] === WATCHLIST_INSIGHT_STREAM), 'xadd key 必须为 watchlist-insight.jobs');
        assert.ok(xaddCalls.every(call => call.includes(WATCHLIST_INSIGHT_ANALYSIS_VERSION)), 'xadd 携带 analysis_version');

        const outboxUpdates = executed.filter(t => t.includes('UPDATE watchlist_insight_outbox SET status'));
        const jobUpdates = executed.filter(t => t.includes('UPDATE watchlist_insight_jobs SET status'));
        assert.equal(outboxUpdates.length, 2);
        assert.equal(jobUpdates.length, 2);
        assert.ok(outboxUpdates[0].includes("status = 'published'"));
        assert.ok(jobUpdates[0].includes('stream_message_id = $2'));
    });

    it('xadd 失败时该条 attempt_count+1，不阻断其余任务', async () => {
        const pendingRows = [
            { outbox_id: 'o1', job_id: 'j1', payload: { eventId: 'wi_e1' } },
            { outbox_id: 'o2', job_id: 'j2', payload: { eventId: 'wi_e2' } },
        ];
        let retryUpdates = 0;
        const queryMock = (async (text: string) => {
            if (text.includes('FROM watchlist_insight_outbox o')) return { rows: pendingRows };
            if (text.includes('attempt_count = attempt_count + 1')) retryUpdates++;
            return { rows: [] };
        }) as unknown as typeof pool.query;
        mock.method(pool, 'query', queryMock);

        let xaddFailures = 0;
        mock.method(redis, 'xadd', (async () => {
            xaddFailures++;
            if (xaddFailures === 1) throw new Error('redis down');
            return 'stream-2';
        }) as unknown as typeof redis.xadd);

        const published = await publishPending(10);

        assert.equal(published, 1);
        assert.equal(xaddFailures, 2);
        assert.equal(retryUpdates, 1);
    });
});
