/**
 * requireLogin 登录守卫中间件 — unit tests（安全加固，2026-09-16）
 *
 * 覆盖：
 * - X-Internal-Token 匹配 → 放行（内部 cron/Python agent 零改动）
 * - X-Internal-Token 不匹配（是 token 但值错）→ 401
 * - 无任何凭据 → 401「未登录」
 * - JWT 有效（签名对 + 未撤销）→ 放行并注入 req.user
 * - JWT 无效/过期 → 401
 *
 * Mock 策略：valid 分支走 isTokenRevoked → CacheService（加载 core/redis）。
 * 本机无 redis 时 CacheService 降级本地 Map 空 → isTokenRevoked=false，无需 mock；
 * after() 调 redis.disconnect() 防挂起（对齐 session.spec 惯例）。
 * 注：INTERNAL_API_TOKEN 在 requireLogin 模块顶层读取，故此处动态 import。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import redis from '../../../core/redis';
import { signJwt, type JwtPayload } from '../jwt';

const SECRET = 'require-login-test-secret';
process.env.JWT_SECRET = SECRET;
process.env.INTERNAL_API_TOKEN = 'int-token-2026';

// 动态 import：须在 env 就绪后再加载模块（INTERNAL_TOKEN 顶层求值）
let requireLogin: (req: Request, res: Response, next: NextFunction) => void;

before(async () => {
    const mod = await import('../requireLogin');
    requireLogin = mod.requireLogin;
});

after(() => {
    redis.disconnect();
});

// ── fixtures ──
function makeReq(overrides: Partial<Record<'headers' | 'user', unknown>> = {}): Request {
    return { headers: {}, ...overrides } as Request;
}

type MockRes = Response & { statusCode: number; body: unknown };
function makeRes(): MockRes {
    const ctx = { statusCode: 0, body: null as unknown };
    const res = {
        status(code: number) { ctx.statusCode = code; return this; },
        json(payload: unknown) { ctx.body = payload; return this; },
        get statusCode(): number { return ctx.statusCode; },
        get body(): unknown { return ctx.body; },
    } as unknown as MockRes;
    return res;
}

function makeNext() {
    let called = 0;
    const next = () => { called += 1; };
    return { next, called: () => called };
}

function signUserPayload(overrides: Partial<JwtPayload> = {}): JwtPayload {
    const now = Date.now() / 1000;
    return { openid: 'openid_test', iat: now, exp: now + 3600, ...overrides };
}

test('X-Internal-Token 匹配 → 放行（内部 cron/Python agent 不受 JWT 约束）', () => {
    const req = makeReq({ headers: { 'x-internal-token': 'int-token-2026' } });
    const res = makeRes();
    const { next, called } = makeNext();
    requireLogin(req as Request, res, () => { next(); });
    assert.strictEqual(called(), 1);
});

test('X-Internal-Token 值不匹配 → 401', () => {
    const req = makeReq({ headers: { 'x-internal-token': 'wrong-token' } });
    const res = makeRes();
    requireLogin(req as Request, res, () => { assert.fail('不应放行'); });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body && (res.body as { code: number }).code, 401);
});

test('无任何凭据 → 401 未登录', () => {
    const req = makeReq();
    const res = makeRes();
    requireLogin(req, res, () => { assert.fail('不应放行'); });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body && (res.body as { message: string }).message, '未登录');
});

test('有效 JWT（签名对 + 未撤销）→ 放行并注入 user', async () => {
    const token = signJwt(signUserPayload(), SECRET);
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    let nextCalled = false;
    requireLogin(req as Request, res, () => { nextCalled = true; });
    // requireLogin 的 revoked 检查是异步，等待微任务
    await new Promise((r) => setImmediate(r));
    assert.ok(nextCalled, '有效 JWT 应放行');
    assert.strictEqual((req as { user?: JwtPayload }).user?.openid, 'openid_test');
});

test('无效/伪造 token → 401', async () => {
    const req = makeReq({ headers: { authorization: 'Bearer not.a.jwt' } });
    const res = makeRes();
    requireLogin(req, res, () => { assert.fail('不应放行'); });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(res.statusCode, 401);
});

test('已过期 token → 401', async () => {
    const token = signJwt(signUserPayload({ exp: Date.now() / 1000 - 60 }), SECRET);
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    requireLogin(req, res, () => { assert.fail('不应放行'); });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(res.statusCode, 401);
});