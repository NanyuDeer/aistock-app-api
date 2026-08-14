import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import { verifyJwt } from '../../shared/utils/jwt';
import { isTokenRevoked, REVOKED_MESSAGE } from '../../shared/utils/tokenBlacklist';
import pool from '../../core/db';

/**
 * Chat 会话维度 token 用量公开端点（P10 线 4）。
 *
 * 静态方法模式，仿 UserController（私有 requireAuth + createResponse 包装）与
 * 计划 B 的 UsageController。只读聚合 chat_token_usage（session_id 由计划 B 的
 * ws.py 每轮写入），LEFT JOIN chat_sessions 补标题。
 *
 * 身份契约：JWT payload 的 openid 即计费 user_id（与 ws.py 入口解析的
 * raw_user_id 一致；前端 WS 已由计划 D 修正为 openid）。
 */
export class SessionUsageController {
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

    /**
     * GET /api/chat/usage/sessions — 会话维度用量聚合（按 last_used_at DESC）。
     * chat_token_usage 按 session_id 聚合（仅 session_id 非空的记录），
     * LEFT JOIN chat_sessions（按 id + 归属双条件）补标题，JOIN 不到标题为空串。
     */
    static async listBySessions(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await SessionUsageController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const { openid } = auth;

        try {
            const result = await pool.query(
                `SELECT
                    u.session_id,
                    u.turn_count,
                    u.total_tokens,
                    u.last_used_at,
                    COALESCE(s.title, '') AS title
                 FROM (
                    SELECT
                        session_id,
                        COUNT(*)::int AS turn_count,
                        SUM(total_tokens)::bigint AS total_tokens,
                        MAX(created_at) AS last_used_at
                    FROM chat_token_usage
                    WHERE user_id = $1 AND session_id IS NOT NULL
                    GROUP BY session_id
                 ) u
                 LEFT JOIN chat_sessions s ON s.id = u.session_id AND s.user_id = $1
                 ORDER BY last_used_at DESC`,
                [openid]
            );
            const items = result.rows.map((row: Record<string, unknown>) => ({
                session_id: row.session_id,
                title: row.title ?? '',
                total_tokens: Number(row.total_tokens ?? 0),
                turn_count: Number(row.turn_count ?? 0),
                last_used_at: row.last_used_at ?? null,
            }));
            createResponse(res, 200, 'success', { items });
        } catch (err: unknown) {
            console.error('[SessionUsage] listBySessions error:', err instanceof Error ? err.message : String(err));
            createResponse(res, 500, err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * GET /api/chat/usage/sessions/:id — 单会话最近 20 条用量记录。
     * 归属校验 WHERE user_id = $1 AND session_id = $2（防越权查他人会话）。
     */
    static async detailBySession(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await SessionUsageController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const { openid } = auth;
        const sessionId = String(req.params.id || '').trim();
        if (!sessionId) {
            createResponse(res, 400, 'session_id 必填');
            return;
        }

        try {
            const result = await pool.query(
                `SELECT prompt_tokens, completion_tokens, total_tokens, question, created_at
                 FROM chat_token_usage
                 WHERE user_id = $1 AND session_id = $2
                 ORDER BY created_at DESC
                 LIMIT 20`,
                [openid, sessionId]
            );
            const items = result.rows.map((row: Record<string, unknown>) => ({
                prompt_tokens: Number(row.prompt_tokens ?? 0),
                completion_tokens: Number(row.completion_tokens ?? 0),
                total_tokens: Number(row.total_tokens ?? 0),
                question: row.question ?? null,
                created_at: row.created_at ?? null,
            }));
            createResponse(res, 200, 'success', { session_id: sessionId, items });
        } catch (err: unknown) {
            console.error('[SessionUsage] detailBySession error:', err instanceof Error ? err.message : String(err));
            createResponse(res, 500, err instanceof Error ? err.message : String(err));
        }
    }
}
