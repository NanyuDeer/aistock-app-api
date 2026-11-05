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
    buildActiveHours,
    buildPreferredSectors,
    buildQuestionTopics,
    buildWatchEvents,
    buildWatchlistBreadth,
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

// ─────────────────────────────────────────────────────────────
// Task 2：5 维度计算规则
// ─────────────────────────────────────────────────────────────

describe('preferred_sectors（板块偏好）', () => {
    it('正常聚合：按行业计数降序取 Top5，weight 为占比，样本 16 → 置信度 0.70', async () => {
        mockResponder = (sql) => {
            if (sql.includes('FROM user_stocks') && sql.includes('JOIN stocks')) {
                return {
                    rows: [
                        { industry: '白酒', count: 3 },
                        { industry: '新能源', count: 6 },
                        { industry: '银行', count: 7 },
                    ],
                };
            }
            return { rows: [] };
        };
        const inf = await ProfileMiningService.computePreferredSectors('o_1');
        assert.ok(inf);
        assert.strictEqual(inf!.dimension, 'preferred_sectors');
        assert.strictEqual(inf!.confidence, 0.70);
        assert.strictEqual(inf!.sampleSize, 16);
        assert.strictEqual(inf!.windowDays, null, 'preferred_sectors 取当前值，window_days 为 null');
        const value = inf!.value as { items: { name: string; stock_count: number; weight: number }[]; total: number };
        assert.strictEqual(value.total, 16);
        assert.deepStrictEqual(value.items.map((i) => i.name), ['银行', '新能源', '白酒']);
        assert.strictEqual(value.items[0].stock_count, 7);
        const sum = value.items.reduce((s, i) => s + i.weight, 0);
        assert.ok(Math.abs(sum - 1) < 0.001, `weight 求和应约等于 1，实际 ${sum}`);
    });

    it('空数据 → null（不写行）', async () => {
        mockResponder = () => ({ rows: [] });
        const inf = await ProfileMiningService.computePreferredSectors('o_none');
        assert.strictEqual(inf, null);
    });

    it('样本降档：5-9 → 0.60；<5 → 0.45', () => {
        const seven = buildPreferredSectors([{ industry: '白酒', count: 7 }]);
        const three = buildPreferredSectors([{ industry: '白酒', count: 3 }]);
        assert.strictEqual(seven!.confidence, 0.60);
        assert.strictEqual(three!.confidence, 0.45);
    });

    it('industry 为空/空白串的行被过滤，不计入样本', async () => {
        mockResponder = (sql) => {
            if (sql.includes('FROM user_stocks') && sql.includes('JOIN stocks')) {
                return {
                    rows: [
                        { industry: '', count: 5 },
                        { industry: '   ', count: 2 },
                        { industry: '白酒', count: 4 },
                    ],
                };
            }
            return { rows: [] };
        };
        const inf = await ProfileMiningService.computePreferredSectors('o_1');
        assert.ok(inf);
        const value = inf!.value as { items: { name: string }[]; total: number };
        assert.strictEqual(value.total, 4, '空 industry 不应计入样本');
        assert.deepStrictEqual(value.items.map((i) => i.name), ['白酒']);
        assert.strictEqual(inf!.sampleSize, 4);
    });

    it('全部 industry 为空 → null', () => {
        const inf = buildPreferredSectors([
            { industry: '', count: 5 },
            { industry: '  ', count: 2 },
        ]);
        assert.strictEqual(inf, null);
    });

    it('Top5 截断：6 个行业只保留前 5', () => {
        const inf = buildPreferredSectors([
            { industry: 'A', count: 6 },
            { industry: 'B', count: 5 },
            { industry: 'C', count: 4 },
            { industry: 'D', count: 3 },
            { industry: 'E', count: 2 },
            { industry: 'F', count: 1 },
        ]);
        const value = inf!.value as { items: unknown[] };
        assert.strictEqual(value.items.length, 5);
    });

    it('身份双通道：SQL 同时按 openid 与 user_id（users.id 子查询）过滤', async () => {
        await ProfileMiningService.computePreferredSectors('o_1');
        const call = mockCalls.find((c) => c.sql.includes('FROM user_stocks') && c.sql.includes('JOIN stocks'));
        assert.ok(call);
        assert.ok(call!.sql.includes('us.openid = $1'));
        assert.ok(call!.sql.includes('us.user_id = (SELECT id FROM users WHERE openid = $1)'));
        assert.deepStrictEqual(call!.params, ['o_1']);
    });
});

