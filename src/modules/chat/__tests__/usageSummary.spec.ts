/**
 * GET /api/chat/usage/summary — public usage summary tests (P10 线 2)
 *
 * Tests:
 * 1. 401 无 token（requireAuth 拒绝）
 * 2. 200 JWT 有效 → 按 openid 聚合（mock pool.query 返回聚合行）
 *
 * Mock strategy: monkey-patch pool.query（usageController 持有同一 pool 引用）；
 * 构造有效 JWT 用 signJwt + process.env.JWT_SECRET（requireAuth 读取）。
 * Cleanup: after() 恢复 pool.query + redis.disconnect() 防挂起。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../../core/db';
import redis from '../../../core/redis';
import { UsageController } from '../usageController';
import { signJwt, verifyJwt } from '../../../shared/utils/jwt';
import { revokeToken } from '../../../shared/utils/tokenBlacklist';

/* eslint-disable @typescript-eslint/no-explicit-any */
const originalQuery = pool.query.bind(pool) as any;
let mockCalls: { sql: string; params: unknown[] }[] = [];

(pool as any).query = function (sql: string, ...rest: unknown[]): Promise<{ rows: unknown[] }> {
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    mockCalls.push({ sql, params });
    return Promise.resolve({
        rows: [
            { prompt_tokens: '10', completion_tokens: '20', total_tokens: '30', turn_count: '2' },
        ],
    });
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.get('/api/chat/usage/summary', (req, res, next) => UsageController.summary(req, res, next));
    return app;
}

interface CallResult {
    status: number;
    json: unknown;
}

function call(app: Express, opts: { path: string; headers?: http.OutgoingHttpHeaders }): Promise<CallResult> {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            const req = http.request(
                {
                    method: 'GET',
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
                            /* not JSON */
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
            req.end();
        });
        server.on('error', reject);
    });
}

describe('UsageController /api/chat/usage/summary', () => {
    before(() => {
        process.env.JWT_SECRET = 'test-secret';
        mockCalls = [];
    });

    after(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (pool as any).query = originalQuery;
        /* eslint-enable @typescript-eslint/no-explicit-any */
        delete process.env.JWT_SECRET;
        redis.disconnect();
    });

    it('rejects missing token with 401', async () => {
        const app = buildApp();
        const res = await call(app, { path: '/api/chat/usage/summary' });

        assert.strictEqual(res.status, 401);
        const body = res.json as { code: number };
        assert.strictEqual(body.code, 401);
        assert.strictEqual(mockCalls.length, 0, '鉴权失败不应触达 SQL');
    });

    it('returns aggregated usage for authenticated openid', async () => {
        const token = signJwt(
            { openid: 'u_42', nickname: 'tester', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
            'test-secret',
        );
        const app = buildApp();
        const res = await call(app, {
            path: '/api/chat/usage/summary',
            headers: { authorization: `Bearer ${token}` },
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as {
            code: number;
            message: string;
            data: { prompt_tokens: number; completion_tokens: number; total_tokens: number; turn_count: number };
        };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.message, 'success');
        assert.deepStrictEqual(body.data, {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
            turn_count: 2,
        });
        assert.strictEqual(mockCalls.length, 1);
        assert.deepStrictEqual(mockCalls[0].params, ['u_42'], '按 openid（JWT 身份）聚合');
    });
});

describe('token-revocation：黑名单凭证拒绝（sessionUsage requireAuth）', () => {
    // 既有 describe 的 after() 会删除 JWT_SECRET 并还原 pool.query（describe 作用域），
    // 本 describe 需自带 before/after 重建 harness（沿用同款 mock，真实 CacheService 双写）。
    before(() => {
        process.env.JWT_SECRET = 'test-secret';
        mockCalls = [];
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (pool as any).query = function (sql: string, ...rest: unknown[]): Promise<{ rows: unknown[] }> {
            const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
            mockCalls.push({ sql, params });
            return Promise.resolve({
                rows: [
                    { prompt_tokens: '10', completion_tokens: '20', total_tokens: '30', turn_count: '2' },
                ],
            });
        };
        /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    after(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (pool as any).query = originalQuery;
        /* eslint-enable @typescript-eslint/no-explicit-any */
        delete process.env.JWT_SECRET;
        redis.disconnect();
    });

    it('已撤销 token 请求 /api/chat/usage/summary → 401', async () => {
        const now = Math.floor(Date.now() / 1000);
        const token = signJwt({ openid: 'o_revoked', nickname: 't', iat: now, exp: now + 3600 }, process.env.JWT_SECRET!);
        // 真实撤销：写入黑名单（真实 CacheService 双写——本进程内 Redis 或本地 Map 均可命中）
        const payload = verifyJwt(token, process.env.JWT_SECRET!)!;
        await revokeToken(payload);
        const app = buildApp();
        const r = await call(app, { path: '/api/chat/usage/summary', headers: { authorization: `Bearer ${token}` } });
        assert.strictEqual(r.status, 401);
    });

    it('未撤销 token → 200（fail-open 不影响合法用户）', async () => {
        const now = Math.floor(Date.now() / 1000);
        const token = signJwt({ openid: 'o_ok', nickname: 't', iat: now, exp: now + 3600 }, process.env.JWT_SECRET!);
        const app = buildApp();
        const r = await call(app, { path: '/api/chat/usage/summary', headers: { authorization: `Bearer ${token}` } });
        assert.strictEqual(r.status, 200);
    });
});
