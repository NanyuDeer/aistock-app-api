import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import pool from '../../core/db';

/**
 * 「分享到微信再授权」OAuth 桥接控制器
 *
 * 背景：App 端使用测试号/服务号 APPID（非开放平台移动应用）时无法原生拉微信，
 * 故采用「App 生成 state → 分享 H5 授权链接到微信 → 用户在微信内完成网页授权 →
 * H5 把 token 按 state 回传后端 → App 轮询领取 token」的桥接方案。
 *
 * 复用 scan_login_states 表（state/openid/jwt/expires_at 字段契合），
 * 与 ScanLoginController 保持一致的内存 Map fallback（本地降级模式，无 PostgreSQL 时可用）。
 */
export class OAuthBridgeController {
    // 内存 fallback：PostgreSQL 不可用时（本地降级模式）用 Map 存储 state
    private static memoryStates = new Map<string, {
        status: 'pending' | 'confirmed';
        openid?: string;
        jwt?: string;
        expiresAt: Date;
    }>();

    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[OAuthBridge][${stage}] ${ts} ${message}${detail}`);
    }

    private static cleanExpiredMemory(): void {
        const now = new Date();
        for (const [state, record] of OAuthBridgeController.memoryStates) {
            if (record.expiresAt < now) {
                OAuthBridgeController.memoryStates.delete(state);
            }
        }
    }

    /**
     * H5 网页授权成功后调用：把按 state 换取到的 token/用户回传到后端，
     * App 端通过 /oauth/result 轮询领取。
     */
    static async storeOauthResult(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const state = req.body?.state as string | undefined;
        const token = req.body?.token as string | undefined;
        const openid = req.body?.openid as string | undefined;

        OAuthBridgeController.log('store', '收到 OAuth 结果回传', { state, openid, hasToken: !!token });

        if (!state || !token || !openid) {
            OAuthBridgeController.log('store', '参数缺失', { state, hasToken: !!token, hasOpenid: !!openid });
            createResponse(res, 400, '缺少 state / token / openid 参数');
            return;
        }

        const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
        try {
            await pool.query(
                `INSERT INTO scan_login_states (state, status, openid, jwt, expires_at)
                 VALUES ($1, 'confirmed', $2, $3, $4)
                 ON CONFLICT(state) DO UPDATE SET
                     status = 'confirmed',
                     openid = EXCLUDED.openid,
                     jwt = EXCLUDED.jwt,
                     expires_at = EXCLUDED.expires_at`,
                [state, openid, token, expiresAt.toISOString()],
            );
        } catch (dbErr) {
            // 数据库不可用（本地降级模式），用内存 Map 存储
            OAuthBridgeController.log('store', '⚠️ 数据库不可用，使用内存 Map 存储 state', { state });
            OAuthBridgeController.memoryStates.set(state, { status: 'confirmed', openid, jwt: token, expiresAt });
        }

        OAuthBridgeController.log('store', '✅ state 已落库', { state });
        createResponse(res, 200, 'success', { ok: true });
    }

    /**
     * App 端轮询：按 state 返回当前登录结果。
     * - pending   → 用户在微信内尚未完成授权
     * - confirmed → 返回 token（App 直接存储登录）
     * - expired   → state 不存在或已过期
     */
    static async getOauthResult(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const state = req.query.state as string;

        OAuthBridgeController.log('result', '收到轮询请求', { state });

        if (!state) {
            createResponse(res, 400, '缺少 state 参数');
            return;
        }

        OAuthBridgeController.cleanExpiredMemory();

        let record: any = null;
        try {
            const result = await pool.query(
                `SELECT status, openid, jwt, expires_at FROM scan_login_states WHERE state = $1`,
                [state],
            );
            record = result.rows[0];
        } catch (dbErr) {
            // 数据库不可用时（本地降级模式），从内存 Map 查询
            OAuthBridgeController.log('result', '⚠️ 数据库不可用，从内存 Map 查询', { state });
            const memRecord = OAuthBridgeController.memoryStates.get(state);
            if (memRecord) {
                record = {
                    status: memRecord.status,
                    openid: memRecord.openid,
                    jwt: memRecord.jwt,
                    expires_at: memRecord.expiresAt,
                };
            }
        }

        // state 尚不存在（用户还未在微信中打开链接）→ 视为 pending 等待
        if (!record) {
            createResponse(res, 200, 'pending', { status: 'pending' });
            return;
        }

        if (record.status === 'confirmed') {
            // 已确认但过期 → 视为 expired，App 需重新生成链接
            if (new Date(record.expires_at).getTime() < Date.now()) {
                OAuthBridgeController.log('result', 'state 已过期', { state });
                createResponse(res, 200, 'expired', { status: 'expired' });
                return;
            }
            OAuthBridgeController.log('result', '✅ 登录已确认，返回 token', { state, openid: record.openid });
            createResponse(res, 200, 'confirmed', {
                status: 'confirmed',
                openid: record.openid,
                token: record.jwt,
                timestamp: new Date().toISOString(),
            });
            return;
        }

        createResponse(res, 200, 'pending', { status: 'pending' });
    }
}