describe('question_topics（提问主题）', () => {
    it('正常聚合：命中关键词的主题按次数降序取 Top5，样本 3 → 置信度 0.40', async () => {
        mockResponder = (sql) => {
            if (sql.includes('FROM chat_token_usage') && sql.includes('question')) {
                return {
                    rows: [
                        { question: '茅台财报怎么解读' },
                        { question: '白酒板块轮动还有机会吗' },
                        { question: '财报和板块轮动哪个更重要' },
                    ],
                };
            }
            return { rows: [] };
        };
        const inf = await ProfileMiningService.computeQuestionTopics('o_1');
        assert.ok(inf);
        assert.strictEqual(inf!.dimension, 'question_topics');
        assert.strictEqual(inf!.confidence, 0.40);
        assert.strictEqual(inf!.sampleSize, 3);
        assert.strictEqual(inf!.windowDays, 30);
        const value = inf!.value as { items: { topic: string; hits: number }[]; total: number };
        assert.strictEqual(value.total, 3);
        assert.strictEqual(value.items[0].topic, '财报业绩');
        assert.strictEqual(value.items[0].hits, 2);
        assert.strictEqual(value.items[1].topic, '板块轮动');
        assert.strictEqual(value.items[1].hits, 2);
    });

    it('同一问题命中多主题：每个主题各计 1 次（不重复计权）', () => {
        const inf = buildQuestionTopics(['财报和板块轮动怎么选']);
        const value = inf!.value as { items: { topic: string; hits: number }[]; total: number };
        assert.strictEqual(value.total, 1);
        assert.deepStrictEqual(value.items.map((i) => [i.topic, i.hits]), [
            ['财报业绩', 1],
            ['板块轮动', 1],
        ]);
    });

    it('空数据 → null', async () => {
        mockResponder = () => ({ rows: [] });
        assert.strictEqual(await ProfileMiningService.computeQuestionTopics('o_none'), null);
    });

    it('有问题但无主题命中 → null（过滤后为空不写行）', () => {
        assert.strictEqual(buildQuestionTopics(['今天天气不错', '随便聊聊']), null);
    });

    it('样本降档：≥30 → 0.65；10-29 → 0.55', () => {
        const many = buildQuestionTopics(Array.from({ length: 35 }, () => '财报'));
        const mid = buildQuestionTopics(Array.from({ length: 12 }, () => '财报'));
        assert.strictEqual(many!.confidence, 0.65);
        assert.strictEqual(mid!.confidence, 0.55);
    });

    it('Top5 截断：命中 6 个主题只保留前 5', () => {
        const inf = buildQuestionTopics([
            '财报', '央行政策', '板块轮动', '主力资金', '均线', '公告',
        ]);
        const value = inf!.value as { items: unknown[] };
        assert.strictEqual(value.items.length, 5);
    });

    it('近 30 天窗口过滤（SQL 断言）', async () => {
        await ProfileMiningService.computeQuestionTopics('o_1');
        const call = mockCalls.find((c) => c.sql.includes('FROM chat_token_usage'));
        assert.ok(call);
        assert.ok(call!.sql.includes("INTERVAL '30 days'"));
        assert.deepStrictEqual(call!.params, ['o_1']);
    });
});

