/**
 * 高成本接口登录守卫中间件（安全加固，2026-09-16）
 *
 * 背景：app-api 曾以 0.0.0.0 公网直连暴露，OCR(OpenAI 视觉)/个股中长线分析(QWEN LLM)/
 * 批量刷新等高成本接口在 index.ts 无任何鉴权，外部可白嫖烧钱。本中间件为此类路由补齐
 * "需登录"守卫（纵深防御第二层；网络层已由 HOST=127.0.0.1 收回 loopback）。
 *
 * 放行策略（二选一，避免破坏既有内部调用方）：
 *  1. 有效用户 JWT（Bearer / Cookie token=）→ 校验签名 + 未撤销（复用 tokenBlacklist）
 *  2. X-Internal-Token 与 env INTERNAL_API_TOKEN|INTERNAL_TOKEN 匹配 → 放行（内部 cron/Python agent 用）
 * 两者都不满足 → 401（未登录 / token 无效 / 已撤销 / 非法内部 token）。
 *
 * 对齐现有 pattern：profileController.requireAuth 的 extract→verifyJwt→isTokenRevoked 三步，
 * 此处抽为 Express 中间件一次性挂在多个路由，避免各 controller 重复实现。
 */

import type { NextFunction, Request, Response } from 'express';
import { verifyJwt, type JwtPayload } from './jwt';
import {
    extractTokenFromRequest,
    isTokenRevoked,
    REVOKED_MESSAGE,
} from './tokenBlacklist';

/** 已通过鉴权时注入到 req 的 payload（供下游读取 openid 等） */
export interface AuthedRequest extends Request {
    user?: JwtPayload;
}

/** 与 core/routes/internal.ts 对齐的内部 token 解析（先 INTERNAL_API_TOKEN 后 INTERNAL_TOKEN） */
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

/**
 * 校验请求携带的内部 token（header X-Internal-Token）。
 * 有 token 且匹配 → true；header 缺失或值不同 → false（不因 header 缺失报错）。
 */
function hasValidInternalToken(req: Request): boolean {
    const token = req.headers['x-internal-token'];
    return typeof token === 'string' && token === INTERNAL_TOKEN;
}

/**
 * Express 登录守卫。通过 req.user 注入 payload 后调用 next()；否则 401。
 * 内部调用方可携带 X-Internal-Token 放行（保持既有 cron/Python 依赖零改动）。
 */
export function requireLogin(req: Request, res: Response, next: NextFunction): void {
    // 内部 token（cron/Python agent）优先放行
    if (hasValidInternalToken(req)) {
        next();
        return;
    }
    // 用户 JWT：extract → verify → revoked
    const token = extractTokenFromRequest(req);
    if (!token) {
        res.status(401).json({ code: 401, message: '未登录' });
        return;
    }
    const payload = verifyJwt(token, process.env.JWT_SECRET!);
    if (!payload) {
        res.status(401).json({ code: 401, message: 'token 无效或已过期' });
        return;
    }
    isTokenRevoked(payload.jti)
        .then((revoked) => {
            if (revoked) {
                res.status(401).json({ code: 401, message: REVOKED_MESSAGE });
                return;
            }
            // 注入 payload（下游可读 req.user?.openid / id）
            (req as AuthedRequest).user = payload;
            next();
        })
        .catch(() => {
            // 读侧 fail-open（对齐 tokenBlacklist 语义）：黑名单查询异常视为未撤销，放行。
            // 高成本接口仍有签名校验兜底，不放行伪造 token。
            (req as AuthedRequest).user = payload;
            next();
        });
}