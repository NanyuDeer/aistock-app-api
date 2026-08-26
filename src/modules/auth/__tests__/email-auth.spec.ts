/**
 * 邮箱验证码登录 + 绑定接口测试（2026-08-25 统一账户模型）
 *
 * Mock strategy: monkey-patch pool.query（仓库惯例）。
 * - sendEmail / emailLogin：dev 放行固定测试码 EMAIL_DEV_TEST_CODE，验证码不依赖 Redis；
 *   限流走内存兜底（Redis 不可用）。
 * - bindEmail：先校验码（测试码放行）→ 归属冲突查询（空）→ UPDATE。
 * 鉴权用 signJwt 真实签发（payload 带 id）；isTokenRevoked fail-open 返回 false。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import { EmailAuthController } from '../EmailAuthController';
import { signJwt } from '../../../shared/utils/jwt';
import pool from '../../../core/db';
import redis from '../../../core/redis';
import { CacheService } from '../../../shared/utils/CacheService';

const origQuery = pool.query.bind(pool);
const origGet = (CacheService as unknown as { get: unknown }).get;
const EMAIL = 'user@163.com';

before(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    (CacheService as unknown as { get: unknown }).get = async () => null;
});

after(() => {
    (CacheService as unknown as { get: unknown }).get = origGet;
    ;(pool as unknown as { query: typeof pool.query }).query = origQuery;
    redis.disconnect();
});

function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.post('/api/auth/email/send', (req, res, next) => EmailAuthController.sendEmail(req, res, next));
    app.post('/api/auth/email/login', (req, res, next) => EmailAuthController.emailLogin(req, res, next));
    app.post('/api/auth/bind/email', (req, res, next) => EmailAuthController.bindEmail(req, res, next));
    app.post('/api/auth/bind/wechat', (req, res, next) => EmailAuthController.bindWechat(req, res, next));
    return app;
}

function signToken(id: string, openid: string): string {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({ id, openid, nickname: '', iat: now, exp: now + 3600 }, process.env.JWT_SECRET!);
}

function call(
    app: Express,
    method: string,
    path: string,
    body?: unknown,
    token?: string,
): Promise<{ status: number; json: { code: number; message: string; data: unknown } | null }> {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            const req = http.request(
                {
                    method,
                    hostname: '127.0.0.1',
                    port: addr.port,
                    path,
                    headers: {
                        'content-type': 'application/json',
                        ...(token ? { authorization: `Bearer ${token}` } : {}),
                    },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => {
                        server.close();
                        const text = Buffer.concat(chunks).toString('utf8');
                        let json: unknown = null;
                        try { json = JSON.parse(text); } catch { /* 非 JSON */ }
                        resolve({ status: res.statusCode ?? 0, json: json as never });
                    });
                },
            );
            req.on('error', reject);
            if (body !== undefined) req.write(JSON.stringify(body));
            req.end();
        });
    });
}

test('sendEmail 合法邮箱 → 200 + expireSeconds=300', async () => {
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/email/send', { email: EMAIL });
    assert.strictEqual(r.status, 200);
    const data = r.json?.data as { expireSeconds: number };
    assert.strictEqual(data.expireSeconds, 300);
});

test('sendEmail 非法邮箱 → 400', async () => {
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/email/send', { email: 'not-an-email' });
    assert.strictEqual(r.status, 400);
});

test('sendEmail 60s 内超限（>3 次）→ 429', async () => {
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
        const ok = await call(app, 'POST', '/api/auth/email/send', { email: 'other@163.com' });
        assert.strictEqual(ok.status, 200);
    }
    const limited = await call(app, 'POST', '/api/auth/email/send', { email: 'other@163.com' });
    assert.strictEqual(limited.status, 429);
});

test('emailLogin 邮箱 + dev 测试码 → 200 + token + userInfo.email', async () => {
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        if (String(sql).includes('INSERT INTO users')) {
            return { rows: [{ id: 'u1', openid: null, email: EMAIL, nickname: null, avatar_url: null }] } as never;
        }
        return { rows: [] } as never;
    };
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/email/login', { email: EMAIL, code: '123456' });
    assert.strictEqual(r.status, 200);
    const data = r.json?.data as { token: string; userInfo: { id: string; email: string | null } };
    assert.ok(data.token.length > 0);
    assert.strictEqual(data.userInfo.id, 'u1');
    assert.strictEqual(data.userInfo.email, EMAIL);
});

test('emailLogin 邮箱大小写归一化 → 同一账户', async () => {
    let lastParam: unknown = null;
    ;(pool as unknown as { query: typeof pool.query }).query = (async (sql: unknown, params?: unknown[]) => {
        lastParam = params?.[0];
        return { rows: [{ id: 'u1', openid: null, email: 'user@163.com', nickname: null, avatar_url: null }] } as never;
    }) as never;
    const app = buildApp();
    await call(app, 'POST', '/api/auth/email/login', { email: '  USER@163.COM ', code: '123456' });
    assert.strictEqual(lastParam, 'user@163.com');
});

test('emailLogin 错误验证码 → 400', async () => {
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/email/login', { email: EMAIL, code: '000000' });
    assert.strictEqual(r.status, 400);
});

test('bindEmail Bearer 登录 + 测试码 → 200 + emailBound=true', async () => {
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        const s = String(sql);
        if (s.includes('SELECT id FROM users WHERE email = $1 AND id <> $2')) {
            return { rows: [] } as never;
        }
        if (s.includes('UPDATE users SET email')) {
            return { rows: [{ id: 'u1', openid: null, email: EMAIL, nickname: '张三', avatar_url: '' }] } as never;
        }
        return { rows: [] } as never;
    };
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/bind/email', { email: EMAIL, code: '123456' }, signToken('u1', ''));
    assert.strictEqual(r.status, 200);
    const data = r.json?.data as { emailBound: boolean; email: string | null };
    assert.strictEqual(data.emailBound, true);
    assert.strictEqual(data.email, EMAIL);
});

test('bindEmail 邮箱已属他人 → 409', async () => {
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        if (String(sql).includes('SELECT id FROM users WHERE email = $1 AND id <> $2')) {
            return { rows: [{ id: 'other' }] } as never;
        }
        return { rows: [] } as never;
    };
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/bind/email', { email: EMAIL, code: '123456' }, signToken('u1', ''));
    assert.strictEqual(r.status, 409);
});

test('bindEmail 无 token → 401', async () => {
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/bind/email', { email: EMAIL, code: '123456' });
    assert.strictEqual(r.status, 401);
});

test('bindWechat 邮箱不属于当前账户 → 403', async () => {
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        if (String(sql).includes('SELECT id FROM users WHERE email = $1 AND id = $2')) {
            return { rows: [] } as never;
        }
        return { rows: [] } as never;
    };
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/bind/wechat', { email: EMAIL, code: '123456', wxCode: 'wx' }, signToken('u1', ''));
    assert.strictEqual(r.status, 403);
});
