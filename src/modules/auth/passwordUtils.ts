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

export function hashPassword(password: string): string {
    const salt = crypto.randomBytes(SALT_BYTES);
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
    });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
    if (!stored) return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    // 严格十进制，拒绝 parseInt 会放过的 `16384x`、` 16384 ` 等非规范串
    if (!/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])) return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
    // N 必须是 2 的幂且有上界，避免巨大 N 导致 scryptSync 申请 GB 级内存
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
        actual = crypto.scryptSync(password, salt, expected.length, { N: n, r, p });
    } catch {
        return false;
    }
    return crypto.timingSafeEqual(actual, expected);
}

export function isStrongPassword(password: string): boolean {
    if (typeof password !== 'string' || password.length < 8) return false;
    return /[A-Za-z]/.test(password) && /\d/.test(password);
}
