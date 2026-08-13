/**
 * GET/PUT /api/user/profile 测试（Phase 4-3 全局用户记忆 Task 1）
 *
 * Mock strategy: 同 internal_token_usage.spec.ts——monkey-patch pool.query
 * （记录 SQL 调用并返回 mock rows）；合法 token 用 signJwt 真实签发；
 * after() 恢复 pool.query + redis.disconnect() 防进程挂起。
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import Redis from 'ioredis';
import pool from '../../../core/db';
import redis from '../../../core/redis';
import { signJwt } from '../../../shared/utils/jwt';
import { ProfileController, _agentCacheRedisFactory, resolveAgentCacheRedisUrl } from '../profileController';

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
    app.delete('/api/user/profile', (req, res, next) => ProfileController.del(req, res, next));
    return app;
}

// ── agent-py 侧缓存跨库失效 stub（M-4：工厂可注入，DELETE/PUT 用例不产生真实 TCP 连接，
//    断言 DEL 以 user_profile:{userId} 被调用）──
let cacheDelCalls: string[] = [];
const cacheClientMock = {
    connect: async (): Promise<void> => undefined,
    del: async (key: string): Promise<number> => { cacheDelCalls.push(key); return 1; },
    disconnect: (): void => undefined,
};
const originalCacheFactory = _agentCacheRedisFactory.current;

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

beforeEach(() => {
    cacheDelCalls = [];
    /* eslint-disable @typescript-eslint/no-explicit-any */
    _agentCacheRedisFactory.current = () => cacheClientMock as unknown as Redis;
    /* eslint-enable @typescript-eslint/no-explicit-any */
});

after(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (pool as any).query = originalQuery;
    _agentCacheRedisFactory.current = originalCacheFactory;
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
        // 整体替换：参数为传入 1 项的 JSON 文本（JSONB 参数须 JSON 字符串，集成冒烟实证
        // 数组直传会 500 "类型json的输入语法无效"）；无 COALESCE/|| 拼接痕迹
        assert.deepStrictEqual(insert!.params, ['o_1', null, '["低波动"]', null]);
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
        // investment_preferences 序列化为 JSON 文本（JSONB 参数契约）
        assert.deepStrictEqual(insert!.params, ['o_1', '小王', '["白酒","新能源"]', 'aggressive']);
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

    it('成功后失效 agent-py 缓存（DEL 以 user_profile:{userId} 被调用）', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });
        const app = buildApp();
        const res = await call(app, {
            method: 'PUT',
            path: '/api/user/profile',
            headers: { ...authHeader('o_1'), 'content-type': 'application/json' },
            body: { nickname: '老张' },
        });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(cacheDelCalls, ['user_profile:o_1'], 'PUT 成功后应 DEL agent-py 缓存（消除 300s 旧画像窗口）');
    });
});

describe('DELETE /api/user/profile', () => {
    it('删除成功 → 200 + deleted:true + DEL db=1 缓存 key', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });
        const app = buildApp();
        const res = await call(app, { method: 'DELETE', path: '/api/user/profile', headers: authHeader('o_del') });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: { deleted: boolean } };
        assert.strictEqual(body.code, 200);
        assert.deepStrictEqual(body.data, { deleted: true });
        const delCalls = mockCalls.filter((c) => c.sql.includes('DELETE FROM user_profiles'));
        assert.strictEqual(delCalls.length, 1);
        assert.deepStrictEqual(delCalls[0].params, ['o_del']);
        assert.deepStrictEqual(cacheDelCalls, ['user_profile:o_del'], '删除后应 DEL agent-py 缓存 key');
    });

    it('无 token → 401 不触达 SQL、不触碰缓存', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, { method: 'DELETE', path: '/api/user/profile', headers: {} });

        assert.strictEqual(res.status, 401);
        assert.strictEqual(mockCalls.length, 0, '鉴权失败不应触达 SQL');
        assert.strictEqual(cacheDelCalls.length, 0, '鉴权失败不应触碰缓存');
    });
});

// ── resolveAgentCacheRedisUrl（问题 19 修复：缓存失效连接对齐 agent-py 真实 Redis）──
describe('resolveAgentCacheRedisUrl', () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        savedEnv.REDIS_URL = process.env.REDIS_URL;
        savedEnv.AGENT_PROFILE_CACHE_REDIS_URL = process.env.AGENT_PROFILE_CACHE_REDIS_URL;
    });

    afterEach(() => {
        if (savedEnv.REDIS_URL === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = savedEnv.REDIS_URL;
        if (savedEnv.AGENT_PROFILE_CACHE_REDIS_URL === undefined) delete process.env.AGENT_PROFILE_CACHE_REDIS_URL;
        else process.env.AGENT_PROFILE_CACHE_REDIS_URL = savedEnv.AGENT_PROFILE_CACHE_REDIS_URL;
    });

    it('显式 AGENT_PROFILE_CACHE_REDIS_URL 优先（原样返回）', () => {
        process.env.AGENT_PROFILE_CACHE_REDIS_URL = 'redis://custom:9999/3';
        process.env.REDIS_URL = 'redis://:p@h:6379/9';
        assert.strictEqual(resolveAgentCacheRedisUrl(), 'redis://custom:9999/3');
    });

    it('未显式配置时从 REDIS_URL 派生（保留 auth/host/port，db 替换为 agent-py 缓存 db 15）', () => {
        delete process.env.AGENT_PROFILE_CACHE_REDIS_URL;
        process.env.REDIS_URL = 'redis://:8EscLKUF@127.0.0.1:6379/9';
        assert.strictEqual(resolveAgentCacheRedisUrl(), 'redis://:8EscLKUF@127.0.0.1:6379/15');
    });

    it('REDIS_URL 无 db 段时追加 db 15', () => {
        delete process.env.AGENT_PROFILE_CACHE_REDIS_URL;
        process.env.REDIS_URL = 'redis://:p@127.0.0.1:6379';
        assert.strictEqual(resolveAgentCacheRedisUrl(), 'redis://:p@127.0.0.1:6379/15');
    });

    it('无任何配置时兜底 redis://127.0.0.1:6379/15', () => {
        delete process.env.AGENT_PROFILE_CACHE_REDIS_URL;
        delete process.env.REDIS_URL;
        assert.strictEqual(resolveAgentCacheRedisUrl(), 'redis://127.0.0.1:6379/15');
    });
});
