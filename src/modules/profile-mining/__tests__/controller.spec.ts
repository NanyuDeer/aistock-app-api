/**
 * 推断清理 / 计数接口测试（画像自动挖掘一期 Task 5）
 *
 * GET    /api/user/profile/inferences/meta  → { count, dimensions, updated_at }（不泄漏 value）
 * DELETE /api/user/profile/inferences       → { deleted: n } + DEL 两个缓存 key
 * 无 token → 401 且不触达 SQL/缓存。
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import Redis from 'ioredis';
import pool from '../../../core/db';
import redis from '../../../core/redis';
import { signJwt } from '../../../shared/utils/jwt';
import {
    ProfileMiningController,
} from '../ProfileMiningController';
import { _agentCacheRedisFactory } from '../../user/profileController';

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

function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.get('/api/user/profile/inferences/meta', (req, res, next) => ProfileMiningController.meta(req, res, next));
    app.delete('/api/user/profile/inferences', (req, res, next) => ProfileMiningController.clear(req, res, next));
    return app;
}

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
    opts: { method: string; path: string; headers?: http.OutgoingHttpHeaders },
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
            req.end();
        });
        server.on('error', reject);
    });
}

before(() => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; });

beforeEach(() => {
    mockCalls = [];
    cacheDelCalls = [];
    mockResponder = () => ({ rows: [], rowCount: 0 });
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

describe('GET /api/user/profile/inferences/meta', () => {
    it('无推断 → 200 + count 0 / dimensions [] / updated_at null', async () => {
        mockResponder = (sql) => {
            if (sql.includes('FROM user_profile_inferences')) {
                return { rows: [{ count: 0, dimensions: [], updated_at: null }] };
            }
            return { rows: [] };
        };
        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/user/profile/inferences/meta',
            headers: authHeader('o_none'),
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: { count: number; dimensions: string[]; updated_at: unknown } };
        assert.strictEqual(body.code, 200);
        assert.deepStrictEqual(body.data, { count: 0, dimensions: [], updated_at: null });
        const select = mockCalls.find((c) => c.sql.includes('FROM user_profile_inferences'));
        assert.ok(select);
        assert.deepStrictEqual(select!.params, ['o_none']);
    });

    it('有推断 → 只返回计数与维度名，不返回 value', async () => {
        mockResponder = (sql) => {
            if (sql.includes('FROM user_profile_inferences')) {
                return {
                    rows: [{
                        count: 2,
                        dimensions: ['active_hours', 'preferred_sectors'],
                        updated_at: new Date('2026-11-05T00:30:00Z'),
                    }],
                };
            }
            return { rows: [] };
        };
        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/user/profile/inferences/meta',
            headers: authHeader('o_1'),
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { data: Record<string, unknown> };
        assert.deepStrictEqual(Object.keys(body.data).sort(), ['count', 'dimensions', 'updated_at']);
        assert.strictEqual(body.data.count, 2);
        assert.deepStrictEqual(body.data.dimensions, ['active_hours', 'preferred_sectors']);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(body.data, 'value'), false, 'meta 不得泄漏推断 value');
        // SQL 只聚合计数/维度名/更新时间，不 SELECT value
        const select = mockCalls.find((c) => c.sql.includes('FROM user_profile_inferences'));
        assert.ok(select);
        assert.strictEqual(select!.sql.includes('value'), false);
    });

    it('无 token → 401 且不触达 SQL', async () => {
        const app = buildApp();
        const res = await call(app, { method: 'GET', path: '/api/user/profile/inferences/meta', headers: {} });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(mockCalls.length, 0);
    });
});

describe('DELETE /api/user/profile/inferences', () => {
    it('清除成功 → 200 + deleted:n + DEL 两个缓存 key', async () => {
        mockResponder = (sql) => {
            if (sql.includes('DELETE FROM user_profile_inferences')) {
                return { rows: [], rowCount: 3 };
            }
            return { rows: [], rowCount: 0 };
        };
        const app = buildApp();
        const res = await call(app, {
            method: 'DELETE',
            path: '/api/user/profile/inferences',
            headers: authHeader('o_1'),
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: { deleted: number } };
        assert.strictEqual(body.code, 200);
        assert.deepStrictEqual(body.data, { deleted: 3 });

        const delCalls = mockCalls.filter((c) => c.sql.includes('DELETE FROM user_profile_inferences'));
        assert.strictEqual(delCalls.length, 1);
        assert.deepStrictEqual(delCalls[0].params, ['o_1']);
        assert.deepStrictEqual(cacheDelCalls, ['user_profile:o_1', 'user_profile_inferences:o_1']);
    });

    it('无 token → 401 且不触达 SQL/缓存', async () => {
        const app = buildApp();
        const res = await call(app, { method: 'DELETE', path: '/api/user/profile/inferences', headers: {} });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(mockCalls.length, 0);
        assert.strictEqual(cacheDelCalls.length, 0);
    });
});
