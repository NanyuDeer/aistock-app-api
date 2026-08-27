/**
 * tokenBlacklist 工具测试（token-revocation Task 3，2026-08-11）
 *
 * Mock strategy: 临时替换 CacheService.set / CacheService.get 静态方法
 * （仓库既有惯例，见 internal.index-quotes.test.ts），不触达真实 Redis。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CacheService, TOKEN_BLACKLIST_PREFIX } from '../CacheService';
import { revokeToken, isTokenRevoked } from '../tokenBlacklist';
import type { JwtPayload } from '../jwt';
import redis from '../../../core/redis';

const origSet = CacheService.set.bind(CacheService) as unknown;
const origGet = CacheService.get.bind(CacheService) as unknown;

const payloadOf = (jti?: string): JwtPayload => ({
    openid: 'o_1',
    nickname: 't',
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...(jti ? { jti } : {}),
});

after(() => {
    (CacheService as unknown as { set: unknown }).set = origSet;
    (CacheService as unknown as { get: unknown }).get = origGet;
    // 关闭真实 Redis 连接：CacheService.ts 模块加载时 redis.ping() 建立的
    // 连接会保活事件循环，导致 tsx --test 进程挂起（仓库惯例，
    // 参见 cacheService.spec.ts / internal.index-quotes.test.ts 的 after hook）
    redis.disconnect();
});

describe('revokeToken', () => {
    it('写入黑名单并返回 persisted=true（Redis 落地）', async () => {
        let setKey = '';
        (CacheService as unknown as { set: unknown }).set = async (key: string): Promise<boolean> => {
            setKey = key;
            return true;
        };
        const payload = payloadOf('jti-1');
        const r = await revokeToken(payload);
        assert.deepStrictEqual(r, { ok: true, persisted: true });
        assert.strictEqual(setKey, `${TOKEN_BLACKLIST_PREFIX}jti-1`);
    });

    it('Redis 未落地（仅内存）→ persisted=false', async () => {
        (CacheService as unknown as { set: unknown }).set = async (): Promise<boolean> => false;
        const r = await revokeToken(payloadOf('jti-2'));
        assert.deepStrictEqual(r, { ok: true, persisted: false });
    });

    it('写异常 → ok=false（调用方据此 500，绝不静默）', async () => {
        (CacheService as unknown as { set: unknown }).set = async (): Promise<boolean> => {
            throw new Error('boom');
        };
        const r = await revokeToken(payloadOf('jti-3'));
        assert.strictEqual(r.ok, false);
    });

    it('无 jti → { ok: false, persisted: false }（调用方走 legacy 分支）', async () => {
        let called = false;
        (CacheService as unknown as { set: unknown }).set = async (): Promise<boolean> => {
            called = true;
            return true;
        };
        const r = await revokeToken(payloadOf());
        assert.deepStrictEqual(r, { ok: false, persisted: false });
        assert.strictEqual(called, false);
    });
});

describe('isTokenRevoked', () => {
    it('黑名单命中 → true', async () => {
        (CacheService as unknown as { get: unknown }).get = async (): Promise<unknown> =>
            ({ openid: 'o_1', revokedAt: Date.now() });
        assert.strictEqual(await isTokenRevoked('jti-hit'), true);
    });

    it('未命中 → false', async () => {
        (CacheService as unknown as { get: unknown }).get = async (): Promise<unknown> => null;
        assert.strictEqual(await isTokenRevoked('jti-miss'), false);
    });

    it('无 jti → false（不做查表）', async () => {
        (CacheService as unknown as { get: unknown }).get = async (): Promise<unknown> => {
            throw new Error('should not be called');
        };
        assert.strictEqual(await isTokenRevoked(undefined), false);
    });

    it('读异常 → fail-open 返回 false 且不抛（WARN 日志非静默）', async () => {
        (CacheService as unknown as { get: unknown }).get = async (): Promise<unknown> => {
            throw new Error('redis down');
        };
        assert.strictEqual(await isTokenRevoked('jti-ex'), false);
    });
});
