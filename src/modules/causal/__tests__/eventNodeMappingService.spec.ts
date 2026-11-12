/**
 * 事件→节点映射存储层单测（注入 DB，不连库）。
 * 运行：node --import tsx --test src/modules/causal/__tests__/eventNodeMappingService.spec.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    getMappings,
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
