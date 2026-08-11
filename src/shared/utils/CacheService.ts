import redis from '../../core/redis';

let redisAvailable = false;

// 检测Redis是否可用
redis.ping().then(() => { redisAvailable = true; }).catch(() => {
    // token-revocation 硬约束 1（spec §1.3）：redis 不可用时显式声明黑名单降级，
    // 绝不允许"自以为已关闭的缺口"静默存在（spec §5.3 第 3 级：进程重启 → Map 丢失 →
    // 黑名单临时为空 → 启动时 WARN 显式声明 + 此后进入 fail-open）。
    console.warn(
        '[CacheService] Redis 不可用：缓存降级为内存 Map；token 黑名单仅内存生效，' +
        '进程重启后未持久化撤销将失效，请人工核验。'
    );
    redisAvailable = false;
});
redis.on('connect', () => { redisAvailable = true; });
redis.on('error', () => { redisAvailable = false; });

// 本地内存缓存（Redis 不可用时的降级方案）
const localCache = new Map<string, { value: any; expiresAt: number }>();

// 本地缓存最大条目数，防止内存无限增长
const LOCAL_CACHE_MAX_SIZE = 5000;

/** token 黑名单键前缀（token-revocation §5.1；豁免通用淘汰，仅 TTL 自然过期）。 */
export const TOKEN_BLACKLIST_PREFIX = 'token_blacklist:';

function cleanupLocalCache(): void {
    const now = Date.now();
    // 先清理过期条目（黑名单键按 TTL 自然过期，此路径正常生效）
    for (const [key, entry] of localCache.entries()) {
        if (entry.expiresAt < now) {
            localCache.delete(key);
        }
    }
    // 如果仍然超过上限，按过期时间排序淘汰最早的；
    // token-revocation §5.1：黑名单键豁免通用淘汰——撤销条目若在 TTL 前被
    // 静默移除 = "撤销复活"，必须封堵（spec §5.3 第 4 级）。
    if (localCache.size > LOCAL_CACHE_MAX_SIZE) {
        const candidates = [...localCache.entries()]
            .filter(([key]) => !key.startsWith(TOKEN_BLACKLIST_PREFIX))
            .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
        const toRemove = localCache.size - LOCAL_CACHE_MAX_SIZE;
        for (let i = 0; i < toRemove && i < candidates.length; i++) {
            localCache.delete(candidates[i][0]);
        }
    }
}

// 每分钟清理过期缓存
// unref() 确保此定时器不会阻止 Node.js 进程退出（测试环境 / 进程关闭时）
setInterval(cleanupLocalCache, 60_000).unref();

export class CacheService {
    static async get<T>(key: string): Promise<T | null> {
        // Redis 优先
        if (redisAvailable) {
            try {
                const raw = await redis.get(key);
                if (!raw) return null;
                try { return JSON.parse(raw) as T; } catch { return null; }
            } catch { /* fallthrough to local cache */ }
        }
        // 降级到本地内存缓存
        const local = localCache.get(key);
        if (local && local.expiresAt > Date.now()) {
            return local.value as T;
        }
        localCache.delete(key);
        return null;
    }

    /**
     * 写缓存（Redis + 本地双写）。返回 Redis 持久写是否落地（token-revocation §5.2 前置：
     * 写侧 never-silent 的实现前提——调用方需区分"已持久化撤销"与"仅内存生效"）。
     * 对存量调用方零破坏：返回值从 void 扩为 boolean，取不取用都兼容。
     */
    static async put<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
        const normalizedTtlSeconds = Math.max(60, Math.floor(ttlSeconds));
        let redisLanded = false;
        // Redis 优先
        if (redisAvailable) {
            try {
                await redis.set(key, JSON.stringify(value), 'EX', normalizedTtlSeconds);
                redisLanded = true;
            } catch {
                console.warn(`[CacheService] redis.set failed key=${key}（降级本地 Map，返回值 false）`);
                /* fallthrough to local cache */
            }
        }
        // 同时写入本地内存缓存（作为降级备份）
        localCache.set(key, {
            value,
            expiresAt: Date.now() + normalizedTtlSeconds * 1000,
        });
        return redisLanded;
    }

    static async set<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
        return CacheService.put(key, value, ttlSeconds);
    }

    static async refresh<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
        return CacheService.put(key, value, ttlSeconds);
    }

    static async del(key: string): Promise<void> {
        if (redisAvailable) {
            try { await redis.del(key); } catch { /* ignore */ }
        }
        localCache.delete(key);
    }
}

/** 测试注入点（仓库 __xxxDependencies 惯例，仅测试用；生产零调用）。 */
export const __cacheServiceDependencies = {
    setRedisAvailable: (v: boolean): void => { redisAvailable = v; },
    getLocalCache: (): Map<string, { value: unknown; expiresAt: number }> => localCache,
    runCleanupLocalCache: (): void => cleanupLocalCache(),
};
