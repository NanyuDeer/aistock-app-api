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
import { AuthController } from '../controller';
import { signJwt } from '../../../shared/utils/jwt';
import pool from '../../../core/db';
import redis from '../../../core/redis';
import { CacheService } from '../../../shared/utils/CacheService';

const origQuery = pool.query.bind(pool);
const origConnect = pool.connect.bind(pool);
const origExchange = AuthController.exchangeCodeForToken;
const origFetchUserInfo = AuthController.fetchWechatUserInfo;
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
    ;(pool as unknown as { connect: unknown }).connect = origConnect;
    AuthController.exchangeCodeForToken = origExchange;
    AuthController.fetchWechatUserInfo = origFetchUserInfo;
    redis.disconnect();
});

/** mock 微信授权换取 openid（避免真实 HTTP 调用） */
function mockWechatAuth(openid = 'wx-u1'): void {
    AuthController.exchangeCodeForToken = (async () => ({ openid, access_token: 'at', errcode: 0 })) as never;
    AuthController.fetchWechatUserInfo = (async () => ({ nickname: '微信用户', headimgurl: 'http://avatar' })) as never;
}

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

test('bindEmail 邮箱已绑非空账户（有自选股/VIP/微信/手机）→ 自动合并 200', async () => {
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        if (String(sql).includes('SELECT id FROM users WHERE email = $1 AND id <> $2')) {
            return { rows: [{ id: 'other' }] } as never;
        }
        return { rows: [] } as never;
    };
    // merge 事务客户端：副账户有数据（openid/phone/自选股/VIP）→ 自动合并而非 409
    const tx: string[] = [];
    const clientQuery = (async (sql: unknown, params?: unknown[]) => {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
            tx.push(s);
            return { rows: [] } as never;
        }
        tx.push(s);
        // 副账户行锁（参数 0 = 'other'）
        if (s.includes('FOR UPDATE')) return { rows: [{ id: 'other', openid: 'wx-other', email: EMAIL, phone: '13900000001', is_vip: true }] } as never;
        // 主账户身份读取（参数 0 = 'u1'）
        if (s.includes('SELECT openid, email, phone')) return { rows: [{ openid: null, email: null, phone: null }] } as never;
        // 表存在性检查
        if (s.includes('to_regclass')) return { rows: [{ t: 'user_settings', t2: 'user_notifications', t3: 'user_subscriptions' }] } as never;
        // 自选股合并（并集）
        if (s.includes('INSERT INTO user_stocks')) return { rows: [] } as never;
        if (s.includes('DELETE FROM user_stocks')) return { rows: [] } as never;
        // 清理副账户引用（设置/通知/订阅以主账户为准）
        if (s.includes('DELETE FROM user_settings')) return { rows: [] } as never;
        if (s.includes('DELETE FROM user_notifications')) return { rows: [] } as never;
        if (s.includes('DELETE FROM user_subscriptions')) return { rows: [] } as never;
        // VIP 继承：主 OR 副（副 is_vip=true → 主变会员）
        if (s.includes('UPDATE users SET is_vip')) return { rows: [] } as never;
        // 主账户补身份（email + openid + phone 均转移）
        if (s.includes('UPDATE users SET openid')) return { rows: [{ id: 'u1', openid: 'wx-other', email: EMAIL, phone: '13900000001', nickname: '张三', avatar_url: '' }] } as never;
        return { rows: [] } as never;
    }) as unknown as typeof pool.query;
    const client = { query: clientQuery, release: () => {} };
    ;(pool as unknown as { connect: unknown }).connect = async () => client;
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/bind/email', { email: EMAIL, code: '123456' }, signToken('u1', ''));
    assert.strictEqual(r.status, 200);
    const data = r.json?.data as { emailBound: boolean; email: string | null; openid: string | null };
    assert.strictEqual(data.emailBound, true);
    assert.strictEqual(data.email, EMAIL);
    assert.strictEqual(data.openid, 'wx-other', '副账户微信身份应一并转移');
    assert.ok(tx.includes('BEGIN') && tx.includes('COMMIT'), '合并事务应正常提交');
    // 顺序约束：必须"先释放副账户身份（置 NULL）→ 再补主账户身份"，否则 email/openid 唯一索引冲突
    const releaseIdx = tx.findIndex(s => s.includes('email = NULL') && s.includes('UPDATE users'));
    const grantIdx = tx.findIndex(s => s.includes('UPDATE users SET openid') && !s.includes('NULL'));
    assert.ok(releaseIdx >= 0 && grantIdx >= 0, '应同时存在释放与补身份 SQL');
    assert.ok(releaseIdx < grantIdx, '副账户身份应先在唯一约束上释放，主账户才可补入同值');
});

