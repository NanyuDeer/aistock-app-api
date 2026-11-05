/**
 * 用户画像自动挖掘（一期）— 推断表读写 + 5 维度规则测试
 *
 * Mock strategy: 沿用 modules/user/__tests__/profile.spec.ts 的做法——
 * monkey-patch pool.query 记录 SQL 并返回 mock rows，不连真实 DB。
 * DDL 的 CHECK 约束无法用 mock 验证真实 DB 行为，改为断言建表 DDL 文本
 * 含 CHECK 约束 + Service 侧对越界 confidence 的显式拒绝。
 */
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../../core/db';
import {
    ProfileMiningService,
    USER_PROFILE_INFERENCES_DDL,
} from '../ProfileMiningService';

interface MockCall {
    sql: string;
    params: unknown[];
}

interface MockResult {
    rows: unknown[];
    rowCount?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const originalQuery = pool.query.bind(pool) as any;
let mockCalls: MockCall[] = [];
let mockResponder: ((sql: string, params: unknown[]) => MockResult) | null = null;

(pool as any).query = function (sql: string, ...rest: unknown[]): Promise<MockResult> {
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    mockCalls.push({ sql, params });
    if (mockResponder) {
        return Promise.resolve(mockResponder(sql, params));
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
};
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
    mockCalls = [];
    mockResponder = () => ({ rows: [], rowCount: 0 });
});

after(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (pool as any).query = originalQuery;
    /* eslint-enable @typescript-eslint/no-explicit-any */
});

// ─────────────────────────────────────────────────────────────
// Task 1：user_profile_inferences 建表 DDL + 读写服务
// ─────────────────────────────────────────────────────────────

describe('user_profile_inferences DDL', () => {
    it('建表语句包含 IF NOT EXISTS、主键 (user_id, dimension) 与 confidence CHECK 约束', () => {
        assert.ok(USER_PROFILE_INFERENCES_DDL.includes('CREATE TABLE IF NOT EXISTS user_profile_inferences'));
        assert.ok(USER_PROFILE_INFERENCES_DDL.includes('PRIMARY KEY (user_id, dimension)'));
        assert.ok(USER_PROFILE_INFERENCES_DDL.includes('CHECK (confidence >= 0 AND confidence <= 1)'));
        assert.ok(USER_PROFILE_INFERENCES_DDL.includes('value        JSONB NOT NULL'));
        assert.ok(USER_PROFILE_INFERENCES_DDL.includes('sample_size  INTEGER NOT NULL DEFAULT 0'));
    });
});

describe('upsertInference', () => {
    it('写入走 INSERT ... ON CONFLICT (user_id, dimension) DO UPDATE，且刷新 inferred_at', async () => {
        await ProfileMiningService.upsertInference('o_1', 'question_topics', { items: [], total: 0 }, 0.55, 12, 30);

        const call = mockCalls.find((c) => c.sql.includes('INSERT INTO user_profile_inferences'));
        assert.ok(call, 'expected INSERT INTO user_profile_inferences');
        assert.ok(call!.sql.includes('ON CONFLICT (user_id, dimension) DO UPDATE'));
        assert.ok(call!.sql.includes('inferred_at = CURRENT_TIMESTAMP'));
        assert.ok(call!.sql.includes('updated_at = CURRENT_TIMESTAMP'));
        // 参数顺序：user_id, dimension, value(JSON 文本), confidence, sample_size, window_days
        assert.deepStrictEqual(call!.params, [
            'o_1',
            'question_topics',
            '{"items":[],"total":0}',
            0.55,
            12,
            30,
        ]);
    });

    it('window_days 允许 null（取当前值的维度）', async () => {
        await ProfileMiningService.upsertInference('o_1', 'watchlist_breadth', { band: '5-15', count: 9 }, 0.70, 9, null);
        const call = mockCalls.find((c) => c.sql.includes('INSERT INTO user_profile_inferences'));
        assert.ok(call);
        assert.strictEqual(call!.params[5], null);
    });

    it('confidence 越界（>1 或 <0）→ 抛 RangeError 且不触达 SQL', async () => {
        await assert.rejects(
            () => ProfileMiningService.upsertInference('o_1', 'active_hours', {}, 1.01, 1, 30),
            RangeError,
        );
        await assert.rejects(
            () => ProfileMiningService.upsertInference('o_1', 'active_hours', {}, -0.01, 1, 30),
            RangeError,
        );
        assert.strictEqual(mockCalls.length, 0, '越界 confidence 不应触达 SQL');
    });
});

describe('listInferences', () => {
    it('无数据 → 返回空数组', async () => {
        const rows = await ProfileMiningService.listInferences('o_none');
        assert.deepStrictEqual(rows, []);
        const call = mockCalls.find((c) => c.sql.includes('FROM user_profile_inferences'));
        assert.ok(call);
        assert.deepStrictEqual(call!.params, ['o_none']);
    });

    it('有数据 → 原样返回维度行', async () => {
        mockResponder = (sql) => {
            if (sql.includes('FROM user_profile_inferences')) {
                return {
                    rows: [{
                        dimension: 'question_topics',
                        value: { items: [{ topic: '财报业绩', hits: 3 }], total: 3 },
                        confidence: '0.55',
                        sample_size: 3,
                        window_days: 30,
                        inferred_at: new Date('2026-11-05T00:30:00Z'),
                    }],
                };
            }
            return { rows: [] };
        };
        const rows = await ProfileMiningService.listInferences('o_1');
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].dimension, 'question_topics');
        assert.deepStrictEqual(rows[0].value, { items: [{ topic: '财报业绩', hits: 3 }], total: 3 });
    });
});

describe('deleteInferences', () => {
    it('返回删除行数（rowCount）', async () => {
        mockResponder = (sql) => {
            if (sql.includes('DELETE FROM user_profile_inferences')) {
                return { rows: [], rowCount: 3 };
            }
            return { rows: [], rowCount: 0 };
        };
        const deleted = await ProfileMiningService.deleteInferences('o_1');
        assert.strictEqual(deleted, 3);
        const call = mockCalls.find((c) => c.sql.includes('DELETE FROM user_profile_inferences'));
        assert.ok(call);
        assert.deepStrictEqual(call!.params, ['o_1']);
    });

    it('无数据 → 返回 0', async () => {
        const deleted = await ProfileMiningService.deleteInferences('o_none');
        assert.strictEqual(deleted, 0);
    });
});
