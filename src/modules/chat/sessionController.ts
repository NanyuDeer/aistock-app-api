import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import { verifyJwt } from '../../shared/utils/jwt';
import pool from '../../core/db';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class SessionController {
    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[ChatSession][${stage}] ${ts} ${message}${detail}`);
    }

    /** 复用 UserController 的鉴权模式：Authorization Bearer JWT → openid（Cookie 兜底） */
    private static async requireAuth(req: Request): Promise<{ ok: true; openid: string } | { ok: false; code: number; message: string }> {
        let token: string | undefined;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.slice(7);
        }
        // Fallback: 从 Cookie 读取（兼容旧版 Web 端）
        if (!token) {
            const cookie = req.headers.cookie || '';
            const tokenMatch = cookie.match(/(?:^|;\s*)token=([^;]+)/);
            if (tokenMatch) token = tokenMatch[1];
        }
        if (!token) return { ok: false, code: 401, message: '未登录' };
        const payload = verifyJwt(token, process.env.JWT_SECRET!);
        if (!payload) return { ok: false, code: 401, message: 'token 无效或已过期' };
        return { ok: true, openid: payload.openid };
    }

    /**
     * POST /api/chat/sessions — 幂等 upsert 会话元数据。
     * 首次 INSERT：title 取 question 前 30 字（截断），空则 '新会话'；
     * 冲突分支（同 id 再次上报）只刷新 last_message_at，不改 title、不改归属。
     */
    static async upsert(req: Request, res: Response, _next: NextFunction): Promise<void> {
        SessionController.log('upsert', '收到会话 upsert 请求');

        const auth = await SessionController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const { openid } = auth;

        const sessionId = String(req.body?.session_id || '').trim();
        if (!SESSION_ID_RE.test(sessionId)) {
            createResponse(res, 400, 'session_id 必填，仅支持字母/数字/_/-，长度 1-64');
            return;
        }

        const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
        const title = question.slice(0, 30) || '新会话';

        const result = await pool.query(
            `INSERT INTO chat_sessions (id, user_id, title, last_message_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (id) DO UPDATE SET last_message_at = CURRENT_TIMESTAMP
             WHERE chat_sessions.user_id = EXCLUDED.user_id
             RETURNING id, title, last_message_at`,
            [sessionId, openid, title],
        );
        const row = result.rows[0];

        SessionController.log('upsert', '✅ 完成', { openid, session_id: row.id });
        createResponse(res, 200, 'success', {
            session_id: row.id,
            title: row.title,
            last_message_at: row.last_message_at,
        });
    }

    /** GET /api/chat/sessions — 当前用户最近 50 个会话（last_message_at DESC） */
    static async list(req: Request, res: Response, _next: NextFunction): Promise<void> {
        SessionController.log('list', '收到会话列表请求');

        const auth = await SessionController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const { openid } = auth;

        const result = await pool.query(
            `SELECT id, title, last_message_at, created_at
             FROM chat_sessions
             WHERE user_id = $1
             ORDER BY last_message_at DESC
             LIMIT 50`,
            [openid],
        );

        createResponse(res, 200, 'success', result.rows.map((row: any) => ({
            session_id: row.id,
            title: row.title,
            last_message_at: row.last_message_at,
            created_at: row.created_at,
        })));
    }

    /** DELETE /api/chat/sessions/:id — 删除会话（id + 归属双条件，防越权删他人会话） */
    static async remove(req: Request, res: Response, _next: NextFunction): Promise<void> {
        SessionController.log('remove', '收到会话删除请求');

        const auth = await SessionController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const { openid } = auth;

        const sessionId = String(req.params.id || '').trim();
        if (!SESSION_ID_RE.test(sessionId)) {
            createResponse(res, 400, 'session_id 仅支持字母/数字/_/-，长度 1-64');
            return;
        }

        await pool.query(
            'DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2',
            [sessionId, openid],
        );

        SessionController.log('remove', '✅ 完成', { openid, session_id: sessionId });
        createResponse(res, 200, 'success');
    }
}
