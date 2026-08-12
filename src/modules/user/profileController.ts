/**
 * 用户画像 controller（Phase 4-3 全局用户记忆 + Phase 4 验收修复 B8）
 *
 * GET/PUT/DELETE /api/user/profile（JWT 鉴权；openid 即 user_id，P0 已固化）。
 * - GET：无记录 → 空对象 {}（不 404）
 * - PUT：部分更新（仅更新传入字段）；investment_preferences 数组整体替换（G7 修订，
 *   非追加/拼接）；risk_tolerance 限定 conservative | balanced | aggressive；超限 400。
 * - DELETE：删除 user_profiles 行 + 失效 agent-py 侧画像缓存（db=1，PIPL 删除权）。
 * "永不 500"：DB 异常返回 500 兜底（错误信息不外泄细节）；缓存失效失败仅 warning
 * （TTL 300s 自然过期兜底），不阻断响应。
 */
import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
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

// ── 跨库缓存失效（Phase 4 验收修复 B8）──
// agent-py 侧画像缓存在 `redis://...:6379/1` 的 `user_profile:{userId}`（TTL 300s）；
// app-api 主 redis 连接在 db=2（core/redis.ts），不能 SELECT 污染，故用专用 db=1 短生命周期连接。
const AGENT_CACHE_REDIS_URL = process.env.AGENT_PROFILE_CACHE_REDIS_URL || 'redis://127.0.0.1:6379/1';

/** 可替换的 db=1 连接工厂（单测注入 stub 断言 del 调用；生产默认短生命周期连接）。
 *  注：以对象属性承载而非 `export let` 函数绑定——本仓库 tsx 按 ESM 加载，模块命名空间
 *  只读（tsc TS2632 + 运行时 getter-only），外部对命名导出的赋值均不可行；对象属性在
 *  CJS/ESM 下皆可变，满足 M-4 可注入要求。 */
export const _agentCacheRedisFactory: { current: () => Redis } = {
    current: (): Redis => new Redis(AGENT_CACHE_REDIS_URL, {
        lazyConnect: true, maxRetriesPerRequest: 1,
        connectTimeout: 1500, commandTimeout: 1500,
    }),
};

/** 失效 agent-py 侧 user_profile 缓存（db=1，与 agent-py 生产 REDIS_URL 对齐）。
 *  "永不 500"：失败仅 warning——缓存 TTL 300s 自然过期兜底。 */
export async function delAgentProfileCache(userId: string): Promise<void> {
    const c = _agentCacheRedisFactory.current();
    try {
        await c.connect();
        await c.del(`user_profile:${userId}`);
        ProfileController.log('delCache', 'invalidated', { userId });
    } catch (err) {
        ProfileController.log('delCache', 'failed (TTL 300s 兜底)', err instanceof Error ? err.message : String(err));
    } finally {
        c.disconnect();
    }
}

export class ProfileController {
    // 非 private：delAgentProfileCache（模块级函数）跨库失效日志复用
    static log(stage: string, message: string, data?: unknown): void {
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
                [
                    auth.openid,
                    input.nickname ?? null,
                    // JSONB 参数必须传 JSON 文本（node-postgres 不自动序列化 JS 数组；
                    // undefined → null 保留旧值，[] → "[]" 合法"清空"）
                    input.investment_preferences === undefined
                        ? null
                        : JSON.stringify(input.investment_preferences),
                    input.risk_tolerance ?? null,
                ],
            );
            const row = result.rows[0];
            ProfileController.log('put', 'profile upserted', { user_id: auth.openid });
            // 更新即失效：消除 agent-py 侧 300s 旧画像缓存窗口（B8；失败仅 warning 不阻断 200）
            await delAgentProfileCache(auth.openid);
            createResponse(res, 200, 'success', row ? toProfile(row) : { user_id: auth.openid });
        } catch (err) {
            ProfileController.log('put', 'DB error', err instanceof Error ? err.message : String(err));
            createResponse(res, 500, '保存用户画像失败');
        }
    }

    static async del(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await ProfileController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        try {
            await pool.query('DELETE FROM user_profiles WHERE user_id = $1', [auth.openid]);
            await delAgentProfileCache(auth.openid);
            ProfileController.log('del', 'profile deleted', { user_id: auth.openid });
            createResponse(res, 200, 'success', { deleted: true });
        } catch (err) {
            ProfileController.log('del', 'DB error', err instanceof Error ? err.message : String(err));
            createResponse(res, 500, '删除用户画像失败');
        }
    }
}
