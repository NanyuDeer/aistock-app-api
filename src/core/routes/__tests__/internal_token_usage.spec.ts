/**
 * Chat token usage internal API — integration tests (P10 线 2)
 *
 * Tests (Task 4):
 * 1. POST /internal/usage/records 成功 INSERT RETURNING id
 * 2. 403 无 X-Internal-Token
 * 3. 400 user_id 缺失
 * 4. 400 total_tokens 为负数
 *
 * (Task 5 追加: GET /internal/usage/summary 用例)
 *
 * Mock strategy / cleanup: 同 internal_chat_analysis.spec.ts（monkey-patch
 * pool.query；after() 恢复 + redis.disconnect() 防进程挂起）。
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
    json: unknown;
}

function call(
    app: Express,
    opts: {
        method: string;
        path: string;
        headers?: http.OutgoingHttpHeaders;
        body?: unknown;
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
                req.write(JSON.stringify(opts.body));
            }
            req.end();
        });
        server.on('error', reject);
    });
}

function usageBody(extra?: Record<string, unknown>) {
    return {
        user_id: 'u_42',
        session_id: 'ws_1',
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        question: '茅台今天怎么样',
        ...extra,
    };
}

describe('Internal Token Usage API', () => {
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

    it('POST /internal/usage/records inserts and returns id', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [{ id: 42 }] });

        const app = buildApp();
        const res = await call(app, {
            method: 'POST',
            path: '/internal/usage/records',
            headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: usageBody(),
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: { id: number } };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.id, 42);

        const insertCalls = mockCalls.filter((c) => c.sql.includes('INSERT INTO chat_token_usage'));
        assert.strictEqual(insertCalls.length, 1, 'expected 1 INSERT call');
        assert.deepStrictEqual(insertCalls[0].params, [
            'u_42', 'ws_1', 10, 20, 30, '茅台今天怎么样',
        ]);
    });

    it('rejects missing internal token with 403', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, {
            method: 'POST',
            path: '/internal/usage/records',
            headers: { 'content-type': 'application/json' },
            body: usageBody(),
        });

        assert.strictEqual(res.status, 403);
        const body = res.json as { code: number };
        assert.strictEqual(body.code, 403);
        assert.strictEqual(mockCalls.length, 0, '鉴权失败不应触达 SQL');
    });

    it('rejects empty user_id with 400', async () => {
        const app = buildApp();
        const res = await call(app, {
            method: 'POST',
            path: '/internal/usage/records',
            headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: usageBody({ user_id: '' }),
        });

        assert.strictEqual(res.status, 400);
        const body = res.json as { code: number };
        assert.strictEqual(body.code, 400);
    });

    it('rejects negative total_tokens with 400', async () => {
        const app = buildApp();
        const res = await call(app, {
            method: 'POST',
            path: '/internal/usage/records',
            headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: usageBody({ total_tokens: -1 }),
        });

        assert.strictEqual(res.status, 400);
        const body = res.json as { code: number };
        assert.strictEqual(body.code, 400);
    });
});
