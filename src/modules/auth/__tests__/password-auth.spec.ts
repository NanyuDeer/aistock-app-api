import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { Express } from 'express';
import pool from '../../../core/db';
import redis from '../../../core/redis';
import { CacheService } from '../../../shared/utils/CacheService';
import { hashPassword } from '../passwordUtils';
import { PasswordAuthController } from '../PasswordAuthController';
import { FAIL_MAX } from '../loginThrottle';

// 说明：用内存兜底（本地 Redis 不可用），每条用例使用互不相同的 account，
// 避免 loginThrottle 的模块级内存 Map 在用例间串扰。

type QueryResult = { rows: Array<Record<string, unknown>> };
type ApiJson = { code: number; message: string; data: unknown } | null;

const origQuery = pool.query.bind(pool);
const origGet = (CacheService as unknown as { get: unknown }).get;

before(() => {
    process.env.JWT_SECRET ||= 'test-secret';
    process.env.NODE_ENV ||= 'test';
    (CacheService as unknown as { get: unknown }).get = async () => null;
});

after(() => {
    (pool as unknown as { query: unknown }).query = origQuery;
    (CacheService as unknown as { get: unknown }).get = origGet;
    redis.disconnect();
});

function mockQuery(impl: (sql: string, params?: unknown[]) => Promise<QueryResult>): void {
    (pool as unknown as { query: typeof pool.query }).query = ((sql: string, params?: unknown[]) =>
        impl(sql, params)) as unknown as typeof pool.query;
}

function buildApp(): Express {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.post('/api/auth/register', (req, res, next) => PasswordAuthController.register(req, res, next));
    app.post('/api/auth/password/login', (req, res, next) => PasswordAuthController.passwordLogin(req, res, next));
    return app;
}

function call(
    app: Express,
    method: string,
    path: string,
    body?: unknown,
    opts?: { ip?: string },
): Promise<{ status: number; json: ApiJson }> {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            const payload = body === undefined ? null : JSON.stringify(body);
            const headers: Record<string, string> = {};
            if (payload !== null) {
                headers['content-type'] = 'application/json';
                headers['content-length'] = Buffer.byteLength(payload).toString();
            }
            if (opts?.ip) headers['x-forwarded-for'] = opts.ip;
            const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c as Buffer));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json: ApiJson = null;
                    try {
                        json = JSON.parse(text) as ApiJson;
                    } catch {
                        json = null;
                    }
                    server.close();
                    resolve({ status: res.statusCode ?? 0, json });
                });
            });
            req.on('error', (err) => {
                server.close();
                reject(err);
            });
            if (payload !== null) req.write(payload);
            req.end();
        });
    });
}

test('注册成功：200 且返回 token，落库 hash 以 scrypt$ 开头', async () => {
    const account = '13900000001';
    let insertedParams: unknown[] | undefined;
    mockQuery(async (sql, params) => {
        if (sql.includes('INSERT INTO users')) {
            insertedParams = params;
            return { rows: [{ id: 'u1', openid: null, phone: account, email: null, nickname: null, avatar_url: null }] };
        }
        return { rows: [] };
    });
    const res = await call(buildApp(), 'POST', '/api/auth/register', { account, password: 'abc12345', code: '123456' }, { ip: '10.1.0.1' });
    assert.equal(res.status, 200);
    const data = res.json?.data as { token?: string } | undefined;
    assert.ok(data && typeof data.token === 'string' && data.token.length > 0);
    assert.ok(typeof insertedParams?.[1] === 'string' && (insertedParams[1] as string).startsWith('scrypt$'));
});

test('注册已设密码账号：409', async () => {
    mockQuery(async (sql) => {
        if (sql.includes('INSERT INTO users')) return { rows: [] };
        return { rows: [] };
    });
    const res = await call(buildApp(), 'POST', '/api/auth/register', { account: '13900000011', password: 'abc12345', code: '123456' }, { ip: '10.1.0.2' });
    assert.equal(res.status, 409);
    assert.equal(res.json?.message, '该账号已设置密码');
});

test('注册验证码错误：400', async () => {
    mockQuery(async () => ({ rows: [] }));
    const res = await call(buildApp(), 'POST', '/api/auth/register', { account: '13900000002', password: 'abc12345', code: '000000' }, { ip: '10.1.0.3' });
    assert.equal(res.status, 400);
});

