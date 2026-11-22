/**
 * GET /internal/event-node-mappings — date 分支集成测试
 *
 * 契约来源：docs/superpowers/specs/2026-11-22-l2-trigger-source-design.md §5.1
 * 这是 MCRE L2（候选生成）的事件路数据入口。
 *
 * 用例：
 * 1. ?date= → 200，按事件分组，只含有映射的事件
 * 2. ?date= 当日无映射 → 200 + 空数组（spec §6：不是系统故障）
 * 3. ?date= 非法格式 / 非真实日历日 → 400，且不查库
 * 4. ?date= 与 ?eventId= 同时给 → 400，且不查库
 * 5. ?eventId= 老路径 → 契约完全不变（cached + mappings[].reason/similarity/confirmed）
 * 6. 无参数 → 400 'eventId is required'（老 message 不变）
 *
 * Mock 策略：monkey-patch pool.query —— 与 event_conduction.spec.ts 一致，
 * 打的是 internal.ts 与 service 默认 deps 持有的同一个 pool 对象引用，不连库。
 *
 * Cleanup：after() 里 redis.disconnect()，否则 CacheService 的 setInterval 挂住进程。
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../db';
import redis from '../../redis';
import internalRouter from '../internal';

// ── Mock pool.query ──

interface MockCall {
    sql: string;
    params: unknown[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const originalQuery = pool.query.bind(pool) as any;
let mockCalls: MockCall[] = [];
let mockResponder: ((sql: string, params: unknown[]) => { rows: unknown[] }) | null = null;

(pool as any).query = function (sql: string, ...rest: unknown[]): Promise<{ rows: unknown[] }> {
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    mockCalls.push({ sql, params });
    if (mockResponder) {
        return Promise.resolve(mockResponder(sql, params));
    }
    return Promise.resolve({ rows: [] });
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Test helpers ──

const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.use('/internal', internalRouter);
    return app;
}

interface CallResult {
    status: number;
    text: string;
    json: unknown;
}

function call(app: Express, path: string): Promise<CallResult> {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            const req = http.request(
                {
                    method: 'GET',
                    hostname: '127.0.0.1',
                    port: addr.port,
                    path,
                    headers: { 'X-Internal-Token': INTERNAL_TOKEN },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => {
                        server.close();
                        const text = Buffer.concat(chunks).toString('utf8');
                        let json: unknown = null;
                        try {
                            json = JSON.parse(text);
                        } catch {
                            /* not JSON */
                        }
                        resolve({ status: res.statusCode ?? 0, text, json });
                    });
                    res.on('error', (err) => {
                        server.close();
                        reject(err);
                    });
                },
            );
            req.on('error', (err) => {
                server.close();
                reject(err);
            });
            req.end();
        });
        server.on('error', reject);
    });
}

/** 11-19 那天的真实形态：4 条映射散落在 3 个事件上（另有 15 个事件无映射） */
const ROWS_1119 = [
    {
        event_id: 'EVT-44426711',
        title: '财联社11月19日电，央行今日开展7675亿元隔夜逆回购操作',
        event_start_time: '2026-11-18T16:00:00.000Z',
        node_id: 'DR007',
        reason: 'direct_factor|macro:逆回购',
    },
    {
        event_id: 'EVT-97e1eecd',
        title: '台湾加权指数11月19日收盘下跌1768.02点，跌幅4.4%',
        event_start_time: '2026-11-18T16:00:00.000Z',
        node_id: 'SEC_SEMI',
        reason: 'direct_sector|overseas:台积电',
    },
    {
        event_id: 'EVT-fc3151c5',
        title: '尽管近期表现疲软，日本央行行长仍对消费前景持乐观态度',
        event_start_time: '2026-11-18T16:00:00.000Z',
        node_id: 'GLOBAL_RATE',
        reason: 'direct_factor|macro:日本央行',
    },
    {
        event_id: 'EVT-8a418ff5',
        title: '美股AI/半导体产业链财报（预计窗口）',
        event_start_time: '2026-11-18T16:00:00.000Z',
        node_id: 'SEC_SEMI',
        reason: 'direct_sector',
    },
];

interface DateBody {
    code: number;
    data: {
        date: string;
        events: Array<{
            eventId: string;
            title: string;
            eventStartTime: string;
            mappings: Array<{ nodeId: string; matchedBy: string | null }>;
        }>;
        total: number;
    };
}

// 整个文件共用一份 mock：还原必须放在最外层 after（模块级 hook），
// 否则后一个 describe 会打到真库——本地 .env 指向的是一个没有该表的库。
before(() => {
    mockCalls = [];
    mockResponder = null;
});

afterEach(() => {
    mockCalls = [];
    mockResponder = null;
});

after(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (pool as any).query = originalQuery;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    redis.disconnect();
});

