/**
 * Attribution Feedback Router — POST /api/internal/attribution-feedback（弱反馈审计落库）
 * + GET /api/agent/attribution-feedback/:date（读取）测试（Phase 7 Task 7.1）。
 *
 * 用例（brief 契约）：
 * 1. POST 无/错 X-Internal-Token → 401 且不触达 DB
 * 2. POST date 非 YYYY-MM-DD → 400 且不触达 DB
 * 3. POST unit_key 缺失/空白/超长 → 400 且不触达 DB
 * 4. POST mode 非法（空串/超长/含非法字符）→ 400 且不触达 DB
 * 5. POST 计数字段非法（负数/非整数/布尔）→ 400；hit+miss !== sample_size → 400
 * 6. POST hit_rate 非法（sample_size>0 为 null / 越界 / 非数）→ 400；
 *    sample_size=0 且 hit_rate=null → 200（空样本合法）
 * 7. POST suggestion 越界 → 400；detail 非对象 → 400
 * 8. POST 合法 → 200 {code:200,data}；SQL 为 INSERT ... ON CONFLICT（不内联建表）
 * 9. POST 同 (date, unit_key) 二次（不同计数）→ upsert 覆盖，行数仍 1（幂等）
 * 10. GET date 非法 → 400；查无 → 200 + {date, signals: []}（降级不报错）
 * 11. GET 读回 camelCase 且 hit_rate 为 number（pg numeric 返 string 的坑）
 *
 * Mock strategy（对齐 attributionChain.spec.ts）：monkey-patch pool.query，用内存
 * Map<`${date}|${unit_key}`, row> 模拟 attribution_feedback_signals 表的
 * INSERT ... ON CONFLICT upsert / SELECT 两分支，使 POST→GET 读回与幂等可端到端断言
 * （建表由 021 migration 负责，不在本路由 SQL 序列内）。
 */
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../db';
import { attributionFeedbackRouter } from '../attributionFeedbackRouter';

interface MockCall {
    sql: string;
    params: unknown[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const originalQuery = pool.query.bind(pool) as any;
let mockCalls: MockCall[] = [];
// 内存 DB 模拟：`${date}|${unit_key}` → row（模拟表 upsert 语义，PK=(date, unit_key)）
const store = new Map<string, Record<string, unknown>>();

(pool as any).query = function (sql: string, ...rest: unknown[]): Promise<{ rows: unknown[] }> {
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    mockCalls.push({ sql, params });
    if (/INSERT INTO attribution_feedback_signals/i.test(sql)) {
        const key = `${String(params[0])}|${String(params[1])}`;
        store.set(key, {
            date: params[0],
            unit_key: params[1],
            mode: params[2],
            sample_size: params[3],
            hit_count: params[4],
            miss_count: params[5],
            // pg numeric 读取为 string —— 路由须 Number() 归一（D2 同源教训）
            hit_rate: params[6] === null ? null : String(params[6]),
            suggestion: params[7],
            detail: params[8] === null ? null : JSON.parse(String(params[8])),
            created_at: new Date('2026-09-17T08:10:00Z'),
        });
        return Promise.resolve({ rows: [] });
    }
    if (/SELECT[\s\S]*FROM attribution_feedback_signals/i.test(sql)) {
        const date = String(params[0]);
        const rows = [...store.values()]
            .filter((row) => row.date === date)
            .sort((a, b) => String(a.unit_key).localeCompare(String(b.unit_key)));
        return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [] });
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const JSON_HEADERS = { 'content-type': 'application/json' };
const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';
const POST_HEADERS = { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN };

const DATE = '2026-09-17';
const PATH = '/api/internal/attribution-feedback';

const VALID_BODY = {
    date: DATE,
    unit_key: 'relation:self_driven',
    mode: 'observe',
    sample_size: 12,
    hit_count: 4,
    miss_count: 8,
    hit_rate: 0.3333,
    suggestion: 'downgrade',
    detail: { window: 60, min_samples: 10, low_threshold: 0.35 },
};

/** 以 patch 覆盖单字段构造 body（其余保持合法），便于聚焦字段校验 */
function bodyWith(patch: Record<string, unknown>): Record<string, unknown> {
    return { ...VALID_BODY, ...patch };
}

function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.use('/api', attributionFeedbackRouter);
    return app;
}

interface CallResult {
    status: number;
    json: unknown;
}

function call(
    app: Express,
    opts: { method: string; path: string; headers?: http.OutgoingHttpHeaders; body?: unknown },
): Promise<CallResult> {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            const req = http.request(
                {
                    method: opts.method,
                    hostname: '127.0.0.1',
                    port: addr.port,
                    path: opts.path,
                    headers: opts.headers,
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
                            /* 非 JSON */
                        }
                        resolve({ status: res.statusCode ?? 0, json });
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
            if (opts.body !== undefined) {
                req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
            }
            req.end();
        });
        server.on('error', reject);
    });
}