describe('watch_events（洞察事件偏好）', () => {
    it('主源三类派生（涨停雷达/上涨异动/下跌异动），样本 12 → 置信度 0.60', async () => {
        mockResponder = (sql) => {
            if (sql.includes('to_regclass')) return { rows: [{ reg: null }] };
            if (sql.includes('FROM stock_trace_user_events')) {
                return {
                    rows: [
                        { type: 'limit_up_radar', count: 9 },
                        { type: 'up_move', count: 3 },
                    ],
                };
            }
            return { rows: [] };
        };
        const inf = await ProfileMiningService.computeWatchEvents('o_1');
        assert.ok(inf);
        assert.strictEqual(inf!.dimension, 'watch_events');
        assert.strictEqual(inf!.confidence, 0.60);
        assert.strictEqual(inf!.sampleSize, 12);
        assert.strictEqual(inf!.windowDays, 30);
        const value = inf!.value as { items: { type: string; count: number }[]; total: number };
        assert.strictEqual(value.total, 12);
        assert.deepStrictEqual(value.items.map((i) => i.type), ['limit_up_radar', 'up_move']);
    });

    it('SQL 由 is_limit_up / direction 派生三类 + 30 天窗口', async () => {
        mockResponder = (sql) => {
            if (sql.includes('to_regclass')) return { rows: [{ reg: null }] };
            return { rows: [] };
        };
        await ProfileMiningService.computeWatchEvents('o_1');
        const call = mockCalls.find((c) => c.sql.includes('FROM stock_trace_user_events'));
        assert.ok(call);
        assert.ok(call!.sql.includes('e.is_limit_up'));
        assert.ok(call!.sql.includes("e.direction = 'up'"));
        assert.ok(call!.sql.includes('limit_up_radar'));
        assert.ok(call!.sql.includes('up_move'));
        assert.ok(call!.sql.includes('down_move'));
        assert.ok(call!.sql.includes("INTERVAL '30 days'"));
    });

    it('空数据 → null', async () => {
        mockResponder = (sql) => {
            if (sql.includes('to_regclass')) return { rows: [{ reg: null }] };
            return { rows: [] };
        };
        assert.strictEqual(await ProfileMiningService.computeWatchEvents('o_none'), null);
    });

    it('样本降档：<5 → 0.45', () => {
        const inf = buildWatchEvents([{ type: 'down_move', count: 2 }]);
        assert.strictEqual(inf!.confidence, 0.45);
    });

    it('to_regclass 为 NULL（本地缺表）→ 安全跳过 insight push，不报错且不查 push 表', async () => {
        mockResponder = (sql) => {
            if (sql.includes('to_regclass')) return { rows: [{ reg: null }] };
            if (sql.includes('FROM stock_trace_user_events')) return { rows: [{ type: 'up_move', count: 2 }] };
            return { rows: [] };
        };
        const inf = await ProfileMiningService.computeWatchEvents('o_1');
        assert.ok(inf);
        assert.strictEqual(mockCalls.some((c) => c.sql.includes('FROM watchlist_insight_push_records')), false);
    });

    it('to_regclass 非 NULL（生产有表）→ 叠加 insight push 计数', async () => {
        mockResponder = (sql) => {
            if (sql.includes('to_regclass')) return { rows: [{ reg: 'watchlist_insight_push_records' }] };
            if (sql.includes('FROM stock_trace_user_events')) return { rows: [{ type: 'up_move', count: 2 }] };
            if (sql.includes('FROM watchlist_insight_push_records')) return { rows: [{ count: 4 }] };
            return { rows: [] };
        };
        const inf = await ProfileMiningService.computeWatchEvents('o_1');
        assert.ok(inf);
        const value = inf!.value as { items: { type: string; count: number }[]; total: number };
        assert.strictEqual(value.total, 6);
        const push = value.items.find((i) => i.type === 'insight_push');
        assert.ok(push);
        assert.strictEqual(push!.count, 4);
    });
});

