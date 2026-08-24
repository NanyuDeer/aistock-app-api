/**
 * 落定触发最终归因一次 + 幂等 + 收盘兜底（2026-08-21 迁移决策）
 *
 * 背景：盘中异动归因消耗 token 过多且盘中 6 方面数据不全导致归因不准。
 * 决策：create/revision 不再即时入队；事件落定（恢复窗口到期 / 反向落定 / 收盘兜底）
 * 后只入队一次最终归因 job（用最终 current_trigger_revision 的 enriched 快照）。
 *
 * 覆盖：
 * 1. startRecovery 落定事件 → 恰好触发一次最终归因（最终 revision）
 * 2. startRecovery 无落定 → 不触发归因
 * 3. settleActiveEvents 收盘兜底 → 强制落定当日 active 事件并对每个事件触发归因
 * 4. StockTraceJobService.enqueue 幂等：同事件+revision 已入队 → 复用已有 job，不重复插入
 *
 * Mock 策略：node:test mock.method(pool, 'query'/'connect') 拦截 DB；mock
 * StockTraceJobService.enqueue 记录入队参数；mock publishPending 避免 Redis 交互。
 * startRecovery/settleActiveEvents 为 TS private/static，测试经 any 访问。
 *
 * 运行：node --import tsx --test src/modules/stock-trace/__tests__/final-attribution.spec.ts
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import pool from '../../../core/db';
import { StockTraceJobService } from '../StockTraceJobService';
import { StockTraceService } from '../StockTraceService';

/** 处理 startRecovery 内的 pool.query：落定 UPDATE 命中 settledRows，其余（schema DDL/恢复标记）返回空。 */
function mockPoolQueryForRecovery(settledRows: Array<{ event_id: string; current_trigger_revision: number }>): void {
    mock.method(pool, 'query', async (sql: string | { text: string }, ..._args: unknown[]) => {
        const text = typeof sql === 'string' ? sql : sql.text;
        // startRecovery 的落定 UPDATE：event_status='closed' + RETURNING + recovery 窗口判断
        if (text.includes('RETURNING event_id, current_trigger_revision') && text.includes('recovery_started_at IS NOT NULL')) {
            return { rows: settledRows };
        }
        return { rows: [] };
    });
}

/** 处理 settleActiveEvents 内的 pool.query：按 trading_date 落定命中 settledRows。 */
function mockPoolQueryForSettle(settledRows: Array<{ event_id: string; current_trigger_revision: number }>): void {
    mock.method(pool, 'query', async (sql: string | { text: string }, ..._args: unknown[]) => {
        const text = typeof sql === 'string' ? sql : sql.text;
        // settleActiveEvents 落定 UPDATE：trading_date = $1::date + RETURNING
        if (text.includes('RETURNING event_id, current_trigger_revision') && text.includes('trading_date = $1::date')) {
            return { rows: settledRows };
        }
        return { rows: [] };
    });
}

function mockPoolConnect(): void {
    mock.method(pool, 'connect', async () => ({
        query: async () => ({ rows: [] }),
        release: () => undefined,
    }));
}

function mockEnqueue(): ReturnType<typeof mock.method> {
    return mock.method(StockTraceJobService, 'enqueue', async (_client: unknown, _input: unknown) => 'job-mock');
}

function mockPublishPending(): void {
    mock.method(StockTraceJobService, 'publishPending', async () => ({ published: 0, failed: 0 }));
}

afterEach(() => {
    mock.restoreAll();
});

describe('startRecovery 落定触发最终归因一次', () => {
    it('恢复窗口到期的 active 事件被落定 → 恰好入队一次最终归因（用最终 revision）', async () => {
        mockPoolQueryForRecovery([{ event_id: 'e1', current_trigger_revision: 2 }]);
        mockPoolConnect();
        const enqueue = mockEnqueue();
        mockPublishPending();

        // 时间不可控的窗口判断在 SQL 内完成，此处只关心 mock 返回的已落定行。
        await (StockTraceService as unknown as {
            startRecovery: (symbol: string, observedAt: Date) => Promise<void>;
        }).startRecovery('600000', new Date('2026-08-21T03:00:00.000Z'));

        assert.strictEqual(enqueue.mock.calls.length, 1, '落定一个事件应只入队一次');
        const [, input] = enqueue.mock.calls[0]!.arguments as [unknown, { eventId: string; triggerRevision: number }];
        assert.strictEqual(input.eventId, 'e1');
        assert.strictEqual(input.triggerRevision, 2, '必须用落定时刻的最终 revision');
    });

    it('无事件落定 → 不触发任何归因入队', async () => {
        mockPoolQueryForRecovery([]);
        mockPoolConnect();
        const enqueue = mockEnqueue();
        mockPublishPending();

        await (StockTraceService as unknown as {
            startRecovery: (symbol: string, observedAt: Date) => Promise<void>;
        }).startRecovery('600000', new Date('2026-08-21T03:00:00.000Z'));

        assert.strictEqual(enqueue.mock.calls.length, 0);
    });
});

describe('settleActiveEvents 收盘兜底', () => {
    it('强制落定当日 active 事件，并对每个事件触发一次最终归因，返回落定数', async () => {
        mockPoolQueryForSettle([
            { event_id: 'e1', current_trigger_revision: 1 },
            { event_id: 'e2', current_trigger_revision: 3 },
        ]);
        mockPoolConnect();
        const enqueue = mockEnqueue();
        mockPublishPending();

        const settled = await StockTraceService.settleActiveEvents();

        assert.strictEqual(settled, 2);
        assert.strictEqual(enqueue.mock.calls.length, 2, '每个落定事件入队一次');
        const inputs = enqueue.mock.calls.map((c) => c.arguments[1]) as Array<{ eventId: string; triggerRevision: number }>;
        assert.deepStrictEqual(inputs.sort((a, b) => a.eventId.localeCompare(b.eventId)), [
            { eventId: 'e1', triggerRevision: 1 },
            { eventId: 'e2', triggerRevision: 3 },
        ]);
    });

    it('当日无 active 事件 → 返回 0 且不入队', async () => {
        mockPoolQueryForSettle([]);
        mockPoolConnect();
        const enqueue = mockEnqueue();
        mockPublishPending();

        const settled = await StockTraceService.settleActiveEvents();

        assert.strictEqual(settled, 0);
        assert.strictEqual(enqueue.mock.calls.length, 0);
    });
});

describe('StockTraceJobService.enqueue 幂等', () => {
    it('同 event+revision+version+kind 已入队 → 复用已有 job_id，不重复插入', async () => {
        const client = {
            query: async (sql: string) => {
                if (sql.includes('SELECT job_id FROM stock_trace_jobs')) {
                    return { rows: [{ job_id: 'existing-job' }] };
                }
                return { rows: [] };
            },
        };

        const jobId = await StockTraceJobService.enqueue(client as never, { eventId: 'e1', triggerRevision: 2 });

        assert.strictEqual(jobId, 'existing-job', '重复入队应返回既有 job_id');
    });
});
