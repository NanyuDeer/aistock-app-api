/**
 * 统一登录态解析（用户画像自动挖掘一期收尾去重，2026-11-05）
 *
 * 背景：各 controller 曾各自实现 `private static requireAuth`（extract →
 * verifyJwt → isTokenRevoked 三步），全仓存在 8 份几乎一致的副本。副本分开
 * 演化时，新增一条校验规则漏改一处就是鉴权缺口。本文件抽出唯一实现，供
 * `modules/user/profileController` 与 `modules/profile-mining/ProfileMiningController`
 * 共用；其余模块（auth/chat/monitor 等）行为不动，可后续逐步迁移。
 *
 * 与 `requireLogin.ts` 的区别（避免混用）：
 * - `requireLogin` 是 Express 中间件：自己写 401 响应，且**放行 X-Internal-Token**
 *   （给 cron / Python agent 用），适合高成本接口的粗粒度守卫。
 * - `resolveAuth` 只解析、不响应，把结果交给调用方决定怎么回包，且**不放行内部
 *   token**——用户级接口不应被内部 token 冒充成某个用户。
 */

import type { Request } from 'express';
import { verifyJwt } from './jwt';
import { extractTokenFromRequest, isTokenRevoked, REVOKED_MESSAGE } from './tokenBlacklist';

export type AuthResult =
    | { ok: true; openid: string }
    | { ok: false; code: number; message: string };

/**
 * 解析请求登录态，返回 openid 或失败原因（不直接写响应）。
 *
 * 三步与 `requireLogin` 中间件同源：提取 token（Bearer 优先、Cookie token= 兜底）
 * → 校验签名 → 校验是否已撤销（logout 后立即失效）。
 */
export async function resolveAuth(req: Request): Promise<AuthResult> {
    const token = extractTokenFromRequest(req);
    if (!token) return { ok: false, code: 401, message: '未登录' };
    const payload = verifyJwt(token, process.env.JWT_SECRET!);
    if (!payload) return { ok: false, code: 401, message: 'token 无效或已过期' };
    if (await isTokenRevoked(payload.jti)) return { ok: false, code: 401, message: REVOKED_MESSAGE };
    return { ok: true, openid: payload.openid };
}