test('bindEmail 邮箱已绑空壳账户（无其他身份/自选股）→ 自动合并 200', async () => {
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        if (String(sql).includes('SELECT id FROM users WHERE email = $1 AND id <> $2')) {
            return { rows: [{ id: 'abandoned' }] } as never;
        }
        return { rows: [] } as never;
    };
    const tx: string[] = [];
    const clientQuery = (async (sql: unknown, params?: unknown[]) => {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
            tx.push(s);
            return { rows: [] } as never;
        }
        if (s.includes('FOR UPDATE')) return { rows: [{ id: 'abandoned', openid: null, email: EMAIL, phone: null, is_vip: false }] } as never;
        if (s.includes('SELECT openid, email, phone')) return { rows: [{ openid: null, email: null, phone: null }] } as never;
        if (s.includes('to_regclass')) return { rows: [{ t: null, t2: null, t3: null }] } as never;
        if (s.includes('INSERT INTO user_stocks')) return { rows: [] } as never;
        if (s.includes('DELETE FROM user_stocks')) return { rows: [] } as never;
        if (s.includes('UPDATE users SET is_vip')) return { rows: [] } as never;
        if (s.includes('UPDATE users SET email')) return { rows: [{ id: 'u1', openid: null, email: EMAIL, nickname: '张三', avatar_url: '' }] } as never;
        return { rows: [] } as never;
    }) as unknown as typeof pool.query;
    const client = { query: clientQuery, release: () => {} };
    ;(pool as unknown as { connect: unknown }).connect = async () => client;
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/bind/email', { email: EMAIL, code: '123456' }, signToken('u1', ''));
    assert.strictEqual(r.status, 200);
    const data = r.json?.data as { emailBound: boolean; email: string | null };
    assert.strictEqual(data.emailBound, true);
    assert.strictEqual(data.email, EMAIL);
    assert.ok(tx.includes('BEGIN') && tx.includes('COMMIT'), '合并事务应正常提交');
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

test('bindWechat 微信已绑空壳账户（无邮箱/手机/自选股/设置）→ 自动合并 200', async () => {
    mockWechatAuth('wx-u1');
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        const s = String(sql);
        if (s.includes('SELECT id FROM users WHERE email = $1 AND id = $2')) {
            return { rows: [{ id: 'u1' }] } as never;
        }
        if (s.includes('SELECT id FROM users WHERE openid = $1 AND id <> $2')) {
            return { rows: [{ id: 'abandoned-wx' }] } as never;
        }
        return { rows: [] } as never;
    };
    const tx: string[] = [];
    const clientQuery = (async (sql: unknown, params?: unknown[]) => {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
            tx.push(s);
            return { rows: [] } as never;
        }
        if (s.includes('FOR UPDATE')) return { rows: [{ id: 'abandoned-wx', openid: 'wx-u1', email: null, phone: null, is_vip: false }] } as never;
        if (s.includes('SELECT openid, email, phone')) return { rows: [{ openid: null, email: EMAIL, phone: null }] } as never;
        if (s.includes('to_regclass')) return { rows: [{ t: null, t2: null, t3: null }] } as never;
        if (s.includes('INSERT INTO user_stocks')) return { rows: [] } as never;
        if (s.includes('DELETE FROM user_stocks')) return { rows: [] } as never;
        if (s.includes('UPDATE users SET is_vip')) return { rows: [] } as never;
        if (s.includes('UPDATE users SET openid')) return { rows: [{ id: 'u1', openid: 'wx-u1', email: EMAIL, nickname: '微信用户', avatar_url: 'http://avatar' }] } as never;
        return { rows: [] } as never;
    }) as unknown as typeof pool.query;
    const client = { query: clientQuery, release: () => {} };
    ;(pool as unknown as { connect: unknown }).connect = async () => client;
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/bind/wechat', { email: EMAIL, code: '123456', wxCode: 'wx' }, signToken('u1', ''));
    assert.strictEqual(r.status, 200);
    const data = r.json?.data as { wechatBound: boolean; openid: string | null };
    assert.strictEqual(data.wechatBound, true);
    assert.strictEqual(data.openid, 'wx-u1');
    assert.ok(tx.includes('BEGIN') && tx.includes('COMMIT'), '合并事务应正常提交');
});

