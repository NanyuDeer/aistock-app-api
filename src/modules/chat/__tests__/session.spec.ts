/**
 * Chat Session 元数据 API — integration tests
 *
 * 覆盖：upsert 首次创建 title 截断 / 二次 upsert 只更新 last_message_at 不改 title /
 * list 排序与归属过滤 / delete 归属校验 / 401 无 token / 400 缺 session_id。
 *
 * Mock 策略：monkey-patch pool.query（SessionController 持有同一 pool 对象引用，无 DB 连接）。
 * 注意：SessionController 依赖链不加载 redis（core/db.ts 纯净），无需 redis.disconnect()。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../../core/db';
import { SessionController } from '../sessionController';
import { signJwt } from '../../../shared/utils/jwt';

// ── Mock pool.query ──
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

// ── Test helpers ──
const JWT_SECRET = process.env.JWT_SECRET || 'session-test-secret';

function makeToken(openid = 'openid_42'): string {
    return signJwt(
        { openid, nickname: '测试用户', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
        JWT_SECRET,
    );
}

// 与 index.ts 注册完全一致的三条路由（不 import index.ts，避免启动副作用）
function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.post('/api/chat/sessions', (req, res, next) => SessionController.upsert(req, res, next));
    app.get('/api/chat/sessions', (req, res, next) => SessionController.list(req, res, next));
    app.delete('/api/chat/sessions/:id', (req, res, next) => SessionController.remove(req, res, next));
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

// ── Tests ──
describe('Chat Session API', () => {
    before(() => {
        process.env.JWT_SECRET = JWT_SECRET;
        mockCalls = [];
        mockResponder = null;
    });

    after(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (pool as any).query = originalQuery;
        /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    it('upsert 首次创建：title 取 question 前 30 字，user_id 为 JWT openid', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [{ id: 'app_1785892249', title: '今天大盘怎么样，能看看资金流向吗，还有龙头股今天的涨跌幅是多', last_message_at: '2026-08-05T02:00:00.000Z' }],
        });

        const app = buildApp();
        const res = await call(app, {
            method: 'POST',
            path: '/api/chat/sessions',
            headers: { 'content-type': 'application/json', ...authHeader() },
            body: { session_id: 'app_1785892249', question: '今天大盘怎么样，能看看资金流向吗，还有龙头股今天的涨跌幅是多少呢' },
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: { session_id: string; title: string; last_message_at: string } };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.session_id, 'app_1785892249');
        assert.strictEqual(body.data.title.length, 30, 'title 应截断为 30 字');
        assert.ok(body.data.last_message_at, 'last_message_at 应返回');

        const insertCall = mockCalls.find((c) => c.sql.includes('INSERT INTO chat_sessions'));
        assert.ok(insertCall, 'expected 1 INSERT INTO chat_sessions call');
        assert.strictEqual(insertCall.params[0], 'app_1785892249');
        assert.strictEqual(insertCall.params[1], 'openid_42', 'user_id 应为 JWT openid');
        assert.strictEqual((insertCall.params[2] as string).length, 30, 'INSERT 分支 title 参数为截断后 30 字');
    });

    it('upsert 空 question → title 默认「新会话」', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [{ id: 'app_1', title: '新会话', last_message_at: '2026-08-05T02:00:00.000Z' }],
        });

        const app = buildApp();
        const res = await call(app, {
            method: 'POST',
            path: '/api/chat/sessions',
            headers: { 'content-type': 'application/json', ...authHeader() },
            body: { session_id: 'app_1' },
        });

        const body = res.json as { code: number; data: { title: string } };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.title, '新会话');
        const insertCall = mockCalls.find((c) => c.sql.includes('INSERT INTO chat_sessions'));
        assert.strictEqual(insertCall!.params[2], '新会话');
    });

    it('二次 upsert（同 id）：SQL 为 ON CONFLICT 且 DO UPDATE 不更新 title', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [{ id: 'app_1785892249', title: '旧标题', last_message_at: '2026-08-05T03:00:00.000Z' }],
        });

        const app = buildApp();
        const res = await call(app, {
            method: 'POST',
            path: '/api/chat/sessions',
            headers: { 'content-type': 'application/json', ...authHeader() },
            body: { session_id: 'app_1785892249', question: '新问题不应改标题' },
        });

        const body = res.json as { code: number; data: { title: string } };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.title, '旧标题', '冲突分支保留原 title（mock 返回旧值）');

        const insertCall = mockCalls.find((c) => c.sql.includes('INSERT INTO chat_sessions'));
        assert.ok(insertCall!.sql.includes('ON CONFLICT (id) DO UPDATE'), '应为幂等 upsert');
        assert.ok(insertCall!.sql.includes('last_message_at = CURRENT_TIMESTAMP'), 'DO UPDATE 只刷新 last_message_at');
        assert.doesNotMatch(insertCall!.sql, /DO UPDATE[\s\S]*title\s*=/, 'DO UPDATE 不得更新 title');
    });

    it('list：按 user_id 归属过滤、last_message_at DESC、LIMIT 50，返回驼峰数组', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [
                { id: 'app_2', title: '会话二', last_message_at: '2026-08-05T02:00:00.000Z', created_at: '2026-08-04T01:00:00.000Z' },
                { id: 'app_1', title: '会话一', last_message_at: '2026-08-03T02:00:00.000Z', created_at: '2026-08-03T01:00:00.000Z' },
            ],
        });

        const app = buildApp();
        const res = await call(app, { method: 'GET', path: '/api/chat/sessions', headers: authHeader() });

        const body = res.json as { code: number; data: Array<{ session_id: string; title: string; last_message_at: string; created_at: string }> };
        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.length, 2);
        assert.deepStrictEqual(
            body.data[0],
            { session_id: 'app_2', title: '会话二', last_message_at: '2026-08-05T02:00:00.000Z', created_at: '2026-08-04T01:00:00.000Z' },
            '行应映射为驼峰字段',
        );

        const selectCall = mockCalls.find((c) => c.sql.includes('FROM chat_sessions'));
        assert.ok(selectCall, 'expected 1 SELECT FROM chat_sessions');
        assert.ok(selectCall.sql.includes('WHERE user_id = $1'));
        assert.ok(selectCall.sql.includes('ORDER BY last_message_at DESC'));
        assert.ok(selectCall.sql.includes('LIMIT 50'));
        assert.deepStrictEqual(selectCall.params, ['openid_42'], '归属过滤参数应为 openid');
    });

    it('delete：归属校验 WHERE id AND user_id，返回 {code:200}', async () => {
        mockCalls = [];
        mockResponder = () => ({ rows: [] });

        const app = buildApp();
        const res = await call(app, {
            method: 'DELETE',
            path: '/api/chat/sessions/app_1785892249',
            headers: authHeader(),
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number };
        assert.strictEqual(body.code, 200);

        const deleteCall = mockCalls.find((c) => c.sql.includes('DELETE FROM chat_sessions'));
        assert.ok(deleteCall, 'expected 1 DELETE FROM chat_sessions');
        assert.ok(deleteCall.sql.includes('WHERE id = $1 AND user_id = $2'));
        assert.deepStrictEqual(deleteCall.params, ['app_1785892249', 'openid_42']);
    });

    it('401：无 token 时 POST/GET/DELETE 均返回 401', async () => {
        const app = buildApp();
        const post = await call(app, {
            method: 'POST',
            path: '/api/chat/sessions',
            headers: { 'content-type': 'application/json' },
            body: { session_id: 'app_1', question: 'q' },
        });
        assert.strictEqual(post.status, 401);

        const get = await call(app, { method: 'GET', path: '/api/chat/sessions' });
        assert.strictEqual(get.status, 401);

        const del = await call(app, { method: 'DELETE', path: '/api/chat/sessions/app_1' });
        assert.strictEqual(del.status, 401);
    });

    it('400：POST 缺 session_id / session_id 非法字符', async () => {
        const app = buildApp();

        const missing = await call(app, {
            method: 'POST',
            path: '/api/chat/sessions',
            headers: { 'content-type': 'application/json', ...authHeader() },
            body: { question: 'q' },
        });
        assert.strictEqual(missing.status, 400);

        const invalid = await call(app, {
            method: 'POST',
            path: '/api/chat/sessions',
            headers: { 'content-type': 'application/json', ...authHeader() },
            body: { session_id: 'has space 123' },
        });
        assert.strictEqual(invalid.status, 400);
    });
});
