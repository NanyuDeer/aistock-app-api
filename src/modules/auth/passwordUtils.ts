import crypto from 'crypto';

// 密码散列：零依赖 scrypt（格式 scrypt$N$r$p$salt$hash）
// 选 scrypt 而非 bcrypt/argon2，避免新增原生依赖；参数取 Node 默认档位。
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

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
    const n = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    if (!n || !r || !p) return false;

    let salt: Buffer;
    let expected: Buffer;
    try {
        salt = Buffer.from(parts[4], 'base64');
        expected = Buffer.from(parts[5], 'base64');
    } catch {
        return false;
    }
    if (salt.length === 0 || expected.length === 0) return false;

    let actual: Buffer;
    try {
        actual = crypto.scryptSync(password, salt, expected.length, { N: n, r, p });
    } catch {
        return false;
    }
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
}

export function isStrongPassword(password: string): boolean {
    if (typeof password !== 'string' || password.length < 8) return false;
    return /[A-Za-z]/.test(password) && /\d/.test(password);
}
