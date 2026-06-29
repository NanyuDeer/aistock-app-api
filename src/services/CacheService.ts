import redis from '../redis';

let redisAvailable = false;

// 检测Redis是否可用
redis.ping().then(() => { redisAvailable = true; }).catch(() => { redisAvailable = false; });
redis.on('connect', () => { redisAvailable = true; });
redis.on('error', () => { redisAvailable = false; });

export class CacheService {
    static async get<T>(key: string): Promise<T | null> {
        if (!redisAvailable) return null;
        try {
            const raw = await redis.get(key);
            if (!raw) return null;
            try { return JSON.parse(raw) as T; } catch { return null; }
        } catch { return null; }
    }

    static async put<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
        if (!redisAvailable) return;
        if (!Number.isFinite(ttlSeconds)) throw new Error(`Invalid TTL for key ${key}: ${ttlSeconds}`);
        const normalizedTtlSeconds = Math.max(60, Math.floor(ttlSeconds));
        try {
            await redis.set(key, JSON.stringify(value), 'EX', normalizedTtlSeconds);
        } catch { /* Redis不可用时静默跳过 */ }
    }

    static async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
        await CacheService.put(key, value, ttlSeconds);
    }

    static async refresh<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
        await CacheService.put(key, value, ttlSeconds);
    }

    static async del(key: string): Promise<void> {
        if (!redisAvailable) return;
        try { await redis.del(key); } catch { /* ignore */ }
    }
}
