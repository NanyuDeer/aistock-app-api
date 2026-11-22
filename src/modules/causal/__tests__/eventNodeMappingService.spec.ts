/**
 * 事件→节点映射存储层单测（注入 DB，不连库）。
 * 运行：node --import tsx --test src/modules/causal/__tests__/eventNodeMappingService.spec.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    getMappings,
    getMappingsByDate,
    isValidDateParam,
    upsertMappings,
    type MappingDeps,
} from '../eventNodeMappingService';

function makeDeps(
    options: {
        rows?: Record<string, unknown>[];
        rowCount?: number;
    } = {},
): { deps: MappingDeps; calls: Array<{ sql: string; params: unknown[] }> } {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const deps: MappingDeps = {
        query: async (sql, params) => {
            calls.push({ sql, params });
            return {
                rowCount: options.rowCount ?? (options.rows?.length ?? 1),
                rows: options.rows ?? [],
            };
        },
    };
    return { deps, calls };
}

describe('upsertMappings', () => {
    it('逐条写入并返回行数', async () => {
        const { deps, calls } = makeDeps({ rowCount: 1 });

        const written = await upsertMappings(
            'evt_1',
            [
                { nodeId: 'SEC_SEMI', similarity: 0.82, confirmed: true, reason: 'direct_sector' },
                { nodeId: 'THEME_AI_COMPUTE', similarity: 0.71, confirmed: false },
            ],
            deps,
        );

        assert.equal(written, 2);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0].params.slice(0, 2), ['evt_1', 'SEC_SEMI']);
    });

    it('similarity 越界直接报错', async () => {
        const { deps } = makeDeps();
        await assert.rejects(
            upsertMappings('evt_1', [{ nodeId: 'SEC_SEMI', similarity: 1.2, confirmed: true }], deps),
            /similarity out of range/,
        );
        await assert.rejects(
            upsertMappings('evt_1', [{ nodeId: 'SEC_SEMI', similarity: Number.NaN, confirmed: true }], deps),
            /similarity out of range/,
        );
    });

    it('空 mappings 返回 0 且不查库', async () => {
        const { deps, calls } = makeDeps();
        assert.equal(await upsertMappings('evt_1', [], deps), 0);
        assert.equal(calls.length, 0);
    });

    it('eventId 为空报错', async () => {
        const { deps } = makeDeps();
        await assert.rejects(upsertMappings('', [], deps), /eventId must not be empty/);
    });

    it('nodeId 为空报错', async () => {
        const { deps } = makeDeps();
        await assert.rejects(
            upsertMappings('evt_1', [{ nodeId: '', similarity: 0.5, confirmed: true }], deps),
            /empty nodeId/,
        );
    });
});

describe('getMappings', () => {
    it('有记录时 cached=true 并按 confirmed 优先排序返回', async () => {
        const { deps } = makeDeps({
            rows: [
                {
                    event_id: 'evt_1',
                    node_id: 'SEC_SEMI',
                    similarity: '0.8200',
                    confirmed: true,
                    reason: 'direct_sector',
                    created_at: '2026-11-12T02:00:00.000Z',
                },
            ],
        });

        const result = await getMappings('evt_1', deps);

        assert.equal(result.cached, true);
        assert.equal(result.mappings[0].nodeId, 'SEC_SEMI');
        assert.equal(result.mappings[0].similarity, 0.82);
        assert.equal(result.mappings[0].confirmed, true);
    });

    it('无记录时 cached=false', async () => {
        const { deps } = makeDeps({ rows: [] });
        const result = await getMappings('evt_missing', deps);

        assert.equal(result.cached, false);
        assert.deepEqual(result.mappings, []);
    });

    it('有记录但全部未确认时 cached 仍为 true（关键：否则每次回放都重算）', async () => {
        const { deps } = makeDeps({
            rows: [
                {
                    event_id: 'evt_2',
                    node_id: 'THEME_AI_COMPUTE',
                    similarity: '0.6100',
                    confirmed: false,
                    reason: 'no path to scope',
                    created_at: '2026-11-12T02:00:00.000Z',
                },
            ],
        });

        const result = await getMappings('evt_2', deps);

        assert.equal(result.cached, true);
        assert.equal(result.mappings.length, 1);
        assert.equal(result.mappings[0].confirmed, false);
    });

    it('eventId 为空报错', async () => {
        const { deps } = makeDeps();
        await assert.rejects(getMappings('', deps), /eventId must not be empty/);
    });
});

describe('isValidDateParam', () => {
    it('接受合法日历日', () => {
        assert.equal(isValidDateParam('2026-11-19'), true);
        assert.equal(isValidDateParam('2024-02-29'), true); // 闰年
    });

    it('拒绝格式错误', () => {
        for (const bad of ['2026-11-9', '26-11-19', '2026/11/19', '2026-11-19T00:00', '', 'abcd-ef-gh']) {
            assert.equal(isValidDateParam(bad), false, `should reject ${bad}`);
        }
    });

    it('拒绝格式对但日历上不存在的日期（否则 Postgres 会抛错变 500）', () => {
        assert.equal(isValidDateParam('2026-02-31'), false);
        assert.equal(isValidDateParam('2026-13-01'), false);
        assert.equal(isValidDateParam('2025-02-29'), false); // 平年
    });
});

describe('getMappingsByDate', () => {
    it('按事件分组：一个事件多个节点 → 一个 event，多个 mappings', async () => {
        const { deps, calls } = makeDeps({
            rows: [
                {
                    event_id: 'EVT-a',
                    title: '央行隔夜逆回购 7675 亿',
                    event_start_time: '2026-11-18T16:00:00.000Z',
                    node_id: 'DR007',
                    reason: 'direct_factor|macro:逆回购',
                },
                {
                    event_id: 'EVT-a',
                    title: '央行隔夜逆回购 7675 亿',
                    event_start_time: '2026-11-18T16:00:00.000Z',
                    node_id: 'LIQUIDITY',
                    reason: 'direct_factor|macro:逆回购',
                },
                {
                    event_id: 'EVT-b',
                    title: '台湾加权指数收跌 4.4%',
                    event_start_time: '2026-11-18T16:00:00.000Z',
                    node_id: 'SEC_SEMI',
                    reason: 'direct_sector|overseas:台积电',
                },
            ],
        });

        const result = await getMappingsByDate('2026-11-19', deps);

        assert.equal(result.total, 2);
        assert.equal(result.events.length, 2);
        assert.equal(result.events[0].eventId, 'EVT-a');
        assert.deepEqual(result.events[0].mappings.map((m) => m.nodeId), ['DR007', 'LIQUIDITY']);
        assert.equal(result.events[0].mappings[0].matchedBy, 'direct_factor|macro:逆回购');
        assert.equal(result.events[0].eventStartTime, '2026-11-18T16:00:00.000Z');
        assert.equal(result.events[1].mappings.length, 1);
        assert.equal(result.events[1].mappings[0].nodeId, 'SEC_SEMI');

        // 参数只传 date，且时区口径写死在 SQL 里
        assert.deepEqual(calls[0].params, ['2026-11-19']);
        assert.match(calls[0].sql, /AT TIME ZONE 'Asia\/Shanghai'/);
    });

    it('当日无映射事件 → 空数组且 total=0（不是异常）', async () => {
        const { deps } = makeDeps({ rows: [] });
        const result = await getMappingsByDate('2026-11-19', deps);

        assert.deepEqual(result.events, []);
        assert.equal(result.total, 0);
    });

    it('reason 为 null 时 matchedBy 输出 null（不缺键）', async () => {
        const { deps } = makeDeps({
            rows: [
                {
                    event_id: 'EVT-c',
                    title: 't',
                    event_start_time: '2026-11-18T16:00:00.000Z',
                    node_id: 'SEC_SEMI',
                    reason: null,
                },
            ],
        });

        const result = await getMappingsByDate('2026-11-19', deps);

        assert.ok(Object.prototype.hasOwnProperty.call(result.events[0].mappings[0], 'matchedBy'));
        assert.equal(result.events[0].mappings[0].matchedBy, null);
    });

    it('日期非法直接报错且不查库', async () => {
        const { deps, calls } = makeDeps();
        await assert.rejects(getMappingsByDate('2026-02-31', deps), /real calendar date/);
        assert.equal(calls.length, 0);
    });
});
