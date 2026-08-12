/**
 * GET/PUT /api/user/profile 测试（Phase 4-3 全局用户记忆 Task 1）
 *
 * Mock strategy: 同 internal_token_usage.spec.ts——monkey-patch pool.query
 * （记录 SQL 调用并返回 mock rows）；合法 token 用 signJwt 真实签发；
 * after() 恢复 pool.query + redis.disconnect() 防进程挂起。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../../core/db';
import redis from '../../../core/redis';
import { signJwt } from '../../../shared/utils/jwt';
import { ProfileController } from '../profileController';

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

function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.get('/api/user/profile', (req, res, next) => ProfileController.get(req, res, next));
    app.put('/api/user/profile', (req, res, next) => ProfileController.put(req, res, next));
    return app;
}

function authHeader(openid: string): http.OutgoingHttpHeaders {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ openid, nickname: 't', iat: now, exp: now + 3600 }, process.env.JWT_SECRET!);
    return { authorization: `Bearer ${token}` };
}

interface CallResult { status: number; json: unknown; }

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
                        try { json = JSON.parse(text); } catch { /* 非 JSON */ }
                        resolve({ status: res.statusCode ?? 0, json });
                    });
                    res.on('error', reject);
                },
            );
            req.on('error', reject);
            if (opts.body !== undefined) {
                req.write(JSON.stringify(opts.body));
            }
            req.end();
        });
        server.on('error', reject);
    });
}

before(() => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; });

after(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (pool as any).query = originalQuery;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    redis.disconnect();
});

describe('GET /api/user/profile', () => {
    it('无 profile 记录 → 200 + 空对象 {}（不 404）', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });
        const app = buildApp();
        const res = await call(app, { method: 'GET', path: '/api/user/profile', headers: authHeader('o_none') });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: unknown };
        assert.strictEqual(body.code, 200);
        assert.deepStrictEqual(body.data, {});
    });

    it('有 profile → 200 + 完整 profile（JSONB 数组已解析）', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [{
                user_id: 'o_1',
                nickname: '小王',
                investment_preferences: ['新能源', '白酒'],
                risk_tolerance: 'conservative',
                updated_at: new Date('2026-08-12T00:00:00Z'),
            }],
        });
        const app = buildApp();
        const res = await call(app, { method: 'GET', path: '/api/user/profile', headers: authHeader('o_1') });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: Record<string, unknown> };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.nickname, '小王');
        assert.deepStrictEqual(body.data.investment_preferences, ['新能源', '白酒']);
        assert.strictEqual(body.data.risk_tolerance, 'conservative');
        const selectCalls = mockCalls.filter((c) => c.sql.includes('FROM user_profiles'));
        assert.strictEqual(selectCalls.length, 1);
        assert.deepStrictEqual(selectCalls[0].params, ['o_1']);
    });

    it('无 token → 401', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, { method: 'GET', path: '/api/user/profile', headers: {} });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(mockCalls.length, 0, '鉴权失败不应触达 SQL');
    });
});

describe('PUT /api/user/profile', () => {
    it('部分更新：仅传 nickname → SQL 仅更新 nickname，其余字段 COALESCE 保留旧值', async () => {
        mockCalls = [];
        mockResponder = (sql: string) => {
            if (sql.includes('RETURNING')) {
                return { rows: [{ user_id: 'o_1', nickname: '老张', investment_preferences: null, risk_tolerance: null }] };
            }
            return { rows: [] };
        };
        const app = buildApp();
        const res = await call(app, {
            method: 'PUT',
            path: '/api/user/profile',
            headers: { ...authHeader('o_1'), 'content-type': 'application/json' },
            body: { nickname: '老张' },
        });

        assert.strictEqual(res.status, 200);
        const insert = mockCalls.find((c) => c.sql.includes('INSERT INTO user_profiles'));
        assert.ok(insert, 'expected INSERT/upsert');
        assert.ok(insert!.sql.includes('ON CONFLICT (user_id)'), '应为 upsert 而非裸 INSERT');
        // 参数顺序：user_id, nickname, investment_preferences, risk_tolerance
        assert.deepStrictEqual(insert!.params, ['o_1', '老张', null, null]);
    });

    it('investment_preferences 整体替换（G7）：传入 1 项覆盖既有 3 项，非追加/拼接', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });
        const app = buildApp();
        const res = await call(app, {
            method: 'PUT',
            path: '/api/user/profile',
            headers: { ...authHeader('o_1'), 'content-type': 'application/json' },
            body: { investment_preferences: ['低波动'] },
        });

        assert.strictEqual(res.status, 200);
        const insert = mockCalls.find((c) => c.sql.includes('INSERT INTO user_profiles'));
        assert.ok(insert, 'expected INSERT/upsert');
        // 整体替换：参数就是传入的 1 项数组（无 COALESCE/|| 拼接痕迹）
        assert.deepStrictEqual(insert!.params, ['o_1', null, ['低波动'], null]);
    });

    it('全部字段更新 → 参数完整', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });
        const app = buildApp();
        const res = await call(app, {
            method: 'PUT',
            path: '/api/user/profile',
            headers: { ...authHeader('o_1'), 'content-type': 'application/json' },
            body: { nickname: '小王', investment_preferences: ['白酒', '新能源'], risk_tolerance: 'aggressive' },
        });

        assert.strictEqual(res.status, 200);
        const insert = mockCalls.find((c) => c.sql.includes('INSERT INTO user_profiles'));
        assert.ok(insert, 'expected INSERT/upsert');
        assert.deepStrictEqual(insert!.params, ['o_1', '小王', ['白酒', '新能源'], 'aggressive']);
    });

    it('校验：investment_preferences 超过 10 项 → 400', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, {
            method: 'PUT',
            path: '/api/user/profile',
            headers: { ...authHeader('o_1'), 'content-type': 'application/json' },
            body: { investment_preferences: Array.from({ length: 11 }, (_, i) => `偏好${i}`) },
        });

        assert.strictEqual(res.status, 400);
        assert.strictEqual(mockCalls.length, 0, '校验失败不应触达 SQL');
    });

    it('校验：preference 单项超过 20 字 → 400', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, {
            method: 'PUT',
            path: '/api/user/profile',
            headers: { ...authHeader('o_1'), 'content-type': 'application/json' },
            body: { investment_preferences: ['这是一个长度超过二十个字符的投资偏好描述文本示例'] },
        });

        assert.strictEqual(res.status, 400);
    });

    it('校验：risk_tolerance 非法值 → 400', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, {
            method: 'PUT',
            path: '/api/user/profile',
            headers: { ...authHeader('o_1'), 'content-type': 'application/json' },
            body: { risk_tolerance: 'super_aggressive' },
        });

        assert.strictEqual(res.status, 400);
    });

    it('校验：nickname 非字符串 / 空串 → 400', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, {
            method: 'PUT',
            path: '/api/user/profile',
            headers: { ...authHeader('o_1'), 'content-type': 'application/json' },
            body: { nickname: '' },
        });

        assert.strictEqual(res.status, 400);
    });

    it('无 token → 401 不触达 SQL', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, {
            method: 'PUT',
            path: '/api/user/profile',
            headers: { 'content-type': 'application/json' },
            body: { nickname: '老张' },
        });

        assert.strictEqual(res.status, 401);
        assert.strictEqual(mockCalls.length, 0);
    });
});
