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

// 原子自增 + 首次设置 TTL：原实现「先 INCR、count === 1 时再 EXPIRE」两条命令之间存在
// 进程崩溃/被杀的窗口，一旦中断则计数键被创建但无 TTL、计数永不过期 → 该账号永久 429。
// 改为单条 Lua 在 Redis 内原子执行；并额外用 TTL < 0 自愈历史遗留的无 TTL 键。
// 语义保持固定窗口：仅首次（或键无 TTL 时）设过期，后续 INCR 不刷新 TTL。
const INCR_WITH_TTL_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return c
`;

// 仅暴露 eval 的最小客户端接口：使 Redis 集成边界可注入、可单测，避免测试依赖真实 Redis。
export interface ThrottleRedisClient {
    eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export async function redisIncr(
    prefix: string,
    key: string,
    windowSec: number,
    client: ThrottleRedisClient = redis,
): Promise<void> {
    await client.eval(INCR_WITH_TTL_LUA, 1, prefix + key, windowSec);
}

// 频控三原语：登录失败计数与注册频控共用同一套 Redis 优先 / 内存兜底逻辑，
// 仅 prefix、阈值与窗口常量不同；公开函数保持原有名字与签名，只做参数化薄封装。
async function isThrottledFor(prefix: string, max: number, account: string): Promise<boolean> {
    if (redisAvailable) {
        try {
            const raw = await redis.get(prefix + account);
            const count = parseInt(raw ?? '0', 10) || 0;
            return count >= max;
        } catch {
            redisAvailable = false;
        }
    }
    return memoryGet(prefix, account) >= max;
}

async function recordAttempt(prefix: string, key: string, windowSec: number): Promise<void> {
    memoryIncr(prefix, key, windowSec);
    if (redisAvailable) {
        try {
            await redisIncr(prefix, key, windowSec);
        } catch {
            redisAvailable = false;
        }
    }
}

async function clearCount(prefix: string, key: string): Promise<void> {
    memoryFail.delete(prefix + key);
    if (redisAvailable) {
        try {
            await redis.del(prefix + key);
        } catch {
            redisAvailable = false;
        }
    }
}

export async function isThrottled(account: string): Promise<boolean> {
    return isThrottledFor(ACCT_PREFIX, FAIL_MAX, account);
}

export async function recordFailure(account: string): Promise<void> {
    return recordAttempt(ACCT_PREFIX, account, FAIL_WINDOW_SEC);
}

export async function clearAccountFailure(account: string): Promise<void> {
    return clearCount(ACCT_PREFIX, account);
}

// 注册频控（I4b）：独立账号维度计数，与登录失败计数完全隔离，避免首次设密码被误锁导致无法登录。
// 口径：验证码校验通过后才计数（仅已通过身份证明的尝试占用配额；否则任意人可用错验证码请求
// 把他人账号的配额打满，使其无法首次设密码），成功注册后复位。
export const REG_WINDOW_SEC = 900;
export const REG_MAX = 5;

const REG_PREFIX = 'auth:reg:acct:';

export async function isRegisterThrottled(account: string): Promise<boolean> {
    return isThrottledFor(REG_PREFIX, REG_MAX, account);
}

export async function recordRegisterAttempt(account: string): Promise<void> {
    return recordAttempt(REG_PREFIX, account, REG_WINDOW_SEC);
}

export async function clearRegisterCount(account: string): Promise<void> {
    return clearCount(REG_PREFIX, account);
}
