/**
 * Chat Analysis Report API — integration tests
 *
 * Tests:
 * 1. Whitelist: chat_analysis accepted on POST /internal/analysis-reports (upsert with user_id isolation)
 * 2. GET /internal/analysis-reports/:type/:date/:userId queries by (type, date, userId) triple
 *
 * Mock strategy: monkey-patch pool.query on the same object reference that
 * internal.ts captured at import time. No DB connection is made.
 *
 * Cleanup: disconnect Redis in after() to prevent process hang.
 * Root cause: CacheService.ts (transitively imported via internal.ts → services)
 * calls redis.ping() at module load and creates setInterval without unref().
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../db';
import redis from '../../redis';
import internalRouter, { publicRouter } from '../internal';

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

const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

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
            if (opts.body !== undefined) {
                req.write(
                    typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
                );
            }
            req.end();
        });
        server.on('error', reject);
    });
}

function chatAnalysisBody(extra?: Record<string, unknown>) {
    return {
        report_type: 'chat_analysis',
        report_date: '2026-08-02',
        user_id: 'u_42',
        content: {
            display_report: { summary: 's', details: 'd', stocks: [], risks: [] },
            schema_version: '2.0',
        },
        status: 'completed',
        ...extra,
    };
}

// ── Tests ──

describe('Chat Analysis Report API', () => {
    before(() => {
        mockCalls = [];
        mockResponder = null;
    });

    after(() => {
        // Restore pool.query
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (pool as any).query = originalQuery;
        /* eslint-enable @typescript-eslint/no-explicit-any */

        // Disconnect Redis — CacheService.ts calls redis.ping() at module load,
        // which creates a connection that keeps the process alive.
        redis.disconnect();
    });

    // ── 1. Whitelist: chat_analysis accepted on POST ──

    it('accepts chat_analysis and upserts with user_id isolation', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [
                { id: 1, report_type: 'chat_analysis', report_date: '2026-08-02', created_at: '2026-08-02T10:00:00Z' },
            ],
        });

        const app = buildApp();
        const res = await call(app, {
            method: 'POST',
            path: '/internal/analysis-reports',
            headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: chatAnalysisBody(),
        });

        assert.strictEqual(res.status, 201);
        const body = res.json as { code: number; data: { report_type: string } };
        assert.strictEqual(body.code, 201);
        assert.strictEqual(body.data.report_type, 'chat_analysis');

        // SQL params: [report_type, report_date, user_id, content_json, ...]
        const insertCalls = mockCalls.filter((c) => c.sql.includes('INSERT'));
        assert.strictEqual(insertCalls.length, 1, 'expected 1 INSERT call');
        assert.strictEqual(insertCalls[0].params[2], 'u_42', 'user_id isolation key should be u_42');
    });

    // ── 2. GET by (type, date, userId) triple ──

    it('queries chat_analysis by (type, date, userId) triple', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [
                {
                    id: 1,
                    report_type: 'chat_analysis',
                    report_date: '2026-08-02',
                    content: { display_report: { summary: 's' }, schema_version: '2.0' },
                    data_source: null,
                    status: 'completed',
                    created_at: '2026-08-02T10:00:00Z',
                },
            ],
        });

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/internal/analysis-reports/chat_analysis/2026-08-02/u_42',
            headers: { 'x-internal-token': INTERNAL_TOKEN },
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: { report_type: string } };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.report_type, 'chat_analysis');

        // SQL 按 (type, date, userId) 三元组查询（端点 SELECT 不投影 user_id 列，故校验查询参数）
        const selectCalls = mockCalls.filter((c) => c.sql.includes('SELECT'));
        assert.strictEqual(selectCalls.length, 1, 'expected 1 SELECT call');
        assert.deepStrictEqual(selectCalls[0].params, ['chat_analysis', '2026-08-02', 'u_42']);
    });
});