describe('active_hours（活跃时段）', () => {
    it('正常聚合：按小时计数降序取 Top3，样本 33 → 置信度 0.60', async () => {
        mockResponder = (sql) => {
            if (sql.includes('EXTRACT(HOUR')) {
                return {
                    rows: [
                        { hour: 21, hits: 18 },
                        { hour: 9, hits: 10 },
                        { hour: 22, hits: 5 },
                    ],
                };
            }
            return { rows: [] };
        };
        const inf = await ProfileMiningService.computeActiveHours('o_1');
        assert.ok(inf);
        assert.strictEqual(inf!.dimension, 'active_hours');
        assert.strictEqual(inf!.confidence, 0.60);
        assert.strictEqual(inf!.sampleSize, 33);
        assert.strictEqual(inf!.windowDays, 30);
        const value = inf!.value as { items: { hour: number; hits: number }[]; total: number };
        assert.strictEqual(value.total, 33);
        assert.deepStrictEqual(value.items.map((i) => i.hour), [21, 9, 22]);
    });

    it('跨天同小时归并（防御性合并重复行）', () => {
        const inf = buildActiveHours([
            { hour: 21, hits: 10 },
            { hour: 21, hits: 5 },
            { hour: 9, hits: 3 },
        ]);
        const value = inf!.value as { items: { hour: number; hits: number }[]; total: number };
        assert.strictEqual(value.total, 18);
        assert.strictEqual(value.items[0].hour, 21);
        assert.strictEqual(value.items[0].hits, 15);
    });

    it('Top3 截断', () => {
        const inf = buildActiveHours([
            { hour: 9, hits: 9 },
            { hour: 10, hits: 8 },
            { hour: 11, hits: 7 },
            { hour: 12, hits: 6 },
        ]);
        const value = inf!.value as { items: unknown[] };
        assert.strictEqual(value.items.length, 3);
    });

    it('空数据 → null；样本 <20 → 0.45', async () => {
        mockResponder = () => ({ rows: [] });
        assert.strictEqual(await ProfileMiningService.computeActiveHours('o_none'), null);
        assert.strictEqual(buildActiveHours([{ hour: 21, hits: 9 }])!.confidence, 0.45);
    });

    it('按 Asia/Shanghai 时区聚合（SQL 断言）', async () => {
        mockResponder = () => ({ rows: [] });
        await ProfileMiningService.computeActiveHours('o_1');
        const call = mockCalls.find((c) => c.sql.includes('EXTRACT(HOUR'));
        assert.ok(call);
        assert.ok(call!.sql.includes("AT TIME ZONE 'Asia/Shanghai'"));
        assert.ok(call!.sql.includes('user_id = $1'));
    });
});

describe('watchlist_breadth（自选股宽度）', () => {
    it('当前 9 只 → band 5-15，置信度 0.70，window_days null', async () => {
        mockResponder = (sql) => {
            if (sql.includes('FROM user_stocks') && sql.includes('COUNT(*)')) return { rows: [{ count: 9 }] };
            return { rows: [] };
        };
        const inf = await ProfileMiningService.computeWatchlistBreadth('o_1');
        assert.ok(inf);
        assert.strictEqual(inf!.dimension, 'watchlist_breadth');
        assert.strictEqual(inf!.confidence, 0.70);
        assert.strictEqual(inf!.sampleSize, 9);
        assert.strictEqual(inf!.windowDays, null);
        assert.deepStrictEqual(inf!.value, { band: '5-15', count: 9 });
    });

    it('分档：<5 与 >15', () => {
        assert.deepStrictEqual(buildWatchlistBreadth(3)!.value, { band: '<5', count: 3 });
        assert.strictEqual(buildWatchlistBreadth(3)!.confidence, 0.50);
        assert.deepStrictEqual(buildWatchlistBreadth(20)!.value, { band: '>15', count: 20 });
        assert.strictEqual(buildWatchlistBreadth(20)!.confidence, 0.70);
    });

    it('空自选（0 只）→ null（样本为 0 不写行）', async () => {
        mockResponder = (sql) => {
            if (sql.includes('FROM user_stocks') && sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            return { rows: [] };
        };
        assert.strictEqual(await ProfileMiningService.computeWatchlistBreadth('o_none'), null);
    });

    it('身份双通道 SQL', async () => {
        mockResponder = () => ({ rows: [{ count: 5 }] });
        await ProfileMiningService.computeWatchlistBreadth('o_1');
        const call = mockCalls.find((c) => c.sql.includes('FROM user_stocks'));
        assert.ok(call);
        assert.ok(call!.sql.includes('us.openid = $1'));
        assert.ok(call!.sql.includes('us.user_id = (SELECT id FROM users WHERE openid = $1)'));
    });
});
