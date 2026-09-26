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

// 内存兜底 Map 的容量上限（I2）：随机账号洪泛时条目无界增长会持续占用内存
export const MEMORY_MAX_ENTRIES = 10000;

const memoryFail = new Map<string, { count: number; expireAt: number }>();

// 惰性清扫：仅当条目数超过上限时执行（摊薄成本，且不引入常驻 setInterval 定时器）
function sweepMemory(now: number): void {
    for (const [key, entry] of memoryFail) {
        if (entry.expireAt <= now) memoryFail.delete(key);
    }
    if (memoryFail.size <= MEMORY_MAX_ENTRIES) return;
    // 仍超上限：按 expireAt 升序（最旧先淘汰）删除至上限
    const overflow = memoryFail.size - MEMORY_MAX_ENTRIES;
    const ordered = [...memoryFail.entries()].sort((a, b) => a[1].expireAt - b[1].expireAt);
    for (let i = 0; i < overflow; i += 1) {
        memoryFail.delete(ordered[i][0]);
    }
}

function memoryIncr(prefix: string, key: string, windowSec: number): void {
    const now = Date.now();
    const mapKey = prefix + key;
    const entry = memoryFail.get(mapKey);
    if (!entry || entry.expireAt <= now) {
        memoryFail.set(mapKey, { count: 1, expireAt: now + windowSec * 1000 });
    } else {
        entry.count += 1;
    }
    if (memoryFail.size > MEMORY_MAX_ENTRIES) sweepMemory(now);
}

function memoryGet(prefix: string, key: string): number {
    const now = Date.now();
    const entry = memoryFail.get(prefix + key);
    if (!entry || entry.expireAt <= now) return 0;
    return entry.count;
}

async function redisIncr(prefix: string, key: string, windowSec: number): Promise<void> {
    const fullKey = prefix + key;
    const count = await redis.incr(fullKey);
    if (count === 1) await redis.expire(fullKey, windowSec);
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
    memoryIncr(ACCT_PREFIX, account, FAIL_WINDOW_SEC);
    if (redisAvailable) {
        try {
            await redisIncr(ACCT_PREFIX, account, FAIL_WINDOW_SEC);
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

// 注册频控（I4b）：独立账号维度计数，与登录失败计数完全隔离，避免首次设密码被误锁导致无法登录。
// 口径：进入处理即计数（防刷注册接口本身），成功注册后复位。
export const REG_WINDOW_SEC = 900;
export const REG_MAX = 5;

const REG_PREFIX = 'auth:reg:acct:';

export async function isRegisterThrottled(account: string): Promise<boolean> {
    if (redisAvailable) {
        try {
            const raw = await redis.get(REG_PREFIX + account);
            const count = parseInt(raw ?? '0', 10) || 0;
            return count >= REG_MAX;
        } catch {
            redisAvailable = false;
        }
    }
    return memoryGet(REG_PREFIX, account) >= REG_MAX;
}

export async function recordRegisterAttempt(account: string): Promise<void> {
    memoryIncr(REG_PREFIX, account, REG_WINDOW_SEC);
    if (redisAvailable) {
        try {
            await redisIncr(REG_PREFIX, account, REG_WINDOW_SEC);
        } catch {
            redisAvailable = false;
        }
    }
}

export async function clearRegisterCount(account: string): Promise<void> {
    memoryFail.delete(REG_PREFIX + account);
    if (redisAvailable) {
        try {
            await redis.del(REG_PREFIX + account);
        } catch {
            redisAvailable = false;
        }
    }
}
