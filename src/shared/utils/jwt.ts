import crypto from 'crypto';

function base64UrlEncode(buffer: Buffer): string {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Buffer {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad = str.length % 4;
    if (pad) str += '='.repeat(4 - pad);
    return Buffer.from(str, 'base64');
}

export interface JwtPayload {
    /** 账户唯一主键（UUID，统一账户模型）。手机号登录/微信登录签发处必填；旧 token 无此字段 */
    id?: string;
    /** 微信 openid。手机号账户签空串 ''（保持下游 string 类型零改动，见设计 §3 兼容约束） */
    openid: string;
    nickname?: string;
    iat: number;
    exp: number;
    /** token-revocation Step 1：单个凭证锚点（撤销按 jti 粒度，非 openid 级）。旧 token 无此字段。 */
    jti?: string;
}

export function signJwt(payload: JwtPayload, secret: string): string {
    const header = { alg: 'HS256', typ: 'JWT' };
    // token-revocation Step 1：自动生成 jti（UUID），为撤销提供锚点；
    // 显式传入的 jti 优先（测试/未来多钥场景需要）。
    const finalPayload: JwtPayload = { ...payload, jti: payload.jti ?? crypto.randomUUID() };
    const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(finalPayload)));
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = crypto.createHmac('sha256', secret).update(signingInput).digest();
    return `${signingInput}.${base64UrlEncode(signature)}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const signingInput = `${headerB64}.${payloadB64}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(signingInput).digest();
    // 畸形签名段解码后长度可能与 expectedSig 不一致；timingSafeEqual 会因此抛异常。
    // 解码异常或长度不等时按无效 token 处理，避免非法 token 导致接口返回 500。
    let actualSig: Buffer;
    try {
        actualSig = base64UrlDecode(signatureB64);
    } catch {
        return null;
    }
    if (actualSig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(expectedSig, actualSig)) return null;

    try {
        const payload: JwtPayload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
        if (payload.exp && Date.now() / 1000 > payload.exp) return null;
        return payload;
    } catch {
        return null;
    }
}
