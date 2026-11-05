/**
 * 用户画像自动挖掘（一期）— 公开清理 / 计数接口
 *
 * - GET    /api/user/profile/inferences/meta：JWT；只返回计数与维度名（**不返回 value**）
 * - DELETE /api/user/profile/inferences：JWT；删除该用户全部推断 + DEL 两个 agent-py 缓存 key
 *
 * 鉴权复用 ProfileController.requireAuth 的既有模式（JWT + 撤销黑名单）。
 * 「永不阻断」：缓存失效失败仅 warning（TTL 300s 兜底）；DB 异常 500 兜底。
 */
import { Request, Response, NextFunction } from 'express';
import pool from '../../core/db';
import { createResponse } from '../../shared/utils/response';
import { verifyJwt } from '../../shared/utils/jwt';
import { isTokenRevoked, REVOKED_MESSAGE, extractTokenFromRequest } from '../../shared/utils/tokenBlacklist';
import { delAgentInferenceCache, delAgentProfileCache } from '../user/profileController';
import { ProfileMiningService } from './ProfileMiningService';

interface MetaRow {
    count: number | string;
    dimensions: string[] | null;
    updated_at: Date | string | null;
}

export class ProfileMiningController {
    private static log(stage: string, message: string, data?: unknown): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[ProfileMining][${stage}] ${ts} ${message}${detail}`);
    }

    private static async requireAuth(req: Request): Promise<{ ok: true; openid: string } | { ok: false; code: number; message: string }> {
        const token = extractTokenFromRequest(req);
        if (!token) return { ok: false, code: 401, message: '未登录' };
        const payload = verifyJwt(token, process.env.JWT_SECRET!);
        if (!payload) return { ok: false, code: 401, message: 'token 无效或已过期' };
        if (await isTokenRevoked(payload.jti)) return { ok: false, code: 401, message: REVOKED_MESSAGE };
        return { ok: true, openid: payload.openid };
    }

    /** 只返回计数与维度名（隐私：不向用户展示推断内容，spec §3.8）。 */
    static async meta(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await ProfileMiningController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        try {
            const result = await pool.query<MetaRow>(
                `SELECT COUNT(*)::int AS count,
                        COALESCE(array_agg(dimension ORDER BY dimension), '{}'::text[]) AS dimensions,
                        MAX(updated_at) AS updated_at
                 FROM user_profile_inferences
                 WHERE user_id = $1`,
                [auth.openid],
            );
            const row = result.rows[0];
            createResponse(res, 200, 'success', {
                count: Number(row?.count ?? 0),
                dimensions: Array.isArray(row?.dimensions) ? row.dimensions : [],
                updated_at: row?.updated_at ?? null,
            });
        } catch (err) {
            ProfileMiningController.log('meta', 'DB error', err instanceof Error ? err.message : String(err));
            createResponse(res, 500, '查询推断画像失败');
        }
    }

    /** 清除该用户全部推断；显式画像不受影响。 */
    static async clear(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await ProfileMiningController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        try {
            const deleted = await ProfileMiningService.deleteInferences(auth.openid);
            // 推断变化会影响「显式 + 推断」合并上下文 → 两个缓存 key 一并失效（spec §3.6）
            await delAgentProfileCache(auth.openid);
            await delAgentInferenceCache(auth.openid);
            ProfileMiningController.log('clear', 'inferences deleted', { user_id: auth.openid, deleted });
            createResponse(res, 200, 'success', { deleted });
        } catch (err) {
            ProfileMiningController.log('clear', 'DB error', err instanceof Error ? err.message : String(err));
            createResponse(res, 500, '清除推断画像失败');
        }
    }
}
