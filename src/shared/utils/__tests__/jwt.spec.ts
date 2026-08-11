/**
 * JWT 工具单元测试（P0 身份鉴权 — Important 修复回归守卫）
 *
 * 验证 verifyJwt 契约：token 非法/过期 → 返回 null（fail-closed），
 * 对任何畸形输入绝不抛异常（此前签名段长度不匹配会让 crypto.timingSafeEqual
 * 抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH，导致 HTTP 500 / WS 不 close(4401)）。
 *
 * 运行：node --import tsx --test src/shared/utils/__tests__/jwt.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { signJwt, verifyJwt } from '../jwt';

const JWT_SECRET = 'test-jwt-secret';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 手动构造 token（payload 段可为任意字符串，签名按真实 HS256 计算） */
function buildToken(payloadB64: string, secret: string): string {
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

describe('verifyJwt', () => {
  it('合法 token：返回 payload，openid 正确', () => {
    const token = signJwt({ openid: 'o_p0_ok', iat: nowSec(), exp: nowSec() + 3600 }, JWT_SECRET);
    const payload = verifyJwt(token, JWT_SECRET);
    assert.ok(payload, 'expected non-null payload');
    assert.strictEqual(payload.openid, 'o_p0_ok');
  });

  it('错误 secret：返回 null', () => {
    const token = signJwt({ openid: 'o_p0_ok', iat: nowSec(), exp: nowSec() + 3600 }, JWT_SECRET);
    assert.strictEqual(verifyJwt(token, 'wrong-secret'), null);
  });

  it('篡改签名（改最后一个字符）：返回 null', () => {
    const token = signJwt({ openid: 'o_p0_ok', iat: nowSec(), exp: nowSec() + 3600 }, JWT_SECRET);
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    assert.notStrictEqual(tampered, token);
    assert.strictEqual(verifyJwt(tampered, JWT_SECRET), null);
  });

  it('畸形 3 段 token 且签名段过短：返回 null，不抛异常（本修复的回归守卫）', () => {
    // "YWJj" 解码后仅 3 字节，而 HS256 期望签名 32 字节；
    // 修复前 crypto.timingSafeEqual 会抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH。
    assert.doesNotThrow(() => verifyJwt('eyJhbGciOiJIUzI1NiJ9.eyJvcGVuaWQiOiJvX2JhZCJ9.YWJj', JWT_SECRET));
    assert.strictEqual(verifyJwt('eyJhbGciOiJIUzI1NiJ9.eyJvcGVuaWQiOiJvX2JhZCJ9.YWJj', JWT_SECRET), null);
  });

  it('1 段 / 2 段 garbage：返回 null', () => {
    assert.strictEqual(verifyJwt('garbage', JWT_SECRET), null);
    assert.strictEqual(verifyJwt('header.payload', JWT_SECRET), null);
    assert.strictEqual(verifyJwt('', JWT_SECRET), null);
  });

  it('过期 token：返回 null', () => {
    const token = signJwt({ openid: 'o_expired', iat: nowSec() - 7200, exp: nowSec() - 3600 }, JWT_SECRET);
    assert.strictEqual(verifyJwt(token, JWT_SECRET), null);
  });

  it('非 JSON payload：返回 null（签名合法但 payload 解析失败）', () => {
    const payloadB64 = Buffer.from('not-a-json-payload').toString('base64url');
    const token = buildToken(payloadB64, JWT_SECRET);
    assert.strictEqual(verifyJwt(token, JWT_SECRET), null);
  });
});
