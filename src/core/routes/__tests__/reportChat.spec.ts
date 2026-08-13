/**
 * Chat Analysis Report Detail API — integration tests
 *
 * GET /api/agent/report/chat/:reportId
 *
 * Tests:
 * 1. 无 token → 401（不触达 DB）
 * 2. 非法 token → 401（不触达 DB）
 * 3. 本人 report_id → 200 { code:0, data: {...} }（SQL 按 id + chat_analysis + user_id 过滤，user_id 取 token openid）
 * 4. 他人 report_id → 200 { code:0, data: null }
 * 5. 不存在 → 200 { code:0, data: null }
 * 6. 过期（7 天 TTL）→ data: null（SQL 含 expires_at 过滤断言）
 * 7. /report/chat/:id 不被通用 /report/:intent/:date 端点抢占（先于通用端点注册）
 *
 * Mock strategy: monkey-patch pool.query on the same object reference that
 * internal.ts captured at import time. No DB connection is made.
 *
 * Cleanup: restore pool.query + process.env.JWT_SECRET + disconnect Redis in after()
 * （Redis 连接来自 CacheService.ts 模块加载时 redis.ping()，防进程挂起）。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../db';
import redis from '../../redis';
import internalRouter, { publicRouter } from '../internal';
import { signJwt } from '../../../shared/utils/jwt';

const JWT_SECRET = 'test-jwt-secret';

// ── Mock pool.query ──

interface MockCall {
    sql: string;
    params: unknown[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const originalQuery = pool.query.bind(pool) as any;
let mockCalls: MockCall[] = [];
let mockResponder: ((sql: string, params: unknown[]) => { rows: unknown[] }) | null = null;

// Replace pool.query — works because internal.ts holds the same pool object reference
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

function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.use('/api/agent', publicRouter);
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
    opts: {
        method: string;
        path: string;
        headers?: http.OutgoingHttpHeaders;
    },
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

function signTestToken(openid: string): string {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({ openid, iat: now, exp: now + 3600 }, JWT_SECRET);
}

function authHeader(token: string): http.OutgoingHttpHeaders {
    return { authorization: `Bearer ${token}` };
}

function chatAnalysisRow(id: number | string, openid: string) {
    return {
        id,
        report_type: 'chat_analysis',
        report_date: '2026-08-02',
        content: {
            display_report: { summary: 's', details: 'd', stocks: [], risks: [] },
            schema_version: '2.0',
        },
        data_source: null,
        status: 'completed',
        created_at: '2026-08-02T10:00:00Z',
    };
}

// ── Tests ──

describe('Chat Analysis Report Detail API', () => {
    before(() => {
        process.env.JWT_SECRET = JWT_SECRET;
        mockCalls = [];
        mockResponder = null;
    });

    after(() => {
        delete process.env.JWT_SECRET;
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (pool as any).query = originalQuery;
        /* eslint-enable @typescript-eslint/no-explicit-any */
        redis.disconnect();
    });

    // ── 1. 无 token → 401 ──

    it('returns 401 when no token provided', async () => {
        mockCalls = [];
        mockResponder = null;

        const app = buildApp();
        const res = await call(app, { method: 'GET', path: '/api/agent/report/chat/5' });

        assert.strictEqual(res.status, 401);
        // 鉴权先于 DB 查询：不触达 pool.query
        assert.strictEqual(mockCalls.length, 0, 'auth must fail before DB query');
    });

    // ── 2. 非法 token → 401 ──

    it('returns 401 when token is invalid', async () => {
        mockCalls = [];
        mockResponder = null;

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/report/chat/5',
            headers: authHeader('not-a-real-jwt-token'),
        });

        assert.strictEqual(res.status, 401);
        assert.strictEqual(mockCalls.length, 0, 'auth must fail before DB query');
    });

    // ── 3. 本人 report_id → data ──

    it('returns own chat_analysis report by report_id', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [chatAnalysisRow(42, 'o_owner')] });

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/report/chat/42',
            headers: authHeader(signTestToken('o_owner')),
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: { id: number; report_type: string } };
        assert.strictEqual(body.code, 0);
        assert.strictEqual(body.data.id, 42, 'BIGSERIAL id 应归一为 Number');
        assert.strictEqual(body.data.report_type, 'chat_analysis');

        // SQL 过滤断言：(id, report_type=chat_analysis, user_id 来自 token openid, expires_at)
        const selectCalls = mockCalls.filter((c) => c.sql.includes('FROM agent_analysis_reports'));
        assert.strictEqual(selectCalls.length, 1, 'expected 1 SELECT call');
        assert.ok(selectCalls[0].sql.includes("report_type = 'chat_analysis'"), 'must filter report_type');
        assert.deepStrictEqual(selectCalls[0].params, ['42', 'o_owner'], 'user_id 必须来自 token openid');
    });

    // ── 4. 他人 report_id → data: null ──

    it('returns data:null when report belongs to another user', async () => {
        mockCalls = [];
        // 他人报告：SQL 的 user_id 过滤后无行（mock 空结果模拟"查不到"，不泄露存在性）
        mockResponder = () => ({ rows: [] });

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/report/chat/7',
            headers: authHeader(signTestToken('o_other')),
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: unknown };
        assert.strictEqual(body.code, 0);
        assert.strictEqual(body.data, null);
    });

    // ── 5. 不存在 → data: null ──

    it('returns data:null when report does not exist', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/report/chat/99999',
            headers: authHeader(signTestToken('o_owner')),
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: unknown };
        assert.strictEqual(body.code, 0);
        assert.strictEqual(body.data, null);
    });

    // ── 6. 过期 → data: null（SQL 过滤断言）──

    it('filters expired reports via expires_at in SQL (7-day TTL)', async () => {
        mockCalls = [];
        // 过期行：SQL 过滤后无行 → data:null
        mockResponder = () => ({ rows: [] });

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/report/chat/8',
            headers: authHeader(signTestToken('o_owner')),
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: unknown };
        assert.strictEqual(body.code, 0);
        assert.strictEqual(body.data, null);

        // SQL 必须含 expires_at 过滤（对齐 7 天 TTL 清理语义）
        const selectCalls = mockCalls.filter((c) => c.sql.includes('FROM agent_analysis_reports'));
        assert.strictEqual(selectCalls.length, 1, 'expected 1 SELECT call');
        assert.ok(
            selectCalls[0].sql.includes('expires_at IS NULL OR expires_at > NOW()'),
            'SQL must filter expired reports',
        );
    });

    // ── 7. /report/chat/:id 不被通用端点抢占 ──

    it('is not captured by generic /report/:intent/:date endpoint', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/report/chat/5',
            headers: authHeader(signTestToken('o_owner')),
        });

        // 通用端点会把 intent='chat'、date='5' 判为非法 → 400；
        // 命中本端点则应 200 且 SQL 是 chat_analysis 查询
        assert.strictEqual(res.status, 200, 'must hit /report/chat/:reportId, not generic route');
        const body = res.json as { code: number; data: unknown };
        assert.strictEqual(body.code, 0);
        const selectCalls = mockCalls.filter((c) => c.sql.includes('FROM agent_analysis_reports'));
        assert.ok(selectCalls.length >= 1 && selectCalls[0].sql.includes("report_type = 'chat_analysis'"),
            'SQL must be the chat_analysis detail query');
    });
});
