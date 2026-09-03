/**
 * 短信验证码存储（Redis 优先 + 本地内存兜底，与 CacheService 双写策略一致）
 *
 * 验证码 key：`sms:code:{phone}`，TTL 5 分钟，单次消费（getdel 防重放）；
 * 限流 key：`sms:rate:{phone}`，60s 窗口内同号最多 RATE_MAX 次发送请求。
 * Redis 不可用时降级内存 Map（本地开发/降级模式），进程重启即失效，可接受。
 */
import redis from '../../core/redis';

let redisAvailable = false;
redis.ping().then(() => { redisAvailable = true; }).catch(() => { redisAvailable = false; });
redis.on('connect', () => { redisAvailable = true; });
redis.on('error', () => { redisAvailable = false; });

const PREFIX = 'sms:code:';
const TTL = 300; // 5 分钟
const RATE_PREFIX = 'sms:rate:';
const RATE_MAX = 3;
const RATE_WINDOW = 60;
const SENT_PREFIX = 'sms:sent:';
/** 与阿里云 SendSmsVerifyCode Interval 对齐：同号同场景 60s 内最多 1 条（biz.FREQUENCY 频控源） */
const SENT_TTL = 60;

// 本地内存兜底（Redis 不可用）
const memoryCodes = new Map<string, { code: string; expiresAt: number }>();
const memoryRates = new Map<string, { count: number; windowStart: number }>();
const memorySent = new Map<string, number>();

/** 写入验证码（覆盖写，TTL 5 分钟；Redis + 本地双写） */
export async function setCode(phone: string, code: string): Promise<void> {
    if (redisAvailable) {
        try {
            await redis.set(`${PREFIX}${phone}`, code, 'EX', TTL);
        } catch {
            // 降级本地
        }
    }
    memoryCodes.set(phone, { code, expiresAt: Date.now() + TTL * 1000 });
}

/** 消费验证码：匹配则删除并返回 true（单次消费防重放），否则 false */
export async function consumeCode(phone: string, code: string): Promise<boolean> {
    const key = `${PREFIX}${phone}`;
    if (redisAvailable) {
        try {
            // getdel（Redis>=6.2）原子取删；不可用时退回 get→del
            let stored: string | null = null;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const client: any = redis;
            if (typeof client.getdel === 'function') {
                stored = (await client.getdel(key)) as string | null;
            } else {
                stored = await redis.get(key);
                if (stored) await redis.del(key);
            }
            if (stored) {
                memoryCodes.delete(phone);
                return stored === code;
            }
        } catch {
            // 降级本地
        }
    }
    const local = memoryCodes.get(phone);
    if (local && local.expiresAt > Date.now()) {
        memoryCodes.delete(phone);
        return local.code === code;
    }
    memoryCodes.delete(phone);
    return false;
}

/** 限流检查：60s 窗口内同号发送次数超过 RATE_MAX 返回 true */
export async function isRateLimited(phone: string): Promise<boolean> {
    if (redisAvailable) {
        try {
            const key = `${RATE_PREFIX}${phone}`;
            const count = await redis.incr(key);
            if (count === 1) await redis.expire(key, RATE_WINDOW);
            if (count > RATE_MAX) return true;
        } catch {
            // 降级本地
        }
    }
    const now = Date.now();
    const local = memoryRates.get(phone);
    if (local && local.windowStart + RATE_WINDOW * 1000 > now) {
        local.count += 1;
        if (local.count > RATE_MAX) return true;
    } else {
        memoryRates.set(phone, { count: 1, windowStart: now });
    }
    return false;
}

/** 生成 6 位数字验证码 */
export function generateSmsCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/** 记录某手机号刚成功下发过验证码（TTL 60s；Redis + 本地双写） */
export async function setSentAt(phone: string): Promise<void> {
    if (redisAvailable) {
        try {
            await redis.set(`${SENT_PREFIX}${phone}`, String(Date.now()), 'EX', SENT_TTL);
        } catch {
            // 降级本地
        }
    }
    memorySent.set(phone, Date.now());
}

/** 60s 内是否已成功下发过（命中则本地直接 429，避免请求打到阿里云被 biz.FREQUENCY 拦截） */
export async function isSentLimited(phone: string): Promise<boolean> {
    if (redisAvailable) {
        try {
            const v = await redis.get(`${SENT_PREFIX}${phone}`);
            if (v) return true;
        } catch {
            // 降级本地
        }
    }
    const t = memorySent.get(phone);
    if (t && Date.now() - t < SENT_TTL * 1000) return true;
    if (t) memorySent.delete(phone); // 过期清理
    return false;
}

/** 中国大陆手机号格式校验 */
export function isValidMainlandPhone(phone: string): boolean {
    return /^1[3-9]\d{9}$/.test(phone);
}
