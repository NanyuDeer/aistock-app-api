import crypto from 'crypto';

// 密码散列：零依赖 scrypt（格式 scrypt$N$r$p$salt$hash）
// 选 scrypt 而非 bcrypt/argon2，避免新增原生依赖；参数取 Node 默认档位。
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
// 校验时的成本参数上界，防止被篡改的存储串引发 CPU/内存放大
const SCRYPT_MAX_N = 32768;
const SCRYPT_MAX_R = 16;
const SCRYPT_MAX_P = 4;
const SCRYPT_MAX_KEYLEN = 128;

// B：scrypt 是 CPU 密集操作（单次数十毫秒），同步版 scryptSync 会阻塞事件循环，
// 使随机账号洪泛可让整个进程失去响应。改用线程池版 crypto.scrypt，并用信号量把「在途」
// 任务限制在 MAX_CONCURRENT_SCRYPT（对齐 libuv 默认线程池大小）；超出部分排队等待而非拒绝。
export const MAX_CONCURRENT_SCRYPT = 4;

type ScryptParams = { N: number; r: number; p: number };

let activeScrypt = 0;
const scryptWaiters: Array<() => void> = [];

function acquireScryptSlot(): Promise<void> {
    if (activeScrypt < MAX_CONCURRENT_SCRYPT) {
        activeScrypt += 1;
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        scryptWaiters.push(resolve);
    });
}

function releaseScryptSlot(): void {
    const next = scryptWaiters.shift();
    if (next) {
        // 有等待者：额度直接移交（activeScrypt 保持不变）
        next();
        return;
    }
    activeScrypt -= 1;
}

async function scryptAsync(password: string, salt: Buffer, keylen: number, params: ScryptParams): Promise<Buffer> {
    await acquireScryptSlot();
    try {
        return await new Promise<Buffer>((resolve, reject) => {
            crypto.scrypt(password, salt, keylen, params, (err, derivedKey) => {
                if (err) reject(err);
                else resolve(derivedKey);
            });
        });
    } finally {
        releaseScryptSlot();
    }
}

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(SALT_BYTES);
    const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
    if (!stored) return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    // 严格十进制，拒绝 parseInt 会放过的 `16384x`、` 16384 ` 等非规范串
    if (!/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])) return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
    // N 必须是 2 的幂且有上界，避免巨大 N 导致 scrypt 申请 GB 级内存
    if (n < 2 || n > SCRYPT_MAX_N || (n & (n - 1)) !== 0) return false;
    if (r < 1 || r > SCRYPT_MAX_R || p < 1 || p > SCRYPT_MAX_P) return false;

    let salt: Buffer;
    let expected: Buffer;
    try {
        salt = Buffer.from(parts[4], 'base64');
        expected = Buffer.from(parts[5], 'base64');
    } catch {
        return false;
    }
    if (salt.length === 0 || expected.length === 0) return false;
    if (expected.length > SCRYPT_MAX_KEYLEN) return false;

    let actual: Buffer;
    try {
        // keylen 取自存储串的散列长度，故返回长度必然相等，无需再做长度比较
        actual = await scryptAsync(password, salt, expected.length, { N: n, r, p });
    } catch {
        return false;
    }
    return crypto.timingSafeEqual(actual, expected);
}

// I1：恒定成本校验。
// verifyPassword 在 stored 为空时零成本返回 false，使「账号不存在 / 未设密码」与「密码错误」
// 在响应耗时上可区分，与「登录失败口径统一、不暴露账号存在性」的目标矛盾。
// 本函数对空 stored 也执行一次同参数 scrypt 以抹平耗时；verifyPassword 自身语义不变。
// dummy 用模块级固定随机盐：scrypt 成本只取决于 N/r/p/keylen，与盐/口令取值无关，
// 故无需（异步化后也无法）在加载期构造完整 dummy 散列。
const DUMMY_SALT = crypto.randomBytes(SALT_BYTES);

export async function verifyPasswordConstantTime(password: string, stored: string | null): Promise<boolean> {
    if (!stored) {
        // 对 dummy 盐执行等价成本 scrypt，结果丢弃，仅用于对齐耗时
        try {
            await scryptAsync(password, DUMMY_SALT, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
        } catch {
            // 极端输入（如超长 password）导致 scrypt 抛错时同样按失败处理
        }
        return false;
    }
    return verifyPassword(password, stored);
}

// I3：密码长度上限，阻断超长输入进入 scrypt 造成 CPU/内存放大（128 位足以覆盖任何正常口令）
export const MAX_PASSWORD_LENGTH = 128;

export function isStrongPassword(password: string): boolean {
    if (typeof password !== 'string' || password.length < 8) return false;
    if (password.length > MAX_PASSWORD_LENGTH) return false;
    return /[A-Za-z]/.test(password) && /\d/.test(password);
}
