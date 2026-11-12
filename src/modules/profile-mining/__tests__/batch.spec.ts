/**
 * 每日挖掘批次测试（Task 3）
 *
 * 覆盖：opt-in 过滤（enabled=0 / 无行用户零查询）、单用户失败隔离、
 * 同日重跑幂等（ON CONFLICT upsert）、批次异常不上抛（永不阻断主流程）。
 *
 * Mock strategy: 同 rules.spec.ts——monkey-patch pool.query，按 SQL 特征返回不同 mock rows。
 */
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../../core/db';
import { ProfileMiningService } from '../ProfileMiningService';

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

const EMPTY_PER_DIMENSION = {
    preferred_sectors: 0,
    question_topics: 0,
    watch_events: 0,
    active_hours: 0,
    watchlist_breadth: 0,
};

/** 为指定用户集返回完整 5 维度数据（batch 聚合 SQL 的特征分派）。 */
function responderForUserIds(userIds: string[]): (sql: string, params: unknown[]) => MockResult {
    return (sql: string): MockResult => {
        if (sql.includes('FROM user_settings')) {
            return { rows: userIds.map((openid) => ({ openid })) };
        }
        if (sql.includes('to_regclass')) {
            return { rows: [{ reg: null }] };
        }
        if (sql.includes('FROM user_stocks us') && sql.includes('JOIN stocks')) {
            return { rows: userIds.map((user_id) => ({ user_id, industry: '白酒', count: 12 })) };
        }
        if (sql.includes('FROM user_stocks us') && sql.includes('COUNT(*)')) {
            return { rows: userIds.map((user_id) => ({ user_id, count: 9 })) };
        }
        if (sql.includes('FROM chat_token_usage') && sql.includes('question')) {
            return { rows: userIds.map((user_id) => ({ user_id, question: '财报怎么样' })) };
        }
        if (sql.includes('FROM stock_trace_user_events')) {
            return { rows: userIds.map((user_id) => ({ user_id, type: 'up_move', count: 6 })) };
        }
        if (sql.includes('EXTRACT(HOUR')) {
            return { rows: userIds.map((user_id) => ({ user_id, hour: 21, hits: 20 })) };
        }
        if (sql.includes('INSERT INTO user_profile_inferences')) {
            return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    };
}

describe('runDailyMining', () => {
    it('opt-in 过滤：只聚合 enabled=1 的用户；未开启/无行用户不进入聚合查询', async () => {
        mockResponder = responderForUserIds(['o_on']);
        const result = await ProfileMiningService.runDailyMining();

        assert.strictEqual(result.users, 1);
        assert.strictEqual(result.ok, 1);
        assert.strictEqual(result.failed, 0);
        assert.deepStrictEqual(result.perDimension, {
            preferred_sectors: 1,
            question_topics: 1,
            watch_events: 1,
            active_hours: 1,
            watchlist_breadth: 1,
        });

        // 第一条 SQL 必须按 setting_type='profile_mining' AND enabled=1 取用户
        assert.ok(mockCalls.length > 1);
        assert.ok(mockCalls[0].sql.includes("setting_type = 'profile_mining'"));
        assert.ok(mockCalls[0].sql.includes('enabled = 1'));

        // 所有批量取数只带 opt-in 用户（o_off 即使有数据也不会被查询）
        const batchCalls = mockCalls.filter((c) => c.sql.includes('ANY($1::text[])'));
        assert.ok(batchCalls.length >= 5, '5 个维度应各有一条批量聚合 SQL');
        for (const call of batchCalls) {
            assert.deepStrictEqual(call.params, [['o_on']]);
        }
    });

    it('watch_events 聚合按「用户 + 派生类型」分组（防 PG 42803 静默丢维度）', async () => {
        mockResponder = responderForUserIds(['o_on']);
        await ProfileMiningService.runDailyMining();

        const call = mockCalls.find((c) => c.sql.includes('FROM stock_trace_user_events'));
        assert.ok(call, '应有一条 watch_events 批量聚合 SQL');
        // 回归护栏：GROUP BY ... 1 只分组到 openid，CASE 列不在分组内 → PG 报 42803，
        // 被 safeBatch 吞成 warning 后该维度永不产出（2026-11-05 集成冒烟实测踩到）。
        // mock 不校验 SQL 语义，只能锁死分组位次。
        assert.match(call!.sql, /GROUP BY\s+ue\.openid\s*,\s*2/i, 'watch_events 必须按第 2 列（CASE 派生类型）分组');
        assert.doesNotMatch(call!.sql, /GROUP BY\s+ue\.openid\s*,\s*1\b/i, '不得退回按第 1 列分组');
    });

    it('0 个 opt-in 用户 → 仅一条用户查询，其余维度零查询', async () => {
        mockResponder = (sql) => (sql.includes('FROM user_settings') ? { rows: [] } : { rows: [] });
        const result = await ProfileMiningService.runDailyMining();

        assert.deepStrictEqual(result, { users: 0, ok: 0, failed: 0, perDimension: EMPTY_PER_DIMENSION });
        assert.strictEqual(mockCalls.length, 1, '无 opt-in 用户时不得触发任何聚合 SQL');
    });

    it('单用户写回失败 → 隔离该用户，其他用户照常成功', async () => {
        mockResponder = (sql, params) => {
            const base = responderForUserIds(['o_a', 'o_b'])(sql, params);
            if (sql.includes('INSERT INTO user_profile_inferences') && params[0] === 'o_a') {
                throw new Error('insert boom');
            }
            return base;
        };
        const result = await ProfileMiningService.runDailyMining();

        assert.strictEqual(result.users, 2);
        assert.strictEqual(result.ok, 1, 'o_b 应成功');
        assert.strictEqual(result.failed, 1, 'o_a 应计入 failed');
        // 每个维度只产出 1 行（来自 o_b）
        assert.strictEqual(result.perDimension.preferred_sectors, 1);
        assert.strictEqual(result.perDimension.question_topics, 1);
    });

    it('同日重跑幂等：upsert 均为 ON CONFLICT DO UPDATE，重复跑产出相同维度计数', async () => {
        mockResponder = responderForUserIds(['o_1']);
        const first = await ProfileMiningService.runDailyMining();
        const firstInsertCalls = mockCalls.filter((c) => c.sql.includes('INSERT INTO user_profile_inferences'));

        mockCalls = [];
        const second = await ProfileMiningService.runDailyMining();
        const secondInsertCalls = mockCalls.filter((c) => c.sql.includes('INSERT INTO user_profile_inferences'));

        assert.deepStrictEqual(first.perDimension, second.perDimension);
        assert.strictEqual(firstInsertCalls.length, 5);
        assert.strictEqual(secondInsertCalls.length, 5);
        for (const call of [...firstInsertCalls, ...secondInsertCalls]) {
            assert.ok(call.sql.includes('ON CONFLICT (user_id, dimension) DO UPDATE'));
        }
    });

    it('opt-in 查询异常 → 批次不抛出（永不阻断主流程）', async () => {
        mockResponder = (sql) => {
            if (sql.includes('FROM user_settings')) throw new Error('db down');
            return { rows: [] };
        };
        const result = await ProfileMiningService.runDailyMining();
        assert.deepStrictEqual(result, { users: 0, ok: 0, failed: 0, perDimension: EMPTY_PER_DIMENSION });
    });

    it('单维度批量取数异常 → 该维度跳过，其他维度与用户写回不受影响', async () => {
        mockResponder = (sql, params) => {
            if (sql.includes('FROM user_stocks us') && sql.includes('JOIN stocks')) {
                throw new Error('sector query boom');
            }
            return responderForUserIds(['o_1'])(sql, params);
        };
        const result = await ProfileMiningService.runDailyMining();

        assert.strictEqual(result.users, 1);
        assert.strictEqual(result.ok, 1);
        assert.strictEqual(result.perDimension.preferred_sectors, 0, '失败维度不产出');
        assert.strictEqual(result.perDimension.question_topics, 1, '其他维度不受影响');
        assert.strictEqual(result.perDimension.active_hours, 1);
    });
});
