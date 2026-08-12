/**
 * GET /internal/user-profile/:user_id 测试（Phase 4-3 Task 2）
 *
 * agent-py 对话入口按 user_id 拉取 profile 用；空 profile 返回 200 + {}（不 404）。
 * Mock strategy: 同 internal_token_usage.spec.ts（monkey-patch pool.query；after 恢复 + redis.disconnect）。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../db';
import redis from '../../redis';
import internalRouter from '../internal';

interface MockCall { sql: string; params: unknown[]; }

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

const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.use('/internal', internalRouter);
    return app;
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

before(() => { mockCalls = []; mockResponder = null; });

after(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (pool as any).query = originalQuery;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    redis.disconnect();
});

describe('GET /internal/user-profile/:user_id', () => {
    it('空 profile → 200 + 空对象 {}（不 404）', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });
        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/internal/user-profile/o_none',
            headers: { 'x-internal-token': INTERNAL_TOKEN },
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: unknown };
        assert.strictEqual(body.code, 200);
        assert.deepStrictEqual(body.data, {});
        assert.strictEqual(mockCalls.length, 1, '应恰有一次 SELECT');
        assert.ok(mockCalls[0].sql.includes('FROM user_profiles'));
        assert.deepStrictEqual(mockCalls[0].params, ['o_none']);
    });

    it('有记录 → 200 + 完整 profile', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [{
                user_id: 'o_1',
                nickname: '小王',
                investment_preferences: ['白酒'],
                risk_tolerance: 'conservative',
                updated_at: new Date('2026-08-12T00:00:00Z'),
            }],
        });
        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/internal/user-profile/o_1',
            headers: { 'x-internal-token': INTERNAL_TOKEN },
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: Record<string, unknown> };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.user_id, 'o_1');
        assert.strictEqual(body.data.nickname, '小王');
        assert.deepStrictEqual(body.data.investment_preferences, ['白酒']);
        assert.strictEqual(body.data.risk_tolerance, 'conservative');
    });

    it('缺 X-Internal-Token → 403 且不触达 SQL', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, { method: 'GET', path: '/internal/user-profile/o_1', headers: {} });

        assert.strictEqual(res.status, 403);
        assert.strictEqual(mockCalls.length, 0);
    });

    it('URL 无 userId 段 → 不触达 SQL（Express 参数化路由不匹配，返回 404）', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/internal/user-profile/',
            headers: { 'x-internal-token': INTERNAL_TOKEN },
        });

        // Express 5 参数化路由 :userId 要求非空段，尾斜杠/空参数不匹配 → 404（框架默认行为，
        // 非业务错误）；关键约束是不得触达 SQL（mock 无记录时若被匹配会执行 SELECT）。
        assert.strictEqual(res.status, 404);
        assert.strictEqual(mockCalls.length, 0);
    });
});
