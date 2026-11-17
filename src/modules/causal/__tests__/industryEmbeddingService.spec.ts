/**
 * 行业向量服务单测（注入 DB 与 embedding，不连库不联网）。
 * 运行：node --import tsx --test src/modules/causal/__tests__/industryEmbeddingService.spec.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    EMBEDDING_DIM,
    EMBEDDING_MODEL,
    checkModelConsistency,
    cosine,
    rebuildIndustryEmbeddings,
    semanticSearchIndustries,
    type EmbeddingDeps,
} from '../industryEmbeddingService';

function unitAt(index: number): number[] {
    const v = new Array<number>(EMBEDDING_DIM).fill(0);
    v[index] = 1;
    return v;
}

function makeDeps(rows: Record<string, unknown>[], industries: string[] = []): {
    deps: EmbeddingDeps;
    queries: Array<{ sql: string; params: unknown[] }>;
    embedCalls: string[][];
} {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const embedCalls: string[][] = [];
    const deps: EmbeddingDeps = {
        query: async (sql, params) => {
            queries.push({ sql, params });
            if (sql.includes('DISTINCT industry')) {
                return { rows: industries.map((name) => ({ industry: name })) };
            }
            if (sql.includes('GROUP BY model')) {
                return { rows };
            }
            if (sql.startsWith('INSERT')) {
                return { rows: [], rowCount: 1 };
            }
            return { rows };
        },
        embed: async (texts) => {
            embedCalls.push(texts);
            return texts.map((_, i) => unitAt(i));
        },
    };
    return { deps, queries, embedCalls };
}

describe('cosine', () => {
    it('相同向量的相似度为 1', () => {
        const v = [0.6, 0.8];
        assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9);
    });

    it('正交向量为 0，反向为 -1', () => {
        assert.equal(cosine([1, 0], [0, 1]), 0);
        assert.equal(cosine([1, 0], [-1, 0]), -1);
    });

    it('长度不等时按较短长度计算，不抛错', () => {
        const result = cosine([1, 0, 0], [1, 0]);
        assert.ok(Math.abs(result - 1) < 1e-9);
    });

    it('零向量返回 0，不产生 NaN', () => {
        assert.equal(cosine([0, 0], [1, 0]), 0);
    });
});

describe('semanticSearchIndustries', () => {
    it('按相似度降序返回，并过滤低于阈值的', async () => {
        const query = unitAt(0);
        const { deps } = makeDeps([
            { industry_name: '半导体', embedding: unitAt(0) }, // 1.0
            { industry_name: '光模块', embedding: unitAt(1) }, // 0
        ]);

        const result = await semanticSearchIndustries(query, 0.7, 5, deps);

        assert.equal(result.length, 1);
        assert.equal(result[0].name, '半导体');
        assert.equal(result[0].similarity, 1);
    });

    it('按 limit 截断', async () => {
        const query = unitAt(0);
        const { deps } = makeDeps([
            { industry_name: 'A', embedding: unitAt(0) },
            { industry_name: 'B', embedding: unitAt(0) },
            { industry_name: 'C', embedding: unitAt(0) },
        ]);

        const result = await semanticSearchIndustries(query, 0.5, 2, deps);
        assert.equal(result.length, 2);
    });

    it('兼容 pg 返回的 {…} 字符串数组格式', async () => {
        const query = unitAt(0);
        const vector = `{${unitAt(0).join(',')}}`;
        const { deps } = makeDeps([{ industry_name: '半导体', embedding: vector }]);

        const result = await semanticSearchIndustries(query, 0.5, 5, deps);
        assert.equal(result.length, 1);
        assert.equal(result[0].name, '半导体');
    });

    it('维度不符时抛错，不静默返回空', async () => {
        const { deps } = makeDeps([]);
        await assert.rejects(
            semanticSearchIndustries([1, 2, 3], 0.7, 5, deps),
            /查询向量维度不符/,
        );
    });
});

describe('checkModelConsistency', () => {
    it('模型一致时不报不一致', async () => {
        const { deps } = makeDeps([{ model: EMBEDDING_MODEL, n: '110' }]);
        const state = await checkModelConsistency(deps);
        assert.equal(state.total, 110);
        assert.equal(state.mismatched, 0);
    });

    it('混入旧模型时统计出不一致条数', async () => {
        const { deps } = makeDeps([
            { model: EMBEDDING_MODEL, n: '100' },
            { model: 'text-embedding-3-small', n: '10' },
        ]);
        const state = await checkModelConsistency(deps);
        assert.equal(state.total, 110);
        assert.equal(state.mismatched, 10);
        assert.deepEqual(state.models.sort(), [EMBEDDING_MODEL, 'text-embedding-3-small'].sort());
    });

    it('空表时返回 0 条', async () => {
        const { deps } = makeDeps([]);
        const state = await checkModelConsistency(deps);
        assert.equal(state.total, 0);
    });
});

describe('rebuildIndustryEmbeddings', () => {
    it('按批次调用 embedding 并逐条写入', async () => {
        const { deps, embedCalls } = makeDeps([], ['半导体', '光模块', '基建']);
        const written = await rebuildIndustryEmbeddings(2, deps);

        assert.equal(written, 3);
        // 3 个行业、批大小 2 → 两次调用（2 + 1）
        assert.equal(embedCalls.length, 2);
        assert.deepEqual(embedCalls[0], ['半导体', '光模块']);
        assert.deepEqual(embedCalls[1], ['基建']);
    });

    it('写入时带上模型名，便于后续一致性检查', async () => {
        const { deps, queries } = makeDeps([], ['半导体']);
        await rebuildIndustryEmbeddings(10, deps);

        const insert = queries.find((q) => q.sql.startsWith('INSERT'));
        assert.ok(insert);
        assert.equal(insert.params[2], EMBEDDING_MODEL);
    });

    it('行业列表为空时不做任何 embedding 调用', async () => {
        const { deps, embedCalls } = makeDeps([], []);
        const written = await rebuildIndustryEmbeddings(10, deps);
        assert.equal(written, 0);
        assert.equal(embedCalls.length, 0);
    });
});
