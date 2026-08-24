// src/modules/stock-trace/__tests__/publish-gate.spec.ts
// 运行：node --import tsx --test src/modules/stock-trace/__tests__/publish-gate.spec.ts
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import pool from '../../../core/db';
import redis from '../../../core/redis';
import { StockTraceJobService } from '../StockTraceJobService';

function pendingRow() {
    return {
        outbox_id: 'outbox-1',
        job_id: 'job-1',
        payload: { eventId: 'mv:600000:2026-08-21:1:up', triggerRevision: 1, analysisVersion: 'llm-stock-trace-v1' },
        created_at: new Date(),
    };
}

afterEach(() => { mock.restoreAll(); });

describe('publishPending 快照就绪 gate', () => {
    it('enriched 快照未就绪 → 不发布、outbox 置 held_until 留待下轮', async () => {
        const updates: Array<{ text: string; params: unknown[] }> = [];
        mock.method(pool, 'query', async (sql: string | { text: string }, ...params: unknown[]) => {
            const text = typeof sql === 'string' ? sql : sql.text;
            // 待发布列表
            if (text.includes('FROM stock_trace_outbox') && text.includes("status = 'pending'")) {
                return { rows: [pendingRow()] };
            }
            // enriched 快照检查：无行 → 未就绪
            if (text.includes("snapshot_stage = 'enriched'")) {
                return { rows: [] };
            }
            // held_until 更新 / ensureSchema DDL
            if (text.includes('UPDATE stock_trace_outbox')) {
                updates.push({ text, params });
                return { rowCount: 1 };
            }
            return { rows: [] };
        });
        const xadd = mock.method(redis, 'xadd', async () => '0-0');

        const result = await StockTraceJobService.publishPending();

        assert.deepEqual(result, { published: 0, failed: 0 });
        assert.equal(xadd.mock.callCount(), 0, '未就绪不应发布到 Stream');
        const heldUpdates = updates.filter(u => u.text.includes('held_until'));
        assert.equal(heldUpdates.length, 1, '未就绪应执行一次 held_until 更新');
        assert.ok(heldUpdates[0].text.includes("interval '5 seconds'"), 'held_until 应为 now + 5s');
    });

    it('快照未就绪但已超过 MAX_HOLD_SECONDS → 不再 hold，直接发布交由 consumer 兜底', async () => {
        // created_at 在 60s 之前 → 已超硬超时（对应模块 MAX_HOLD_SECONDS = 60）
        const timedOutRow = { ...pendingRow(), created_at: new Date(Date.now() - 60 * 1000 - 1000) };
        mock.method(pool, 'query', async (sql: string | { text: string }) => {
            const text = typeof sql === 'string' ? sql : sql.text;
            if (text.includes('FROM stock_trace_outbox') && text.includes("status = 'pending'")) {
                return { rows: [timedOutRow] };
            }
            if (text.includes("snapshot_stage = 'enriched'")) {
                return { rows: [] }; // 仍未就绪
            }
            if (text.includes('UPDATE stock_trace_outbox')) {
                return { rowCount: 1 };
            }
            if (text.includes('UPDATE stock_trace_jobs')) {
                return { rowCount: 1 };
            }
            return { rows: [] };
        });
        const xadd = mock.method(redis, 'xadd', async () => '1680000000000-0');

        const result = await StockTraceJobService.publishPending();

        assert.deepEqual(result, { published: 1, failed: 0 });
        assert.equal(xadd.mock.callCount(), 1, '超过硬超时的 job 应直接发布，而非一直 hold');
    });

    it('enriched 快照就绪 → 发布到 Stream 并更新 job 状态', async () => {
        const updates: Array<{ text: string; params: unknown[] }> = [];
        mock.method(pool, 'query', async (sql: string | { text: string }, ...params: unknown[]) => {
            const text = typeof sql === 'string' ? sql : sql.text;
            if (text.includes('FROM stock_trace_outbox') && text.includes("status = 'pending'")) {
                return { rows: [pendingRow()] };
            }
            if (text.includes("snapshot_stage = 'enriched'")) {
                return { rows: [{ snapshot_id: 'snap-1' }] }; // 就绪
            }
            if (text.includes('UPDATE stock_trace_outbox')) {
                updates.push({ text, params });
                return { rowCount: 1 };
            }
            if (text.includes('UPDATE stock_trace_jobs')) {
                return { rowCount: 1 };
            }
            return { rows: [] };
        });
        mock.method(redis, 'xadd', async () => '1680000000000-0');

        const result = await StockTraceJobService.publishPending();

        assert.deepEqual(result, { published: 1, failed: 0 });
        assert.ok(updates.some(u => u.text.includes('status = \'published\'')), '就绪时 outbox 应置 published');
    });
});