test('注册弱密码：400', async () => {
    mockQuery(async () => ({ rows: [] }));
    const res = await call(buildApp(), 'POST', '/api/auth/register', { account: '13900000012', password: '123', code: '123456' }, { ip: '10.1.0.4' });
    assert.equal(res.status, 400);
});

test('密码登录成功：200 且返回 token', async () => {
    const account = '13900000013';
    mockQuery(async (sql) => {
        if (sql.includes('SELECT')) {
            return { rows: [{ id: 'u5', openid: null, phone: account, email: null, nickname: null, avatar_url: null, password_hash: hashPassword('abc12345') }] };
        }
        return { rows: [] };
    });
    const res = await call(buildApp(), 'POST', '/api/auth/password/login', { account, password: 'abc12345' }, { ip: '10.2.0.1' });
    assert.equal(res.status, 200);
    const data = res.json?.data as { token?: string } | undefined;
    assert.ok(data && typeof data.token === 'string' && data.token.length > 0);
});

test('密码错误：401 且统一文案', async () => {
    const account = '13900000014';
    mockQuery(async (sql) => {
        if (sql.includes('SELECT')) {
            return { rows: [{ id: 'u6', openid: null, phone: account, email: null, nickname: null, avatar_url: null, password_hash: hashPassword('abc12345') }] };
        }
        return { rows: [] };
    });
    const res = await call(buildApp(), 'POST', '/api/auth/password/login', { account, password: 'wrong1234' }, { ip: '10.2.0.2' });
    assert.equal(res.status, 401);
    assert.equal(res.json?.message, '账号或密码错误');
});

test('同账号连续失败达到阈值后返回 429 且不再校验密码', async () => {
    const account = '13900000015';
    const ip = '10.3.0.1';
    let selectCount = 0;
    mockQuery(async (sql) => {
        if (sql.includes('SELECT')) {
            selectCount += 1;
            return { rows: [{ id: 'u7', openid: null, phone: account, email: null, nickname: null, avatar_url: null, password_hash: hashPassword('abc12345') }] };
        }
        return { rows: [] };
    });
    const app = buildApp();
    for (let i = 0; i < FAIL_MAX; i += 1) {
        const r = await call(app, 'POST', '/api/auth/password/login', { account, password: 'wrong1234' }, { ip });
        assert.equal(r.status, 401);
    }
    const blocked = await call(app, 'POST', '/api/auth/password/login', { account, password: 'abc12345' }, { ip });
    assert.equal(blocked.status, 429);
    assert.equal(selectCount, FAIL_MAX);
    assert.equal(blocked.json?.message, '尝试过于频繁，请稍后再试');
    const data = blocked.json?.data as { fallback?: string } | undefined;
    assert.equal(data?.fallback, undefined);
});

test('登录成功后账号计数清除（同账号可再次正常尝试）', async () => {
    const account = '13900000019';
    const ip = '10.3.0.3';
    mockQuery(async (sql) => {
        if (sql.includes('SELECT')) {
            return { rows: [{ id: 'u9', openid: null, phone: account, email: null, nickname: null, avatar_url: null, password_hash: hashPassword('abc12345') }] };
        }
        return { rows: [] };
    });
    const app = buildApp();
    const bad = await call(app, 'POST', '/api/auth/password/login', { account, password: 'wrong1234' }, { ip });
    const good = await call(app, 'POST', '/api/auth/password/login', { account, password: 'abc12345' }, { ip });
    const bad2 = await call(app, 'POST', '/api/auth/password/login', { account, password: 'wrong1234' }, { ip });
    assert.equal(bad.status, 401);
    assert.equal(good.status, 200);
    assert.equal(bad2.status, 401);
});

test('账号未设置密码：401 统一文案', async () => {
    const account = '13900000020';
    mockQuery(async (sql) => {
        if (sql.includes('SELECT')) {
            return { rows: [{ id: 'u10', openid: null, phone: account, email: null, nickname: null, avatar_url: null, password_hash: null }] };
        }
        return { rows: [] };
    });
    const res = await call(buildApp(), 'POST', '/api/auth/password/login', { account, password: 'abc12345' }, { ip: '10.4.0.1' });
    assert.equal(res.status, 401);
    assert.equal(res.json?.message, '账号或密码错误');
});

