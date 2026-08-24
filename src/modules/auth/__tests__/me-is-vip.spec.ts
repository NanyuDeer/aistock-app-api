/**
 * GET /api/users/me 返回 is_vip 会员标记测试（2026-08-24 报告导出会员解锁）
 *
 * Mock strategy: monkey-patch pool.query（仓库惯例，见 tests/briefContractRoutes.test.ts）。
 * me 依次执行两次查询：先查 users 行（含 is_vip），再查 user_stocks 关联列表（返回空）。
 * 鉴权用 signJwt 真实签发；isTokenRevoked fail-open 未命中黑名单返回 false，无需额外 mock。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import { UserController } from '../userController';
import { signJwt } from '../../../shared/utils/jwt';
import pool from '../../../core/db';
import redis from '../../../core/redis';
import { CacheService } from '../../../shared/utils/CacheService';

const origQuery = pool.query.bind(pool);
const origGet = (CacheService as unknown as { get: unknown }).get;

before(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    // me 只读黑名单，屏蔽真实 Redis 依赖，避免连接保活挂起测试进程
    (CacheService as unknown as { get: unknown }).get = async () => null;
});

after(() => {
    (CacheService as unknown as { get: unknown }).get = origGet;
    // 恢复 pool 真实查询句柄
    ;(pool as unknown as { query: typeof pool.query }).query = origQuery;
    redis.disconnect();
});

function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.get('/api/users/me', (req, res, next) => UserController.me(req, res, next));
    return app;
}

function signToken(): string {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({ openid: 'o_vip_test', nickname: 't', iat: now, exp: now + 3600 }, process.env.JWT_SECRET!);
}

function call(app: Express, token: string): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            const req = http.request(
                { method: 'GET', hostname: '127.0.0.1', port: addr.port, path: '/api/users/me', headers: { authorization: `Bearer ${token}` } },
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

function mockPoolUsers(isVip: boolean | null) {
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: unknown) => {
        // 用户查询返回 is_vip；自选股关联查询返回空列表
        if (String(sql).includes('FROM users')) {
            return { rows: [{ openid: 'o_vip_test', nickname: 't', avatar_url: '', created_at: null, is_vip: isVip }] } as never;
        }
        return { rows: [] } as never;
    };
}

test('me 返回 is_vip=true（会员）', async () => {
    mockPoolUsers(true);
    const app = buildApp();
    const r = await call(app, signToken());
    assert.strictEqual(r.status, 200);
    const body = r.json as { data: { is_vip: boolean } };
    assert.strictEqual(body.data.is_vip, true);
});

test('me 返回 is_vip=false（非会员）', async () => {
    mockPoolUsers(false);
    const app = buildApp();
    const r = await call(app, signToken());
    assert.strictEqual(r.status, 200);
    const body = r.json as { data: { is_vip: boolean } };
    assert.strictEqual(body.data.is_vip, false);
});

test('me 后端未升级缺省 is_vip → 默认 false', async () => {
    mockPoolUsers(null);
    const app = buildApp();
    const r = await call(app, signToken());
    assert.strictEqual(r.status, 200);
    const body = r.json as { data: { is_vip: boolean } };
    assert.strictEqual(body.data.is_vip, false);
});