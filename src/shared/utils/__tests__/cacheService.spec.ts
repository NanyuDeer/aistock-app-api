/**
 * CacheService 前置改造测试（token-revocation Task 1，2026-08-11）
 *
 * 1. put 返回 boolean：Redis 持久写落地 → true；不可用/写失败（仅本地）→ false
 * 2. 黑名单键（token_blacklist: 前缀）豁免 LOCAL_CACHE_MAX_SIZE 通用淘汰
 *
 * Mock strategy: 经 __cacheServiceDependencies 测试注入点（仓库 __xxxDependencies
 * 惯例）控制 redisAvailable 与直接操作 localCache，不依赖真实 Redis。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CacheService, TOKEN_BLACKLIST_PREFIX, __cacheServiceDependencies } from '../CacheService';
import redis from '../../../core/redis';

const deps = __cacheServiceDependencies;
const savedRedisSet = (redis as unknown as { set: unknown }).set;

before(() => {
    // 清空本地缓存，保证用例独立
    deps.getLocalCache().clear();
    // 桩掉 redis.set：测试不触达真实 Redis
    (redis as unknown as { set: (...args: unknown[]) => Promise<unknown> }).set = async () => 'OK';
});

after(() => {
    (redis as unknown as { set: unknown }).set = savedRedisSet;
    deps.getLocalCache().clear();
    // 关闭真实 Redis 连接，避免事件循环被保活导致测试进程挂起（仓库惯例，
    // 参见 internal.index-quotes.test.ts 的 after hook）
    redis.disconnect();
});

describe('CacheService.put 返回持久写落地状态', () => {
    it('Redis 可用且 set 成功 → 返回 true', async () => {
        deps.setRedisAvailable(true);
        const ok = await CacheService.put('k1', { a: 1 }, 60);
        assert.strictEqual(ok, true);
    });

    it('Redis 不可用（仅本地 Map）→ 返回 false', async () => {
        deps.setRedisAvailable(false);
        const ok = await CacheService.put('k2', { a: 2 }, 60);
        assert.strictEqual(ok, false);
    });

    it('Redis 写失败（异常 fallthrough 本地）→ 返回 false 且本地仍可读', async () => {
        deps.setRedisAvailable(true);
        (redis as unknown as { set: (...args: unknown[]) => Promise<unknown> }).set = async () => {
            throw new Error('redis down');
        };
        const ok = await CacheService.put('k3', { a: 3 }, 60);
        assert.strictEqual(ok, false);
        // 直接断言本地 Map（不调 CacheService.get：有真实 Redis 的开发机上
        // redis.get 返回 null 且 get() 不 fallthrough 到本地，避免环境依赖）
        const local = deps.getLocalCache().get('k3');
        assert.deepStrictEqual(local && local.value, { a: 3 });
    });

    it('set/refresh 与 put 返回值一致', async () => {
        deps.setRedisAvailable(true);
        // 恢复成功桩（上一用例把 redis.set 桩成抛异常，此处需自包含）
        (redis as unknown as { set: (...args: unknown[]) => Promise<unknown> }).set = async () => 'OK';
        assert.strictEqual(await CacheService.set('k4', 1, 60), true);
        assert.strictEqual(await CacheService.refresh('k4', 1, 60), true);
    });
});

describe('黑名单键豁免通用淘汰', () => {
    it('超 LOCAL_CACHE_MAX_SIZE 时淘汰普通键、保留 token_blacklist: 前缀键', () => {
        deps.setRedisAvailable(false);
        deps.getLocalCache().clear();
        // 5000 个普通键 + 1 个黑名单键（黑名单键 TTL 未到，属"不应被淘汰"）
        for (let i = 0; i < 5000; i++) {
            deps.getLocalCache().set(`normal:${i}`, { value: i, expiresAt: Date.now() + 100_000 });
        }
        deps.getLocalCache().set(`${TOKEN_BLACKLIST_PREFIX}abc`, { value: 'x', expiresAt: Date.now() + 100_000 });
        deps.runCleanupLocalCache();
        // 淘汰后黑名单键仍存在
        assert.ok(deps.getLocalCache().has(`${TOKEN_BLACKLIST_PREFIX}abc`));
        // 普通键被淘汰（5000 个键 + 黑名单豁免 → 超出 5000 上限的部分被移除）
        assert.ok(deps.getLocalCache().size <= 5000);
    });
});
