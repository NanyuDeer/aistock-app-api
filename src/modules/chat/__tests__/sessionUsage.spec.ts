/**
 * Session Usage API（公开，P10 线 4）— integration tests
 *
 * Tests:
 * 1. 401 无 token（list + detail）
 * 2. GET /api/chat/usage/sessions 聚合 + LEFT JOIN chat_sessions 标题（JOIN 不到为空串）
 * 3. GET /api/chat/usage/sessions 无记录 → items 空数组
 * 4. GET /api/chat/usage/sessions/:id 归属过滤 + 最近 20 条
 * 5. GET /api/chat/usage/sessions/:id 无记录 → items 空数组
 *
 * Mock 策略：monkey-patch pool.query（SessionUsageController 持有同一 pool 对象引用）。
 * 注意：requireAuth 走 tokenBlacklist → CacheService（加载 core/redis），after() 需 redis.disconnect() 防挂起。
 * 与 index.ts 注册完全一致：静态路由先于参数化。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../../core/db';
import redis from '../../../core/redis';
import { SessionUsageController } from '../sessionUsageController';
import { signJwt } from '../../../shared/utils/jwt';

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

const JWT_SECRET = process.env.JWT_SECRET || 'session-usage-test-secret';

function makeToken(openid = 'openid_42'): string {
    return signJwt(
        { openid, nickname: '测试用户', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
        JWT_SECRET,
    );
}

function buildApp(): Express {
    const app = express();
    app.use(express.json());
    // 与 index.ts 注册完全一致：静态先于参数化
    app.get('/api/chat/usage/sessions', (req, res, next) => SessionUsageController.listBySessions(req, res, next));
    app.get('/api/chat/usage/sessions/:id', (req, res, next) => SessionUsageController.detailBySession(req, res, next));
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

const authHeader = (openid?: string) => ({ authorization: `Bearer ${makeToken(openid)}` });

describe('SessionUsageController', () => {
    before(() => {
        process.env.JWT_SECRET = JWT_SECRET;
        mockCalls = [];
        mockResponder = null;
    });

    after(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (pool as any).query = originalQuery;
        /* eslint-enable @typescript-eslint/no-explicit-any */
        redis.disconnect();
    });

    it('401：无 token 时 list 与 detail 均返回 401', async () => {
        const app = buildApp();
        const list = await call(app, { method: 'GET', path: '/api/chat/usage/sessions' });
        assert.strictEqual(list.status, 401);
        const listBody = list.json as { code: number };
        assert.strictEqual(listBody.code, 401);

        const detail = await call(app, { method: 'GET', path: '/api/chat/usage/sessions/app_1' });
        assert.strictEqual(detail.status, 401);
        const detailBody = detail.json as { code: number };
        assert.strictEqual(detailBody.code, 401);
        assert.strictEqual(mockCalls.length, 0, '鉴权失败不应触达 SQL');
    });

    it('list：聚合 + LEFT JOIN chat_sessions 标题（JOIN 不到为空串），按 openid 归属', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [
                {
                    session_id: 'app_1',
                    turn_count: '5',
                    total_tokens: '1500',
                    last_used_at: '2026-08-05T02:00:00.000Z',
                    title: '今天大盘怎么样',
                },
                {
                    session_id: 'app_2',
                    turn_count: '2',
                    total_tokens: '400',
                    last_used_at: '2026-08-04T02:00:00.000Z',
                    title: '', // JOIN 不到 chat_sessions → 空串
                },
            ],
        });

        const app = buildApp();
        const res = await call(app, { method: 'GET', path: '/api/chat/usage/sessions', headers: authHeader() });

        assert.strictEqual(res.status, 200);
        const body = res.json as {
            code: number;
            message: string;
            data: { items: Array<{ session_id: string; title: string; total_tokens: number; turn_count: number; last_used_at: string }> };
        };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.message, 'success');
        assert.strictEqual(body.data.items.length, 2);
        assert.deepStrictEqual(body.data.items[0], {
            session_id: 'app_1',
            title: '今天大盘怎么样',
            total_tokens: 1500,
            turn_count: 5,
            last_used_at: '2026-08-05T02:00:00.000Z',
        });
        assert.strictEqual(body.data.items[1].title, '', 'JOIN 不到标题应为空串');

        const selectCall = mockCalls.find((c) => c.sql.includes('LEFT JOIN chat_sessions'));
        assert.ok(selectCall, 'expected SELECT ... LEFT JOIN chat_sessions');
        assert.ok(selectCall.sql.includes('FROM chat_token_usage'), '聚合基表为 chat_token_usage');
        assert.ok(selectCall.sql.includes('GROUP BY session_id'));
        assert.ok(selectCall.sql.includes('ORDER BY last_used_at DESC'));
        assert.deepStrictEqual(selectCall.params, ['openid_42'], '归属参数应为 JWT openid');
    });

    it('list：无记录 → items 空数组', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });

        const app = buildApp();
        const res = await call(app, { method: 'GET', path: '/api/chat/usage/sessions', headers: authHeader() });

        const body = res.json as { code: number; data: { items: unknown[] } };
        assert.strictEqual(body.code, 200);
        assert.deepStrictEqual(body.data.items, []);
    });

    it('detail：归属过滤 WHERE user_id AND session_id，最近 20 条 DESC', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [
                {
                    prompt_tokens: '10',
                    completion_tokens: '20',
                    total_tokens: '30',
                    question: '茅台今天怎么样',
                    created_at: '2026-08-05T02:00:00.000Z',
                },
            ],
        });

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/chat/usage/sessions/app_1',
            headers: authHeader(),
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as {
            code: number;
            message: string;
            data: { session_id: string; items: Array<{ prompt_tokens: number; completion_tokens: number; total_tokens: number; question: string; created_at: string }> };
        };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.session_id, 'app_1');
        assert.strictEqual(body.data.items.length, 1);
        assert.deepStrictEqual(body.data.items[0], {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
            question: '茅台今天怎么样',
            created_at: '2026-08-05T02:00:00.000Z',
        });

        const selectCall = mockCalls.find((c) => c.sql.includes('FROM chat_token_usage'));
        assert.ok(selectCall, 'expected SELECT FROM chat_token_usage');
        assert.ok(selectCall.sql.includes('WHERE user_id = $1 AND session_id = $2'), '归属双条件防越权');
        assert.ok(selectCall.sql.includes('ORDER BY created_at DESC'));
        assert.ok(selectCall.sql.includes('LIMIT 20'), '最近 20 条');
        assert.deepStrictEqual(selectCall.params, ['openid_42', 'app_1']);
    });

    it('detail：无记录 → items 空数组', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/chat/usage/sessions/app_99',
            headers: authHeader(),
        });

        const body = res.json as { code: number; data: { session_id: string; items: unknown[] } };
        assert.strictEqual(body.code, 200);
        assert.deepStrictEqual(body.data.items, []);
    });
});
