import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import { verifyJwt } from '../../shared/utils/jwt';
import { isTokenRevoked, REVOKED_MESSAGE } from '../../shared/utils/tokenBlacklist';
import pool from '../../core/db';

/**
 * Chat token 用量公开端点（P10 线 2）。
 *
 * 静态方法模式，仿 UserController（私有 requireAuth + createResponse 包装）。
 * 计费身份契约：JWT payload 的 openid 即计费 user_id（与 ws.py 入口解析的
 * raw_user_id 一致；前端 WS 改传 openid 由计划 D 完成）。
 */
export class UsageController {
    private static async requireAuth(
        req: Request,
    ): Promise<{ ok: true; openid: string } | { ok: false; code: number; message: string }> {
        // 优先 Authorization: Bearer <token>（App/H5 标准方式）
        let token: string | undefined;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.slice(7);
        }
        // Fallback: Cookie token（兼容旧版 Web 端）
        if (!token) {
            const cookie = req.headers.cookie || '';
            const tokenMatch = cookie.match(/(?:^|;\s*)token=([^;]+)/);
            if (tokenMatch) token = tokenMatch[1];
        }
        if (!token) return { ok: false, code: 401, message: '未登录' };
        const payload = verifyJwt(token, process.env.JWT_SECRET!);
        if (!payload) return { ok: false, code: 401, message: 'token 无效或已过期' };
        // token-revocation Step 2：验签通过后查黑名单（读侧 fail-open，命中即拒绝）
        if (await isTokenRevoked(payload.jti)) return { ok: false, code: 401, message: REVOKED_MESSAGE };
        return { ok: true, openid: payload.openid };
    }

    static async summary(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await UsageController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }

        try {
            const result = await pool.query(
                `SELECT
                    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COUNT(*) AS turn_count
                 FROM chat_token_usage
                 WHERE user_id = $1`,
                [auth.openid]
            );
            const row = result.rows[0] ?? {};
            createResponse(res, 200, 'success', {
                prompt_tokens: Number(row.prompt_tokens ?? 0),
                completion_tokens: Number(row.completion_tokens ?? 0),
                total_tokens: Number(row.total_tokens ?? 0),
                turn_count: Number(row.turn_count ?? 0),
            });
        } catch (err: unknown) {
            console.error('[Usage] summary error:', err instanceof Error ? err.message : String(err));
            createResponse(res, 500, err instanceof Error ? err.message : String(err));
        }
    }
}
