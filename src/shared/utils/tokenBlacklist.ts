/**
 * token 黑名单工具（token-revocation Step 2，2026-08-11）
 *
 * 黑名单键 `token_blacklist:{jti}`，值 `{ openid, revokedAt }`，TTL = token 剩余寿命。
 * 复用 CacheService 双写（Redis + 本地 Map），不引入新表（spec §5.1）。
 *
 * 降级语义（spec §5.3）：
 * - 读侧 fail-open：黑名单只含"被撤销的凭证"，读失败不影响合法用户 → 返回 false；
 *   但绝不静默（硬约束 1）——读异常记 WARN。
 * - 写侧 never-silent：revokeToken 返回 { ok, persisted }，由调用方决定 200/degraded/500。
 */
import type { Request } from 'express';
import { CacheService, TOKEN_BLACKLIST_PREFIX } from './CacheService';
import type { JwtPayload } from './jwt';

const MAX_BLACKLIST_TTL_SECONDS = 7 * 24 * 3600;

export interface RevokeResult {
    ok: boolean;
    /** Redis 持久写是否落地（false = 仅内存生效，进程重启后失效） */
    persisted: boolean;
}

export interface BlacklistEntry {
    openid: string;
    revokedAt: number;
}

export const REVOKED_MESSAGE = '凭证已失效，请重新登录';

/**
 * 撤销单个凭证：写黑名单，TTL = token 剩余寿命（clamp [1, 7 天]）。
 * 无 jti（在途旧 token）→ { ok: false, persisted: false }，调用方走 legacy 分支（不拒绝）。
 */
export async function revokeToken(payload: JwtPayload): Promise<RevokeResult> {
    if (!payload.jti) return { ok: false, persisted: false };
    const remaining = Math.floor(payload.exp - Date.now() / 1000);
    const ttl = Math.min(MAX_BLACKLIST_TTL_SECONDS, Math.max(1, remaining));
    const entry: BlacklistEntry = { openid: payload.openid, revokedAt: Date.now() };
    try {
        const persisted = await CacheService.set(TOKEN_BLACKLIST_PREFIX + payload.jti, entry, ttl);
        return { ok: true, persisted };
    } catch (err) {
        // 写异常（理论不可达：CacheService.put 内部已 catch）——防御性记录，绝不静默
        console.warn('[tokenBlacklist] revokeToken failed jti=%s: %s', payload.jti, String(err));
        return { ok: false, persisted: false };
    }
}

/**
 * 查询凭证是否已撤销。读侧 fail-open（spec §5.3）：
 * 无 jti / 未命中 / 读异常 → false；读异常记 WARN（非静默）后放行。
 */
export async function isTokenRevoked(jti?: string): Promise<boolean> {
    if (!jti) return false;
    try {
        const entry = await CacheService.get<BlacklistEntry>(TOKEN_BLACKLIST_PREFIX + jti);
        return entry !== null;
    } catch (err) {
        // CacheService.get 内部吞异常走本地 Map，此处为防御性兜底
        console.warn('[tokenBlacklist] isTokenRevoked read failed jti=%s, fail-open: %s', jti, String(err));
        return false;
    }
}

/**
 * 从请求提取 JWT（Bearer 优先、Cookie token= 兜底）。
 * 与各模块 requireAuth 的提取逻辑对齐（spec §5.2.1：logout 与 requireAuth 同源）。
 */
export function extractTokenFromRequest(req: Request): string | undefined {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7).trim() || undefined;
    }
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/(?:^|;\s*)token=([^;]+)/);
    return match ? match[1] : undefined;
}
