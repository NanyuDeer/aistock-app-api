/**
 * 用户画像 controller（Phase 4-3 全局用户记忆）
 *
 * GET/PUT /api/user/profile（JWT 鉴权；openid 即 user_id，P0 已固化）。
 * - GET：无记录 → 空对象 {}（不 404）
 * - PUT：部分更新（仅更新传入字段）；investment_preferences 数组整体替换（G7 修订，
 *   非追加/拼接）；risk_tolerance 限定 conservative | balanced | aggressive；超限 400。
 * "永不 500"：DB 异常返回 500 兜底（错误信息不外泄细节），不抛异常。
 */
import { Request, Response, NextFunction } from 'express';
import pool from '../../core/db';
import { createResponse } from '../../shared/utils/response';
import { verifyJwt } from '../../shared/utils/jwt';
import { isTokenRevoked, REVOKED_MESSAGE, extractTokenFromRequest } from '../../shared/utils/tokenBlacklist';

const RISK_TOLERANCES = ['conservative', 'balanced', 'aggressive'] as const;
const MAX_PREFERENCES = 10;
const MAX_PREFERENCE_LEN = 20;
const MAX_NICKNAME_LEN = 50;

/** 部分更新语义：字段未提供（undefined/null）→ 不更新（COALESCE 保留旧值） */
interface ProfileInput {
    nickname?: string;
    investment_preferences?: string[];
    risk_tolerance?: string;
}

interface ProfileRow {
    user_id: string;
    nickname: string | null;
    investment_preferences: unknown;
    risk_tolerance: string | null;
    updated_at: Date;
}

function toProfile(row: ProfileRow): Record<string, unknown> {
    return {
        user_id: row.user_id,
        nickname: row.nickname ?? null,
        investment_preferences: row.investment_preferences ?? null,
        risk_tolerance: row.risk_tolerance ?? null,
        updated_at: row.updated_at ?? null,
    };
}

export class ProfileController {
    private static log(stage: string, message: string, data?: unknown): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[Profile][${stage}] ${ts} ${message}${detail}`);
    }

    private static async requireAuth(req: Request): Promise<{ ok: true; openid: string } | { ok: false; code: number; message: string }> {
        const token = extractTokenFromRequest(req);
        if (!token) return { ok: false, code: 401, message: '未登录' };
        const payload = verifyJwt(token, process.env.JWT_SECRET!);
        if (!payload) return { ok: false, code: 401, message: 'token 无效或已过期' };
        if (await isTokenRevoked(payload.jti)) return { ok: false, code: 401, message: REVOKED_MESSAGE };
        return { ok: true, openid: payload.openid };
    }

    static async get(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await ProfileController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        try {
            const result = await pool.query<ProfileRow>(
                'SELECT user_id, nickname, investment_preferences, risk_tolerance, updated_at FROM user_profiles WHERE user_id = $1',
                [auth.openid],
            );
            const row = result.rows[0];
            createResponse(res, 200, 'success', row ? toProfile(row) : {});
        } catch (err) {
            ProfileController.log('get', 'DB error', err instanceof Error ? err.message : String(err));
            createResponse(res, 500, '查询用户画像失败');
        }
    }

    static async put(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await ProfileController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        const input: ProfileInput = {};

        // ── 校验（仅校验传入字段；未提供不更新） ──
        if (body.nickname !== undefined) {
            if (typeof body.nickname !== 'string' || body.nickname.trim().length === 0) {
                createResponse(res, 400, 'nickname 必须是非空字符串');
                return;
            }
            if (body.nickname.trim().length > MAX_NICKNAME_LEN) {
                createResponse(res, 400, `nickname 长度不能超过 ${MAX_NICKNAME_LEN} 字`);
                return;
            }
            input.nickname = body.nickname.trim();
        }

        if (body.investment_preferences !== undefined) {
            const prefs = body.investment_preferences;
            if (!Array.isArray(prefs)) {
                createResponse(res, 400, 'investment_preferences 必须是数组');
                return;
            }
            if (prefs.length > MAX_PREFERENCES) {
                createResponse(res, 400, `investment_preferences 最多 ${MAX_PREFERENCES} 项`);
                return;
            }
            for (const item of prefs) {
                if (typeof item !== 'string' || item.trim().length === 0) {
                    createResponse(res, 400, 'investment_preferences 每项必须是非空字符串');
                    return;
                }
                if (item.trim().length > MAX_PREFERENCE_LEN) {
                    createResponse(res, 400, `investment_preferences 每项不能超过 ${MAX_PREFERENCE_LEN} 字`);
                    return;
                }
            }
            input.investment_preferences = prefs.map((p: string) => p.trim());
        }

        if (body.risk_tolerance !== undefined) {
            const rt = body.risk_tolerance;
            if (typeof rt !== 'string' || !(RISK_TOLERANCES as readonly string[]).includes(rt)) {
                createResponse(res, 400, `risk_tolerance 必须是 ${RISK_TOLERANCES.join(' | ')}`);
                return;
            }
            input.risk_tolerance = rt;
        }

        try {
            // upsert：部分更新字段用 COALESCE 保留旧值；investment_preferences 为整体替换
            // （G7：传入数组即覆盖，非 JSONB || 拼接）——空数组 [] 是合法"清空"，COALESCE 对
            // 空数组不触发（JSONB [] 非 NULL）。
            const result = await pool.query<ProfileRow>(
                `INSERT INTO user_profiles (user_id, nickname, investment_preferences, risk_tolerance, updated_at)
                 VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                 ON CONFLICT (user_id) DO UPDATE SET
                    nickname = COALESCE(EXCLUDED.nickname, user_profiles.nickname),
                    investment_preferences = COALESCE(EXCLUDED.investment_preferences, user_profiles.investment_preferences),
                    risk_tolerance = COALESCE(EXCLUDED.risk_tolerance, user_profiles.risk_tolerance),
                    updated_at = CURRENT_TIMESTAMP
                 RETURNING user_id, nickname, investment_preferences, risk_tolerance, updated_at`,
                [auth.openid, input.nickname ?? null, input.investment_preferences ?? null, input.risk_tolerance ?? null],
            );
            const row = result.rows[0];
            ProfileController.log('put', 'profile upserted', { user_id: auth.openid });
            createResponse(res, 200, 'success', row ? toProfile(row) : { user_id: auth.openid });
        } catch (err) {
            ProfileController.log('put', 'DB error', err instanceof Error ? err.message : String(err));
            createResponse(res, 500, '保存用户画像失败');
        }
    }
}
