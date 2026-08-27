/**
 * 短信验证码登录 + 绑定接口测试（2026-08-25 统一账户模型）
 *
 * Mock strategy: monkey-patch pool.query（仓库惯例）。
 * - sendSms / smsLogin：dev 放行固定测试码 SMS_DEV_TEST_CODE，验证码不依赖 Redis；
 *   限流走内存兜底（Redis 不可用）。
 * - bind/phone：先校验码（测试码放行）→ 归属冲突查询（空）→ UPDATE。
 * 鉴权用 signJwt 真实签发（payload 带 id）；isTokenRevoked fail-open 返回 false。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import { SmsAuthController } from '../SmsAuthController';
import { signJwt } from '../../../shared/utils/jwt';
import pool from '../../../core/db';
import redis from '../../../core/redis';
import { CacheService } from '../../../shared/utils/CacheService';

const origQuery = pool.query.bind(pool);
const origGet = (CacheService as unknown as { get: unknown }).get;
const PHONE = '13800000000';

before(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    // 屏蔽真实 Redis 依赖：isTokenRevoked 读黑名单 fail-open；验证码/限流走内存兜底
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
    app.post('/api/auth/sms/send', (req, res, next) => SmsAuthController.sendSms(req, res, next));
    app.post('/api/auth/sms/login', (req, res, next) => SmsAuthController.smsLogin(req, res, next));
    app.post('/api/auth/bind/phone', (req, res, next) => SmsAuthController.bindPhone(req, res, next));
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

test('sendSms 合法手机号 → 200 + expireSeconds=300', async () => {
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/sms/send', { phone: PHONE });
    assert.strictEqual(r.status, 200);
    const data = r.json?.data as { expireSeconds: number };
    assert.strictEqual(data.expireSeconds, 300);
});

test('sendSms 非法手机号 → 400', async () => {
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/sms/send', { phone: '123456' });
    assert.strictEqual(r.status, 400);
});

test('sendSms 60s 内超限（>3 次）→ 429', async () => {
    const app = buildApp();
    // 内存限流兜底：前 3 次放行，第 4 次 429（RATE_MAX=3）
    for (let i = 0; i < 3; i++) {
        const ok = await call(app, 'POST', '/api/auth/sms/send', { phone: '13900000001' });
        assert.strictEqual(ok.status, 200);
    }
    const limited = await call(app, 'POST', '/api/auth/sms/send', { phone: '13900000001' });
    assert.strictEqual(limited.status, 429);
});

test('smsLogin 手机号 + dev 测试码 → 200 + token + userInfo', async () => {
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        if (String(sql).includes('INSERT INTO users')) {
            return { rows: [{ id: 'u1', openid: null, phone: PHONE, nickname: null, avatar_url: null }] } as never;
        }
        return { rows: [] } as never;
    };
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/sms/login', { phone: PHONE, code: '123456' });
    assert.strictEqual(r.status, 200);
    const data = r.json?.data as { token: string; userInfo: { id: string; phone: string | null } };
    assert.ok(data.token.length > 0);
    assert.strictEqual(data.userInfo.id, 'u1');
    assert.strictEqual(data.userInfo.phone, PHONE);
});

test('smsLogin 错误验证码 → 400', async () => {
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/sms/login', { phone: PHONE, code: '000000' });
    assert.strictEqual(r.status, 400);
});

test('bindPhone Bearer 登录 + 测试码 → 200 + phoneBound=true', async () => {
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        const s = String(sql);
        if (s.includes('SELECT id FROM users WHERE phone = $1 AND id <> $2')) {
            return { rows: [] } as never; // 无归属冲突
        }
        if (s.includes('UPDATE users SET phone')) {
            return { rows: [{ id: 'u1', openid: null, phone: PHONE, nickname: '张三', avatar_url: '' }] } as never;
        }
        return { rows: [] } as never;
    };
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/bind/phone', { phone: PHONE, code: '123456' }, signToken('u1', ''));
    assert.strictEqual(r.status, 200);
    const data = r.json?.data as { phoneBound: boolean; phone: string | null };
    assert.strictEqual(data.phoneBound, true);
    assert.strictEqual(data.phone, PHONE);
});

test('bindPhone 手机号已属他人 → 409', async () => {
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        if (String(sql).includes('SELECT id FROM users WHERE phone = $1 AND id <> $2')) {
            return { rows: [{ id: 'other' }] } as never;
        }
        return { rows: [] } as never;
    };
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/bind/phone', { phone: PHONE, code: '123456' }, signToken('u1', ''));
    assert.strictEqual(r.status, 409);
});

test('bindPhone 无 token → 401', async () => {
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/bind/phone', { phone: PHONE, code: '123456' });
    assert.strictEqual(r.status, 401);
});
