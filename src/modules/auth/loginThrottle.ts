import redis from '../../core/redis';

// 登录失败计数（登录防刷，2026-09-26；2026-09-26 修订：仅账号维度，避免共享出口 NAT 误伤）
// 结构对齐 core/sms/smsCodeStore：Redis 优先，不可用时降级内存 Map。
export const FAIL_WINDOW_SEC = 900;
export const FAIL_MAX = 10;

const ACCT_PREFIX = 'auth:pwfail:acct:';

let redisAvailable = false;

redis
    .ping()
    .then(() => {
        redisAvailable = true;
    })
    .catch(() => {
        redisAvailable = false;
    });
redis.on('connect', () => {
    redisAvailable = true;
});
redis.on('error', () => {
    redisAvailable = false;
});

const memoryFail = new Map<string, { count: number; expireAt: number }>();

function memoryIncr(prefix: string, key: string): void {
    const now = Date.now();
    const mapKey = prefix + key;
    const entry = memoryFail.get(mapKey);
    if (!entry || entry.expireAt <= now) {
        memoryFail.set(mapKey, { count: 1, expireAt: now + FAIL_WINDOW_SEC * 1000 });
        return;
    }
    entry.count += 1;
}

function memoryGet(prefix: string, key: string): number {
    const now = Date.now();
    const entry = memoryFail.get(prefix + key);
    if (!entry || entry.expireAt <= now) return 0;
    return entry.count;
}

async function redisIncr(prefix: string, key: string): Promise<void> {
    const fullKey = prefix + key;
    const count = await redis.incr(fullKey);
    if (count === 1) await redis.expire(fullKey, FAIL_WINDOW_SEC);
}

export async function isThrottled(account: string): Promise<boolean> {
    if (redisAvailable) {
        try {
            const acctRaw = await redis.get(ACCT_PREFIX + account);
            const acct = parseInt(acctRaw ?? '0', 10) || 0;
            return acct >= FAIL_MAX;
        } catch {
            redisAvailable = false;
        }
    }
    return memoryGet(ACCT_PREFIX, account) >= FAIL_MAX;
}

export async function recordFailure(account: string): Promise<void> {
    memoryIncr(ACCT_PREFIX, account);
    if (redisAvailable) {
        try {
            await redisIncr(ACCT_PREFIX, account);
        } catch {
            redisAvailable = false;
        }
    }
}

export async function clearAccountFailure(account: string): Promise<void> {
    memoryFail.delete(ACCT_PREFIX + account);
    if (redisAvailable) {
        try {
            await redis.del(ACCT_PREFIX + account);
        } catch {
            redisAvailable = false;
        }
    }
}
