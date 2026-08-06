/**
 * Internal Session Usage API — integration tests (P10 线 4)
 *
 * Tests:
 * 1. GET /internal/usage/sessions 按 session_id 聚合（SUM/COUNT 数值化 + 结构）
 * 2. 无记录 → items 空数组
 * 3. user_id 缺失 → 400
 * 4. 无 X-Internal-Token → 403
 *
 * Mock strategy: monkey-patch pool.query（internal.ts 顶部 import 捕获同一 pool 引用）。
 * Cleanup: after() 恢复 pool.query + redis.disconnect() 防进程挂起
 * （CacheService.ts 经 internal.ts → services 传递引用，模块加载时 ping redis 并建 setInterval）。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../db';
import redis from '../../redis';
import internalRouter from '../internal';

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

function call(
    app: Express,
    opts: { method: string; path: string; headers?: http.OutgoingHttpHeaders; body?: unknown },
): Promise<CallResult> {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            const req = http.request(
                { method: opts.method, hostname: '127.0.0.1', port: addr.port, path: opts.path, headers: opts.headers },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => {
                        server.close();
                        const text = Buffer.concat(chunks).toString('utf8');
                        let json: unknown = null;
                        try { json = JSON.parse(text); } catch { /* not JSON */ }
                        resolve({ status: res.statusCode ?? 0, text, json });
                    });
                    res.on('error', (err) => { server.close(); reject(err); });
                },
            );
            req.on('error', (err) => { server.close(); reject(err); });
            if (opts.body !== undefined) {
                req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
            }
            req.end();
        });
        server.on('error', reject);
    });
}

describe('Internal Session Usage API', () => {
    before(() => {
        mockCalls = [];
        mockResponder = null;
    });

    after(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (pool as any).query = originalQuery;
        /* eslint-enable @typescript-eslint/no-explicit-any */
        redis.disconnect();
    });

    it('GET /internal/usage/sessions 按 session_id 聚合（string 数值化 + 结构）', async () => {
        mockCalls = [];
        // pg 驱动：SUM(...)::bigint 返回 string，COUNT(*)::int 返回 number —— 统一 Number() 数值化
        mockResponder = () => ({
            rows: [
                {
                    session_id: 'app_1',
                    turn_count: '5',
                    total_tokens: '1500',
                    prompt_tokens: '900',
                    completion_tokens: '600',
                    last_used_at: '2026-08-05T02:00:00.000Z',
                },
            ],
        });

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/internal/usage/sessions?user_id=u_42',
            headers: { 'x-internal-token': INTERNAL_TOKEN },
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as {
            code: number;
            data: {
                user_id: string;
                items: Array<{
                    session_id: string;
                    turn_count: number;
                    total_tokens: number;
                    prompt_tokens: number;
                    completion_tokens: number;
                    last_used_at: string;
                }>;
            };
        };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.user_id, 'u_42');
        assert.strictEqual(body.data.items.length, 1);
        assert.deepStrictEqual(body.data.items[0], {
            session_id: 'app_1',
            turn_count: 5,
            total_tokens: 1500,
            prompt_tokens: 900,
            completion_tokens: 600,
            last_used_at: '2026-08-05T02:00:00.000Z',
        });

        const selectCall = mockCalls.find((c) => c.sql.includes('FROM chat_token_usage'));
        assert.ok(selectCall, 'expected 1 SELECT FROM chat_token_usage');
        assert.ok(selectCall.sql.includes('session_id IS NOT NULL'), '应过滤 NULL session_id');
        assert.ok(selectCall.sql.includes('GROUP BY session_id'));
        assert.ok(selectCall.sql.includes('ORDER BY last_used_at DESC'));
        assert.deepStrictEqual(selectCall.params, ['u_42']);
    });

    it('GET /internal/usage/sessions 无记录 → items 空数组', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/internal/usage/sessions?user_id=u_99',
            headers: { 'x-internal-token': INTERNAL_TOKEN },
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: { user_id: string; items: unknown[] } };
        assert.strictEqual(body.code, 200);
        assert.deepStrictEqual(body.data.items, []);
    });

    it('GET /internal/usage/sessions 缺 user_id → 400', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/internal/usage/sessions',
            headers: { 'x-internal-token': INTERNAL_TOKEN },
        });

        assert.strictEqual(res.status, 400);
        const body = res.json as { code: number };
        assert.strictEqual(body.code, 400);
        assert.strictEqual(mockCalls.length, 0, '参数校验失败不应触达 SQL');
    });

    it('GET /internal/usage/sessions 无 X-Internal-Token → 403', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/internal/usage/sessions?user_id=u_42',
        });

        assert.strictEqual(res.status, 403);
        const body = res.json as { code: number };
        assert.strictEqual(body.code, 403);
        assert.strictEqual(mockCalls.length, 0, '鉴权失败不应触达 SQL');
    });
});