describe('GET /internal/event-node-mappings?date=', () => {
    it('returns grouped events with only mapped ones', async () => {
        mockResponder = () => ({ rows: ROWS_1119 });

        const app = buildApp();
        const res = await call(app, '/internal/event-node-mappings?date=2026-11-19');

        assert.strictEqual(res.status, 200);
        const body = res.json as DateBody;
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.date, '2026-11-19');
        assert.strictEqual(body.data.total, 4);
        assert.strictEqual(body.data.events.length, 4);

        const first = body.data.events[0];
        assert.strictEqual(first.eventId, 'EVT-44426711');
        assert.strictEqual(first.eventStartTime, '2026-11-18T16:00:00.000Z');
        assert.deepStrictEqual(first.mappings, [
            { nodeId: 'DR007', matchedBy: 'direct_factor|macro:逆回购' },
        ]);
        // 响应结构必须是 spec §5.1 的四个键，不多不少
        assert.deepStrictEqual(Object.keys(first).sort(), [
            'eventId',
            'eventStartTime',
            'mappings',
            'title',
        ]);
        assert.deepStrictEqual(Object.keys(first.mappings[0]).sort(), ['matchedBy', 'nodeId']);
    });

    it('queries by event_start_time in Asia/Shanghai, inner-joins mappings, never publish_time', async () => {
        mockResponder = () => ({ rows: ROWS_1119 });

        const app = buildApp();
        await call(app, '/internal/event-node-mappings?date=2026-11-19');

        assert.strictEqual(mockCalls.length, 1);
        const { sql, params } = mockCalls[0];
        assert.deepStrictEqual(params, ['2026-11-19']);
        // 业务时间口径
        assert.match(sql, /event_start_time/);
        assert.doesNotMatch(sql, /publish_time/);
        // 时区固定 Asia/Shanghai（索引 idx_event_entities_start_status 同表达式）
        assert.match(sql, /date\(e\.event_start_time AT TIME ZONE 'Asia\/Shanghai'\)/);
        // 内连接：无映射的事件必须被 SQL 过滤掉，不能靠上层再筛
        assert.match(sql, /JOIN event_node_mappings/);
        assert.doesNotMatch(sql, /LEFT\s+JOIN/i);
    });

    it('returns 200 with empty events when the day has no mapped events (not an error)', async () => {
        mockResponder = () => ({ rows: [] });

        const app = buildApp();
        const res = await call(app, '/internal/event-node-mappings?date=2026-11-20');

        assert.strictEqual(res.status, 200);
        const body = res.json as DateBody;
        assert.deepStrictEqual(body.data.events, []);
        assert.strictEqual(body.data.total, 0);
        assert.strictEqual(body.data.date, '2026-11-20');
    });

    it('rejects malformed date with 400 and does not hit the DB', async () => {
        const app = buildApp();

        for (const bad of ['2026-11-9', '26-11-19', '2026/11/19', 'not-a-date']) {
            mockCalls = [];
            const res = await call(
                app,
                `/internal/event-node-mappings?date=${encodeURIComponent(bad)}`,
            );
            assert.strictEqual(res.status, 400, `expected 400 for ${bad}`);
            assert.strictEqual(mockCalls.length, 0, `must not query DB for ${bad}`);
        }
    });

    it('rejects a well-formed but non-existent calendar day with 400 (not 500)', async () => {
        const app = buildApp();
        const res = await call(app, '/internal/event-node-mappings?date=2026-02-31');

        assert.strictEqual(res.status, 400);
        assert.strictEqual(mockCalls.length, 0);
    });

    it('rejects date + eventId together with 400 and does not hit the DB', async () => {
        const app = buildApp();
        const res = await call(
            app,
            '/internal/event-node-mappings?date=2026-11-19&eventId=EVT-44426711',
        );

        assert.strictEqual(res.status, 400);
        const body = res.json as { message: string };
        assert.match(body.message, /mutually exclusive/i);
        assert.strictEqual(mockCalls.length, 0);
    });
});

describe('GET /internal/event-node-mappings?eventId= (backward compatibility)', () => {
    it('keeps the legacy contract: eventId + cached + mappings with reason/similarity/confirmed', async () => {
        mockResponder = () => ({
            rows: [
                {
                    event_id: 'EVT-44426711',
                    node_id: 'DR007',
                    similarity: '0.9100',
                    confirmed: true,
                    reason: 'direct_factor|macro:逆回购',
                    created_at: '2026-11-19T02:00:00.000Z',
                },
            ],
        });

        const app = buildApp();
        const res = await call(app, '/internal/event-node-mappings?eventId=EVT-44426711');

        assert.strictEqual(res.status, 200);
        const body = res.json as {
            code: number;
            data: {
                eventId: string;
                cached: boolean;
                mappings: Array<Record<string, unknown>>;
            };
        };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.eventId, 'EVT-44426711');
        assert.strictEqual(body.data.cached, true);
        // 老字段一个都不能少、一个都不能改名
        assert.deepStrictEqual(Object.keys(body.data.mappings[0]).sort(), [
            'confirmed',
            'createdAt',
            'eventId',
            'nodeId',
            'reason',
            'similarity',
        ]);
        assert.strictEqual(body.data.mappings[0].nodeId, 'DR007');
        assert.strictEqual(body.data.mappings[0].similarity, 0.91);

        // SQL 仍是单事件查询，不碰 event_entities
        assert.strictEqual(mockCalls.length, 1);
        assert.match(mockCalls[0].sql, /WHERE event_id = \$1/);
        assert.doesNotMatch(mockCalls[0].sql, /event_entities/);
        assert.deepStrictEqual(mockCalls[0].params, ['EVT-44426711']);
    });

    it('keeps cached=false when the event was never computed', async () => {
        mockResponder = () => ({ rows: [] });

        const app = buildApp();
        const res = await call(app, '/internal/event-node-mappings?eventId=EVT-unknown');

        assert.strictEqual(res.status, 200);
        const body = res.json as { data: { cached: boolean; mappings: unknown[] } };
        assert.strictEqual(body.data.cached, false);
        assert.deepStrictEqual(body.data.mappings, []);
    });

    it('keeps the legacy 400 message when neither param is given', async () => {
        const app = buildApp();
        const res = await call(app, '/internal/event-node-mappings');

        assert.strictEqual(res.status, 400);
        const body = res.json as { message: string };
        assert.strictEqual(body.message, 'eventId is required');
        assert.strictEqual(mockCalls.length, 0);
    });
});
