/**
 * 飞书OAuth授权 + 消息订阅控制器
 *
 * 功能：
 * 1. 飞书OAuth2.0授权回调
 * 2. 用户订阅状态查询/变更
 * 3. 飞书Bot消息推送
 */

import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import { verifyJwt } from '../../shared/utils/jwt';
import pool from '../../core/db';
import axios from 'axios';

// 飞书应用配置
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';
// 前端域名，用于 OAuth 回调后重定向回前端页面（后端域名无前端路由，相对路径 redirect 会造成空白页）
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://gupiao.yaozhineng.com';

// ==================== 数据库Schema ====================

async function ensureSubscriptionSchema(): Promise<void> {
    // 旧表使用 user_id INTEGER REFERENCES users(id)，但 users 表主键是 openid TEXT，
    // 类型不匹配导致外键约束无法生效。检测旧表结构，仅在旧结构存在时 DROP 重建。
    const { rows } = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'user_subscriptions' AND column_name = 'user_id'
    `);
    if (rows.length > 0) {
        // 旧表结构存在（user_id 列），且因认证 bug 历史上从未成功写入数据，安全 drop 重建
        await pool.query(`DROP TABLE IF EXISTS user_subscriptions CASCADE;`);
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_subscriptions (
            id SERIAL PRIMARY KEY,
            user_openid TEXT NOT NULL REFERENCES users(openid) ON DELETE CASCADE,
            feishu_open_id TEXT NOT NULL DEFAULT '',
            feishu_user_id TEXT NOT NULL DEFAULT '',
            feishu_name TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'idle',
            push_times TEXT[] DEFAULT '{"09:00","13:00","19:00"}',
            subscribed_at TIMESTAMPTZ,
            unsubscribed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_openid)
        );
        CREATE INDEX IF NOT EXISTS idx_us_user_openid ON user_subscriptions(user_openid);
        CREATE INDEX IF NOT EXISTS idx_us_feishu_open_id ON user_subscriptions(feishu_open_id);
    `);
}

// ==================== 飞书API调用 ====================

async function getFeishuAppToken(): Promise<string> {
    const res = await axios.post(
        `${FEISHU_BASE_URL}/auth/v3/app_access_token/internal`,
        {
            app_id: FEISHU_APP_ID,
            app_secret: FEISHU_APP_SECRET,
        },
    );
    return res.data?.app_access_token || '';
}

async function getFeishuUserToken(code: string): Promise<any> {
    const appToken = await getFeishuAppToken();
    const res = await axios.post(
        `${FEISHU_BASE_URL}/authen/v1/oidc/access_token`,
        {
            grant_type: 'authorization_code',
            code,
        },
        {
            headers: { Authorization: `Bearer ${appToken}` },
        },
    );
    return res.data?.data;
}

async function getFeishuUserInfo(userAccessToken: string): Promise<any> {
    const res = await axios.get(`${FEISHU_BASE_URL}/authen/v1/user_info`, {
        headers: { Authorization: `Bearer ${userAccessToken}` },
    });
    return res.data?.data;
}

async function sendFeishuMessage(openId: string, msgType: string, content: any): Promise<boolean> {
    try {
        const appToken = await getFeishuAppToken();
        await axios.post(
            `${FEISHU_BASE_URL}/im/v1/messages?receive_id_type=open_id`,
            {
                receive_id: openId,
                msg_type: msgType,
                content: typeof content === 'string' ? content : JSON.stringify(content),
            },
            {
                headers: {
                    Authorization: `Bearer ${appToken}`,
                    'Content-Type': 'application/json',
                },
            },
        );
        return true;
    } catch (err: any) {
        console.error('[FeishuAuth] 发送消息失败:', err?.response?.data || err.message);
        return false;
    }
}

// ==================== 控制器 ====================

