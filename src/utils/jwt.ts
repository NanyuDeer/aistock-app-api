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
    openid: string;
    nickname?: string;
    iat: number;
    exp: number;
}

export function signJwt(payload: JwtPayload, secret: string): string {
    const header = { alg: 'HS256', typ: 'JWT' };
    const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
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
    const actualSig = base64UrlDecode(signatureB64);

    if (!crypto.timingSafeEqual(expectedSig, actualSig)) return null;

    try {
        const payload: JwtPayload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
        if (payload.exp && Date.now() / 1000 > payload.exp) return null;
        return payload;
    } catch {
        return null;
    }
}