async function post(body: unknown, headers: http.OutgoingHttpHeaders = POST_HEADERS): Promise<CallResult> {
    return call(buildApp(), { method: 'POST', path: PATH, headers, body });
}

beforeEach(() => {
    mockCalls = [];
    store.clear();
});

after(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (pool as any).query = originalQuery;
    /* eslint-enable @typescript-eslint/no-explicit-any */
});

describe('POST /api/internal/attribution-feedback', () => {
    it('无 X-Internal-Token → 401，且不触达 DB', async () => {
        const res = await post(VALID_BODY, JSON_HEADERS);
        assert.strictEqual(res.status, 401);
        assert.deepStrictEqual(res.json, { code: 401, message: 'invalid internal token' });
        assert.strictEqual(mockCalls.length, 0, '未鉴权请求应在落库前拦截');
    });

    it('错误 X-Internal-Token → 401，且不触达 DB', async () => {
        const res = await post(VALID_BODY, {
            'content-type': 'application/json',
            'x-internal-token': 'wrong-token',
        });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(mockCalls.length, 0, '错误 token 请求应在落库前拦截');
    });

    it('date 非 YYYY-MM-DD → 400，且不触达 DB', async () => {
        const res = await post(bodyWith({ date: 'foo' }));
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.json, {
            code: 400,
            message: 'invalid date format: foo（需要 YYYY-MM-DD）',
        });
        assert.strictEqual(mockCalls.length, 0, '非法 date 应在落库前拦截');
    });

    it('unit_key 缺失 / 空白 / 超长 → 400，且不触达 DB', async () => {
        for (const unitKey of [undefined, '   ', 'x'.repeat(201)]) {
            const res = await post(bodyWith({ unit_key: unitKey }));
            assert.strictEqual(res.status, 400, `unit_key=${String(unitKey)} 应 400`);
            assert.deepStrictEqual(res.json, { code: 400, message: 'unit_key must be a non-empty string' });
        }
        assert.strictEqual(mockCalls.length, 0, '非法 unit_key 应在落库前拦截');
    });

    it('mode 非法（空串 / 超长 / 含大写或连字符）→ 400，且不触达 DB', async () => {
        for (const mode of ['', 'OBSERVE', 'ob-serve', 'x'.repeat(33)]) {
            const res = await post(bodyWith({ mode }));
            assert.strictEqual(res.status, 400, `mode=${mode} 应 400`);
            assert.deepStrictEqual(res.json, {
                code: 400,
                message: 'mode must be a lowercase token (≤32 chars)',
            });
        }
        assert.strictEqual(mockCalls.length, 0, '非法 mode 应在落库前拦截');
    });

    it('计数字段非法（负数 / 非整数 / 布尔 / 非数）→ 400，且不触达 DB', async () => {
        for (const patch of [
            { sample_size: -1 },
            { sample_size: 1.5 },
            { hit_count: true },
            { miss_count: '3' },
        ]) {
            const res = await post(bodyWith(patch));
            assert.strictEqual(res.status, 400, `${JSON.stringify(patch)} 应 400`);
            assert.strictEqual(
                (res.json as { message: string }).message.includes('non-negative integer'),
                true,
            );
        }
        assert.strictEqual(mockCalls.length, 0, '非法计数应在落库前拦截');
    });

    it('hit_count + miss_count !== sample_size → 400，且不触达 DB', async () => {
        const res = await post(bodyWith({ hit_count: 4, miss_count: 7, sample_size: 12 }));
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.json, {
            code: 400,
            message: 'hit_count + miss_count must equal sample_size',
        });
        assert.strictEqual(mockCalls.length, 0);
    });

    it('hit_rate 非法（样本>0 为 null / 越界 / 非数）→ 400，且不触达 DB', async () => {
        for (const hitRate of [null, 1.2, -0.1, '0.5']) {
            const res = await post(bodyWith({ hit_rate: hitRate }));
            assert.strictEqual(res.status, 400, `hit_rate=${String(hitRate)} 应 400`);
            assert.deepStrictEqual(res.json, {
                code: 400,
                message: 'hit_rate must be null or a number in [0,1]',
            });
        }
        assert.strictEqual(mockCalls.length, 0, '非法 hit_rate 应在落库前拦截');
    });

    it('样本为 0 且 hit_rate=null → 200（空样本合法边界）', async () => {
        const res = await post(
            bodyWith({ sample_size: 0, hit_count: 0, miss_count: 0, hit_rate: null, suggestion: 'insufficient' }),
        );
        assert.strictEqual(res.status, 200);
        assert.strictEqual(mockCalls.length, 1);
    });

    it('suggestion 越界 → 400；detail 非对象 → 400，且不触达 DB', async () => {
        const badSuggestion = await post(bodyWith({ suggestion: 'promote' }));
        assert.strictEqual(badSuggestion.status, 400);
        assert.deepStrictEqual(badSuggestion.json, {
            code: 400,
            message: 'suggestion must be one of downgrade|upgrade|hold|insufficient',
        });

        const badDetail = await post(bodyWith({ detail: 'x' }));
        assert.strictEqual(badDetail.status, 400);
        assert.deepStrictEqual(badDetail.json, { code: 400, message: 'detail must be an object or null' });
        assert.strictEqual(mockCalls.length, 0, '非法 suggestion/detail 应在落库前拦截');
    });

    it('合法载荷 → 200 + {code:200,data}；SQL 为 upsert 且不内联建表', async () => {
        const res = await post(VALID_BODY);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.json, { code: 200, data: { ok: true } });
        assert.strictEqual(mockCalls.length, 1);
        assert.match(mockCalls[0].sql, /INSERT INTO attribution_feedback_signals[\s\S]*ON CONFLICT/);
        assert.deepStrictEqual(mockCalls[0].params.slice(0, 8), [
            DATE,
            'relation:self_driven',
            'observe',
            12,
            4,
            8,
            0.3333,
            'downgrade',
        ]);
        assert.ok(
            !/CREATE TABLE/i.test(mockCalls.map((c) => c.sql).join('\n')),
            '路由不得内联建表（attribution_feedback_signals 由 021 migration 管理）',
        );
    });

    it('同 (date, unit_key) 二次 POST（不同计数）→ upsert 覆盖，行数仍 1（幂等）', async () => {
        const app = buildApp();
        await call(app, { method: 'POST', path: PATH, headers: POST_HEADERS, body: VALID_BODY });
        const second = await call(app, {
            method: 'POST',
            path: PATH,
            headers: POST_HEADERS,
            body: bodyWith({ hit_count: 11, miss_count: 1, hit_rate: 0.9167, suggestion: 'upgrade' }),
        });
        assert.strictEqual(second.status, 200);
        assert.strictEqual(store.size, 1, '同日同 unit_key 重复上报不得新增行');

        const getRes = await call(app, {
            method: 'GET',
            path: `/api/agent/attribution-feedback/${DATE}`,
        });
        const signals = (getRes.json as { signals: Array<Record<string, unknown>> }).signals;
        assert.strictEqual(signals.length, 1);
        assert.strictEqual(signals[0].hitCount, 11);
        assert.strictEqual(signals[0].suggestion, 'upgrade');
    });

    it('同 date 不同 unit_key → 两行（粒度 = (date, unit_key)）', async () => {
        await post(VALID_BODY);
        await post(bodyWith({ unit_key: 'relation:market_follow' }));
        assert.strictEqual(store.size, 2);
    });
});