export class FeishuAuthController {
    private static async requireAuth(req: Request): Promise<{ ok: true; openid: string } | { ok: false; code: number; message: string }> {
        const cookie = req.headers.cookie || '';
        const tokenMatch = cookie.match(/(?:^|;\s*)token=([^;]+)/);
        if (!tokenMatch) return { ok: false, code: 401, message: '未登录' };
        const token = tokenMatch[1];
        const payload = verifyJwt(token, process.env.JWT_SECRET!);
        if (!payload) return { ok: false, code: 401, message: 'token 无效或已过期' };
        return { ok: true, openid: payload.openid };
    }

    /**
     * GET /api/auth/feishu/callback
     * 飞书OAuth2.0授权回调
     */
    static async oauthCallback(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const redirectPath = req.query.state ? decodeURIComponent(String(req.query.state)) : '/';
        const separator = redirectPath.includes('?') ? '&' : '?';
        // 构建前端绝对 URL，避免后端域名无前端路由造成空白页
        const frontendUrl = (path: string) => `${FRONTEND_BASE_URL}${path}`;

        try {
            const { code } = req.query;
            if (!code) {
                res.redirect(frontendUrl(`${redirectPath}${separator}feishu_bind=failed&reason=no_code`));
                return;
            }

            // 从 Cookie 中认证当前登录用户
            const auth = await FeishuAuthController.requireAuth(req);
            if (!auth.ok) {
                // 会话过期，跳登录页并带 redirect 参数，登录后回到原页面
                const loginRedirect = encodeURIComponent(redirectPath);
                res.redirect(frontendUrl(`/login?feishu_bind=failed&reason=session_expired&redirect=${loginRedirect}`));
                return;
            }
            const openid = auth.openid;

            // 获取用户Token
            const tokenData = await getFeishuUserToken(String(code));
            if (!tokenData?.access_token) {
                console.error('[FeishuAuth] 获取用户token失败:', tokenData);
                res.redirect(frontendUrl(`${redirectPath}${separator}feishu_bind=failed&reason=token_failed`));
                return;
            }

            // 获取用户信息
            const userInfo = await getFeishuUserInfo(tokenData.access_token);
            if (!userInfo?.open_id) {
                console.error('[FeishuAuth] 获取用户信息失败:', userInfo);
                res.redirect(frontendUrl(`${redirectPath}${separator}feishu_bind=failed&reason=userinfo_failed`));
                return;
            }

            // 保存飞书绑定信息
            await ensureSubscriptionSchema();
            await pool.query(
                `INSERT INTO user_subscriptions (user_openid, feishu_open_id, feishu_user_id, feishu_name, status, subscribed_at)
                 VALUES ($1, $2, $3, $4, 'subscribed', NOW())
                 ON CONFLICT (user_openid)
                 DO UPDATE SET feishu_open_id = $2, feishu_user_id = $3, feishu_name = $4, status = 'subscribed', subscribed_at = NOW(), updated_at = NOW()`,
                [openid, userInfo.open_id, userInfo.user_id || '', userInfo.name || ''],
            );

            console.log(`[FeishuAuth] 用户${openid}绑定飞书成功: open_id=${userInfo.open_id}, name=${userInfo.name}`);

            res.redirect(frontendUrl(`${redirectPath}${separator}feishu_bind=success`));
        } catch (err: any) {
            console.error('[FeishuAuth] oauthCallback error:', err.message);
            const feishuData = err?.response?.data;
            const errMsg = String(feishuData?.msg || feishuData?.error || '');
            const errCode = String(feishuData?.code || '');
            // 企业自建应用常见的未加入企业/用户不可见类错误关键词
            const isNotInTenant =
                /不在企业|not in tenant|tenant|用户不可见|user not visible|not in app/i.test(errMsg) ||
                ['20013', '20015', '99991663'].includes(errCode);
            const reason = isNotInTenant ? 'not_in_tenant' : 'server_error';
            res.redirect(frontendUrl(`${redirectPath}${separator}feishu_bind=failed&reason=${reason}`));
        }
    }

