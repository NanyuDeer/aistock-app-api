/**
 * GET /internal/user-profile-inferences/:userId 测试（画像自动挖掘一期 Task 4）
 *
 * agent-py 对话入口按 user_id 拉取推断画像；空数据返回 200 + []（不 404）。
 * Mock strategy: 同 internal_user_profile.spec.ts（monkey-patch pool.query；
 * after 恢复 + redis.disconnect）。
 */
import { describe, it, after } from 'node:test';
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

after(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (pool as any).query = originalQuery;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    redis.disconnect();
});

describe('GET /internal/user-profile-inferences/:userId', () => {
    it('空数据 → 200 + data: []（不 404）', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });
        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/internal/user-profile-inferences/o_none',
            headers: { 'x-internal-token': INTERNAL_TOKEN },
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: unknown };
        assert.strictEqual(body.code, 200);
        assert.deepStrictEqual(body.data, []);
        assert.strictEqual(mockCalls.length, 1, '应恰有一次 SELECT');
        assert.ok(mockCalls[0].sql.includes('FROM user_profile_inferences'));
        assert.deepStrictEqual(mockCalls[0].params, ['o_none']);
    });

    it('有数据 → 返回契约字段（confidence/sample_size 为 number，不泄漏 user_id）', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [{
                dimension: 'preferred_sectors',
                value: { items: [{ name: '白酒', stock_count: 3, weight: 0.19 }], total: 16 },
                confidence: '0.70',
                sample_size: 16,
                window_days: null,
                inferred_at: new Date('2026-11-05T00:30:00Z'),
            }, {
                dimension: 'question_topics',
                value: { items: [{ topic: '财报业绩', hits: 12 }], total: 40 },
                confidence: '0.65',
                sample_size: 40,
                window_days: 30,
                inferred_at: new Date('2026-11-05T00:30:00Z'),
            }],
        });
        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/internal/user-profile-inferences/o_1',
            headers: { 'x-internal-token': INTERNAL_TOKEN },
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: Array<Record<string, unknown>> };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.length, 2);
        const first = body.data[0];
        assert.deepStrictEqual(Object.keys(first).sort(), [
            'confidence', 'dimension', 'inferred_at', 'sample_size', 'value', 'window_days',
        ]);
        assert.strictEqual(first.dimension, 'preferred_sectors');
        assert.strictEqual(typeof first.confidence, 'number');
        assert.strictEqual(first.confidence, 0.70);
        assert.strictEqual(typeof first.sample_size, 'number');
        assert.strictEqual(first.sample_size, 16);
        assert.strictEqual(first.window_days, null);
        assert.strictEqual(body.data[1].window_days, 30);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(first, 'user_id'), false, '不得泄漏 user_id');
    });

    it('只按 URL 中 userId 查询（不会返回其他用户数据）', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });
        const app = buildApp();
        await call(app, {
            method: 'GET',
            path: '/internal/user-profile-inferences/o_target',
            headers: { 'x-internal-token': INTERNAL_TOKEN },
        });

        const selectCalls = mockCalls.filter((c) => c.sql.includes('FROM user_profile_inferences'));
        assert.strictEqual(selectCalls.length, 1);
        assert.deepStrictEqual(selectCalls[0].params, ['o_target']);
        assert.ok(selectCalls[0].sql.includes('WHERE user_id = $1'));
    });

    it('缺 X-Internal-Token → 403 且不触达 SQL', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/internal/user-profile-inferences/o_1',
            headers: {},
        });

        assert.strictEqual(res.status, 403);
        assert.strictEqual(mockCalls.length, 0);
    });

    it('URL 无 userId 段 → 不触达 SQL（Express 参数化路由不匹配，返回 404）', async () => {
        mockCalls = [];
        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/internal/user-profile-inferences/',
            headers: { 'x-internal-token': INTERNAL_TOKEN },
        });

        assert.strictEqual(res.status, 404);
        assert.strictEqual(mockCalls.length, 0);
    });
});
