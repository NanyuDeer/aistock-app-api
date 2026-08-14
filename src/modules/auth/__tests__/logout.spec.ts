/**
 * POST /api/auth/logout 测试（token-revocation Step 2，2026-08-11）
 *
 * Mock strategy: 临时替换 CacheService.set 静态方法（仓库惯例）控制持久写落地状态；
 * 合法 token 用 signJwt 真实签发（含 jti）；legacy token 手工构造（无 jti）。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import { CacheService, TOKEN_BLACKLIST_PREFIX } from '../../../shared/utils/CacheService';
import redis from '../../../core/redis';
import { signJwt } from '../../../shared/utils/jwt';
import { AuthController } from '../controller';

const origSet = CacheService.set.bind(CacheService) as unknown;

function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.post('/api/auth/logout', (req, res, next) => AuthController.logout(req, res, next));
    return app;
}

function signLegacyToken(): string {
    // 手工构造无 jti 的 JWT（模拟在途旧 token）
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const body = Buffer.from(JSON.stringify({ openid: 'o_legacy', nickname: 't', iat: now, exp: now + 3600 }))
        .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const input = `${header}.${body}`;
    const sig = crypto.createHmac('sha256', process.env.JWT_SECRET!).update(input).digest()
        .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${input}.${sig}`;
}

function call(app: Express, opts: { headers?: http.OutgoingHttpHeaders }): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            const req = http.request(
                { method: 'POST', hostname: '127.0.0.1', port: addr.port, path: '/api/auth/logout', headers: opts.headers },
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
                }
            );
            req.on('error', reject);
            req.end();
        });
    });
}

before(() => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; });
after(() => {
    (CacheService as unknown as { set: unknown }).set = origSet;
    // 关闭真实 Redis 连接，避免事件循环被保活导致测试进程挂起（仓库惯例，
    // 参见 cacheService.spec.ts / internal.index-quotes.test.ts 的 after hook）
    redis.disconnect();
});

describe('POST /api/auth/logout', () => {
    it('无 token → 200 且不写黑名单（幂等）', async () => {
        let setCalls = 0;
        (CacheService as unknown as { set: unknown }).set = async (): Promise<boolean> => { setCalls++; return true; };
        const app = buildApp();
        const r = await call(app, { headers: {} });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(setCalls, 0);
    });

    it('有效 token（含 jti）→ 200 且按 jti 写黑名单', async () => {
        let setKey = '';
        (CacheService as unknown as { set: unknown }).set = async (key: string): Promise<boolean> => {
            setKey = key;
            return true;
        };
        const now = Math.floor(Date.now() / 1000);
        const token = signJwt({ openid: 'o_1', nickname: 't', iat: now, exp: now + 3600 }, process.env.JWT_SECRET!);
        const app = buildApp();
        const r = await call(app, { headers: { authorization: `Bearer ${token}` } });
        assert.strictEqual(r.status, 200);
        assert.ok(setKey.startsWith(TOKEN_BLACKLIST_PREFIX));
        assert.ok(setKey.length > TOKEN_BLACKLIST_PREFIX.length);
        const json = r.json as { data: unknown };
        assert.deepStrictEqual(json.data, null);
    });

    it('持久写未落地（仅内存）→ 200 + degraded: true', async () => {
        (CacheService as unknown as { set: unknown }).set = async (): Promise<boolean> => false;
        const now = Math.floor(Date.now() / 1000);
        const token = signJwt({ openid: 'o_2', nickname: 't', iat: now, exp: now + 3600 }, process.env.JWT_SECRET!);
        const app = buildApp();
        const r = await call(app, { headers: { authorization: `Bearer ${token}` } });
        assert.strictEqual(r.status, 200);
        const json = r.json as { data: { degraded: boolean } };
        assert.strictEqual(json.data.degraded, true);
    });

    it('无效 token → 200 且不写黑名单（幂等，不锁死登出）', async () => {
        let setCalls = 0;
        (CacheService as unknown as { set: unknown }).set = async (): Promise<boolean> => { setCalls++; return true; };
        const app = buildApp();
        const r = await call(app, { headers: { authorization: 'Bearer garbage.token.value' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(setCalls, 0);
    });

    it('无 jti legacy token → 200 + legacy: true 且不写黑名单', async () => {
        let setCalls = 0;
        (CacheService as unknown as { set: unknown }).set = async (): Promise<boolean> => { setCalls++; return true; };
        const legacy = signLegacyToken();
        const app = buildApp();
        const r = await call(app, { headers: { authorization: `Bearer ${legacy}` } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(setCalls, 0);
        const json = r.json as { data: { legacy: boolean } };
        assert.strictEqual(json.data.legacy, true);
    });
});
