import redis from '../../core/redis';

let redisAvailable = false;

// 检测Redis是否可用
redis.ping().then(() => { redisAvailable = true; }).catch(() => { redisAvailable = false; });
redis.on('connect', () => { redisAvailable = true; });
redis.on('error', () => { redisAvailable = false; });

// 本地内存缓存（Redis 不可用时的降级方案）
const localCache = new Map<string, { value: any; expiresAt: number }>();

// 本地缓存最大条目数，防止内存无限增长
const LOCAL_CACHE_MAX_SIZE = 5000;

function cleanupLocalCache(): void {
    const now = Date.now();
    // 先清理过期条目
    for (const [key, entry] of localCache.entries()) {
        if (entry.expiresAt < now) {
            localCache.delete(key);
        }
    }
    // 如果仍然超过上限，按过期时间排序淘汰最早的
    if (localCache.size > LOCAL_CACHE_MAX_SIZE) {
        const entries = [...localCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
        const toRemove = localCache.size - LOCAL_CACHE_MAX_SIZE;
        for (let i = 0; i < toRemove && i < entries.length; i++) {
            localCache.delete(entries[i][0]);
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

    static async put<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
        const normalizedTtlSeconds = Math.max(60, Math.floor(ttlSeconds));
        // Redis 优先
        if (redisAvailable) {
            try {
                await redis.set(key, JSON.stringify(value), 'EX', normalizedTtlSeconds);
            } catch { /* fallthrough to local cache */ }
        }
        // 同时写入本地内存缓存（作为降级备份）
        localCache.set(key, {
            value,
            expiresAt: Date.now() + normalizedTtlSeconds * 1000,
        });
    }

    static async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
        await CacheService.put(key, value, ttlSeconds);
    }

    static async refresh<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
        await CacheService.put(key, value, ttlSeconds);
    }

    static async del(key: string): Promise<void> {
        if (redisAvailable) {
            try { await redis.del(key); } catch { /* ignore */ }
        }
        localCache.delete(key);
    }
}