    /**
     * GET /api/users/me/subscription
     * 查询当前用户订阅状态
     */
    static async getSubscription(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const auth = await FeishuAuthController.requireAuth(req);
            if (!auth.ok) {
                createResponse(res, auth.code, auth.message);
                return;
            }
            const openid = auth.openid;

            await ensureSubscriptionSchema();
            const result = await pool.query(
                'SELECT status, feishu_open_id, feishu_name, push_times, subscribed_at FROM user_subscriptions WHERE user_openid = $1',
                [openid],
            );

            if (result.rows.length === 0) {
                createResponse(res, 200, 'success', { status: 'idle' });
                return;
            }

            const row = result.rows[0];
            const status = row.status === 'subscribed' && row.feishu_open_id ? 'subscribed' : 'unauthorized';
            createResponse(res, 200, 'success', {
                status,
                feishuName: row.feishu_name,
                pushTimes: row.push_times,
                subscribedAt: row.subscribed_at,
            });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[FeishuAuth] getSubscription error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * POST /api/users/me/subscription
     * 订阅/取消订阅
     */
    static async updateSubscription(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const auth = await FeishuAuthController.requireAuth(req);
            if (!auth.ok) {
                createResponse(res, auth.code, auth.message);
                return;
            }
            const openid = auth.openid;

            const { action } = req.body;
            await ensureSubscriptionSchema();

            if (action === 'subscribe') {
                // 检查是否已绑定飞书
                const existing = await pool.query(
                    'SELECT feishu_open_id FROM user_subscriptions WHERE user_openid = $1',
                    [openid],
                );

                if (existing.rows.length === 0 || !existing.rows[0].feishu_open_id) {
                    createResponse(res, 200, '需要先授权飞书账号', { status: 'unauthorized' });
                    return;
                }

                await pool.query(
                    `UPDATE user_subscriptions SET status = 'subscribed', subscribed_at = NOW(), updated_at = NOW() WHERE user_openid = $1`,
                    [openid],
                );
                createResponse(res, 200, '订阅成功', { status: 'subscribed' });
            } else if (action === 'unsubscribe') {
                await pool.query(
                    `UPDATE user_subscriptions SET status = 'unsubscribed', unsubscribed_at = NOW(), updated_at = NOW() WHERE user_openid = $1`,
                    [openid],
                );
                createResponse(res, 200, '取消订阅成功', { status: 'idle' });
            } else if (action === 'unbind') {
                await pool.query(
                    `UPDATE user_subscriptions SET status = 'unbound', feishu_open_id = '', feishu_user_id = '', feishu_name = '', unsubscribed_at = NOW(), updated_at = NOW() WHERE user_openid = $1`,
                    [openid],
                );
                createResponse(res, 200, '已解除飞书绑定', { status: 'idle' });
            } else {
                createResponse(res, 400, '无效操作');
            }
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[FeishuAuth] updateSubscription error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * POST /api/internal/push-feishu
     * 内部接口：向指定用户推送飞书消息
     */
    static async pushMessage(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const headerToken = req.headers['x-internal-token'];
            const bearerToken = req.headers.authorization?.replace('Bearer ', '');
            const token = String(Array.isArray(headerToken) ? headerToken[0] : headerToken || '') || bearerToken || '';
            if (token !== (process.env.INTERNAL_TOKEN || 'crawler-int-2026-token')) {
                createResponse(res, 401, 'invalid internal token');
                return;
            }

            const { open_id, msg_type, content } = req.body;
            if (!open_id || !msg_type || !content) {
                createResponse(res, 400, '参数不完整');
                return;
            }

            const success = await sendFeishuMessage(open_id, msg_type, content);
            createResponse(res, success ? 200 : 500, success ? 'success' : '推送失败');
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[FeishuAuth] pushMessage error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }
}