describe('GET /api/agent/attribution-feedback/:date', () => {
    it('date 非 YYYY-MM-DD → 400，且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'GET',
            path: '/api/agent/attribution-feedback/2026-9-17',
        });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.json, {
            code: 400,
            message: 'invalid date format: 2026-9-17（需要 YYYY-MM-DD）',
        });
        assert.strictEqual(mockCalls.length, 0, '非法 date 应在查询前拦截');
    });

    it('查无该 date → 200 + {date, signals: []}（降级，不报错）', async () => {
        const res = await call(buildApp(), {
            method: 'GET',
            path: `/api/agent/attribution-feedback/${DATE}`,
        });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.json, { date: DATE, signals: [] });
    });

    it('读回 camelCase 且 hit_rate 归一为 number（pg numeric → string 的坑）', async () => {
        const app = buildApp();
        await call(app, { method: 'POST', path: PATH, headers: POST_HEADERS, body: VALID_BODY });
        const res = await call(app, {
            method: 'GET',
            path: `/api/agent/attribution-feedback/${DATE}`,
        });
        assert.strictEqual(res.status, 200);
        const signals = (res.json as { signals: Array<Record<string, unknown>> }).signals;
        assert.strictEqual(signals.length, 1);
        assert.deepStrictEqual(signals[0], {
            date: DATE,
            unitKey: 'relation:self_driven',
            mode: 'observe',
            sampleSize: 12,
            hitCount: 4,
            missCount: 8,
            hitRate: 0.3333,
            suggestion: 'downgrade',
            detail: { window: 60, min_samples: 10, low_threshold: 0.35 },
            createdAt: '2026-09-17T08:10:00.000Z',
        });
        assert.strictEqual(typeof signals[0].hitRate, 'number');
    });
});