test('bindWechat 微信已绑非空账户（有邮箱绑定）→ 自动合并 200', async () => {
    mockWechatAuth('wx-other');
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        const s = String(sql);
        if (s.includes('SELECT id FROM users WHERE email = $1 AND id = $2')) {
            return { rows: [{ id: 'u1' }] } as never;
        }
        if (s.includes('SELECT id FROM users WHERE openid = $1 AND id <> $2')) {
            return { rows: [{ id: 'wx-other' }] } as never;
        }
        return { rows: [] } as never;
    };
    // 副账户有邮箱绑定（非空壳）→ 自动合并：邮箱一并转移，而非 409
    const tx: string[] = [];
    const clientQuery = (async (sql: unknown, params?: unknown[]) => {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
            tx.push(s);
            return { rows: [] } as never;
        }
        if (s.includes('FOR UPDATE')) return { rows: [{ id: 'wx-other', openid: 'wx-other', email: 'other@163.com', phone: null, is_vip: false }] } as never;
        if (s.includes('SELECT openid, email, phone')) return { rows: [{ openid: null, email: EMAIL, phone: null }] } as never;
        if (s.includes('to_regclass')) return { rows: [{ t: null, t2: null, t3: null }] } as never;
        if (s.includes('INSERT INTO user_stocks')) return { rows: [] } as never;
        if (s.includes('DELETE FROM user_stocks')) return { rows: [] } as never;
        if (s.includes('UPDATE users SET is_vip')) return { rows: [] } as never;
        if (s.includes('UPDATE users SET openid')) return { rows: [{ id: 'u1', openid: 'wx-other', email: 'other@163.com', nickname: '微信用户', avatar_url: 'http://avatar' }] } as never;
        return { rows: [] } as never;
    }) as unknown as typeof pool.query;
    const client = { query: clientQuery, release: () => {} };
    ;(pool as unknown as { connect: unknown }).connect = async () => client;
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/bind/wechat', { email: EMAIL, code: '123456', wxCode: 'wx' }, signToken('u1', ''));
    assert.strictEqual(r.status, 200);
    const data = r.json?.data as { wechatBound: boolean; openid: string | null; email: string | null };
    assert.strictEqual(data.wechatBound, true);
    assert.strictEqual(data.openid, 'wx-other');
    assert.strictEqual(data.email, 'other@163.com', '副账户邮箱应一并转移');
    assert.ok(tx.includes('BEGIN') && tx.includes('COMMIT'), '合并事务应正常提交');
});

test('bindWechat 手机号账户（无邮箱）→ 手机号+验证码证明归属 → 200', async () => {
    mockWechatAuth('wx-mobile');
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        const s = String(sql);
        if (s.includes('SELECT id FROM users WHERE phone = $1 AND id = $2')) {
            return { rows: [{ id: 'u1' }] } as never;
        }
        if (s.includes('SELECT id FROM users WHERE openid = $1 AND id <> $2')) {
            return { rows: [] } as never;
        }
        if (s.includes('UPDATE users SET openid')) {
            return { rows: [{ id: 'u1', openid: 'wx-mobile', email: null, phone: '13900000001', nickname: '微信用户', avatar_url: 'http://avatar' }] } as never;
        }
        return { rows: [] } as never;
    };
    const app = buildApp();
    // 手机号账户绑定微信：传 body.phone + 短信验证码（dev 测试码 123456）+ wxCode
    const r = await call(app, 'POST', '/api/auth/bind/wechat', { phone: '13900000001', code: '123456', wxCode: 'wx' }, signToken('u1', ''));
    assert.strictEqual(r.status, 200);
    const data = r.json?.data as { wechatBound: boolean; openid: string | null; phone: string | null };
    assert.strictEqual(data.wechatBound, true);
    assert.strictEqual(data.openid, 'wx-mobile');
    assert.strictEqual(data.phone, '13900000001', '手机号保留在当前账户');
});

test('bindWechat 手机号不属于当前账户 → 403', async () => {
    mockWechatAuth('wx-x');
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        if (String(sql).includes('SELECT id FROM users WHERE phone = $1 AND id = $2')) {
            return { rows: [] } as never; // 手机号不在当前账户
        }
        return { rows: [] } as never;
    };
    const app = buildApp();
    const r = await call(app, 'POST', '/api/auth/bind/wechat', { phone: '13900000002', code: '123456', wxCode: 'wx' }, signToken('u1', ''));
    assert.strictEqual(r.status, 403);
});
