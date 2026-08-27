import { Request, Response, NextFunction } from 'express';
import { signJwt, verifyJwt } from '../../shared/utils/jwt';
import { createResponse } from '../../shared/utils/response';
import { extractTokenFromRequest, revokeToken } from '../../shared/utils/tokenBlacklist';
import pool from '../../core/db';
// 注意：微信 API 调用必须使用原生 fetch，不能用 sessionFetch（自定义 https.Agent keepAlive），
// 否则微信服务器会返回 HTTP 412 Precondition Failed。详见 project_memory.md。

export class AuthController {
    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[Auth][${stage}] ${ts} ${message}${detail}`);
    }

    static async login(req: Request, res: Response, _next: NextFunction): Promise<void> {
        AuthController.log('login', '收到登录请求', { url: req.url });

        const appid = process.env.WECHAT_APPID;
        if (!appid) {
            AuthController.log('login', '缺少 WECHAT_APPID 环境变量');
            createResponse(res, 500, '服务端未配置 WECHAT_APPID');
            return;
        }

        const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/wechat/callback`;
        const state = req.query.redirect as string || '/';

        const authUrl =
            'https://open.weixin.qq.com/connect/oauth2/authorize' +
            `?appid=${appid}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&response_type=code` +
            `&scope=snsapi_userinfo` +
            `&state=${encodeURIComponent(state)}` +
            `#wechat_redirect`;

        AuthController.log('login', '302 跳转微信授权', { appid, redirectUri, state });
        res.redirect(302, authUrl);
    }

    static async callback(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const code = req.query.code as string;
        const state = (req.query.state as string) || '/';

        AuthController.log('callback', '收到微信回调', { code: code ? `${code.slice(0, 8)}...` : null, state });

        if (!code) {
            createResponse(res, 400, '缺少 code 参数');
            return;
        }

        try {
            AuthController.log('callback', '① 开始用 code 换取 access_token');
            const tokenData = await AuthController.exchangeCodeForToken(code);
            if (tokenData.errcode) {
                AuthController.log('callback', '❌ 换取 access_token 失败', { errcode: tokenData.errcode, errmsg: tokenData.errmsg });
                createResponse(res, 400, `微信授权失败: ${tokenData.errmsg}`);
                return;
            }

            const { access_token, openid } = tokenData;
            AuthController.log('callback', '✅ 换取 access_token 成功', { openid });

            AuthController.log('callback', '② 开始拉取用户信息', { openid });
            const userInfo = await AuthController.fetchWechatUserInfo(access_token, openid);
            const nickname = userInfo.nickname || '';
            const avatarUrl = userInfo.headimgurl || '';
            AuthController.log('callback', '✅ 用户信息获取成功', { openid, nickname });

            AuthController.log('callback', '③ 写入用户表（UPSERT）', { openid, nickname });
            const id = await AuthController.upsertUser(openid, nickname, avatarUrl);
            AuthController.log('callback', '✅ 写入成功', { id });

            const now = Math.floor(Date.now() / 1000);
            const exp = now + 7 * 24 * 3600;
            AuthController.log('callback', '④ 签发 JWT', { id, openid, iat: now, exp });
            const jwt = signJwt({ id, openid, nickname, iat: now, exp }, process.env.JWT_SECRET!);
            AuthController.log('callback', '✅ JWT 签发成功');

            const frontendUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
            const redirectTo = state.startsWith('http') ? state : `${frontendUrl}${state}`;
            AuthController.log('callback', '⑤ 登录完成，302 跳转', { redirectTo });

            const cookieParts = [
                `token=${jwt}`,
                'Path=/',
                'HttpOnly',
                'Secure',
                'SameSite=Lax',
                `Max-Age=${7 * 24 * 3600}`,
            ];
            if (process.env.COOKIE_DOMAIN) {
                cookieParts.push(`Domain=${process.env.COOKIE_DOMAIN}`);
            }

            res.setHeader('Set-Cookie', cookieParts.join('; '));
            res.redirect(302, redirectTo);
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            AuthController.log('callback', '❌ 登录流程异常', { error: errMsg });
            createResponse(res, 500, `微信登录失败: ${errMsg}`);
        }
    }

    static async logout(req: Request, res: Response, _next: NextFunction): Promise<void> {
        AuthController.log('logout', '收到登出请求');

        // token-revocation §5.2.1：token 来源与 requireAuth 对齐（Bearer 优先、Cookie 兜底），
        // 不复用旧版"只删 Cookie"逻辑——App 端 Authorization 登出必须同等地撤销凭证。
        const token = extractTokenFromRequest(req);

        let data: Record<string, unknown> | null = null;
        if (token) {
            const payload = verifyJwt(token, process.env.JWT_SECRET!);
            if (payload) {
                if (payload.jti) {
                    // 有效凭证：按 jti 写黑名单。写侧 never-silent（spec §5.3）：
                    const revoke = await revokeToken(payload);
                    if (!revoke.ok) {
                        // 内存写也失败（理论不可达）→ 显式 500，绝不静默（硬约束 2）
                        AuthController.log('logout', '撤销未落地，返回 500', { openid: payload.openid });
                        AuthController.setLogoutCookie(res);
                        createResponse(res, 500, '登出未完成，撤销未落地', null);
                        return;
                    }
                    if (!revoke.persisted) {
                        // 已撤销但未持久化（仅内存生效，进程重启后失效）→ 显式告知
                        AuthController.log('logout', '撤销仅内存生效（Redis 不可用）', { openid: payload.openid });
                        data = { degraded: true };
                    } else {
                        AuthController.log('logout', '撤销成功', { openid: payload.openid });
                    }
                } else {
                    // 在途旧 token（无 jti）：不拒绝，WARN + legacy 提示（硬约束 3）
                    console.warn(
                        `[Auth][logout] legacy token 无 jti，撤销跳过：openid=${payload.openid}，` +
                        '旧凭证将于到期前仍可被使用，建议重新登录一次以获得可撤销凭证'
                    );
                    data = { legacy: true };
                }
            } else {
                // token 无效/过期 → 幂等登出：不写黑名单（拒绝登出只会把用户锁在僵局，安全零增益）
                AuthController.log('logout', 'token 无效/已过期，幂等登出（不写黑名单）');
            }
        } else {
            AuthController.log('logout', '无 token，幂等登出（不写黑名单）');
        }

        AuthController.setLogoutCookie(res);
        createResponse(res, 200, 'success', data);
    }

    private static setLogoutCookie(res: Response): void {
        const cookieParts = [
            'token=deleted', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax',
            'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        ];
        if (process.env.COOKIE_DOMAIN) cookieParts.push(`Domain=${process.env.COOKIE_DOMAIN}`);
        res.setHeader('Set-Cookie', cookieParts.join('; '));
    }

    /**
     * App 端微信登录（uni.login → code → 换取用户信息 → 签发 JWT）
     * 与网页 OAuth callback 不同，这里返回 JSON 而非 302 跳转。
     */
    static async appWxLogin(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const code = req.body?.code as string;

        AuthController.log('appWxLogin', '收到 App 微信登录请求', { code: code ? `${code.slice(0, 8)}...` : null });

        if (!code) {
            createResponse(res, 400, '缺少 code 参数');
            return;
        }

        try {
            // ① 用 code 换取 access_token + openid
            AuthController.log('appWxLogin', '① 用 code 换取 access_token');
            const tokenData = await AuthController.exchangeCodeForToken(code);
            if (tokenData.errcode) {
                AuthController.log('appWxLogin', '❌ 换取 access_token 失败', { errcode: tokenData.errcode, errmsg: tokenData.errmsg });
                createResponse(res, 400, `微信授权失败: ${tokenData.errmsg}`);
                return;
            }

            const { access_token, openid } = tokenData;
            AuthController.log('appWxLogin', '✅ 换取成功', { openid });

            // ② 拉取用户信息（昵称、头像）
            AuthController.log('appWxLogin', '② 拉取用户信息');
            const userInfo = await AuthController.fetchWechatUserInfo(access_token, openid);
            const nickname = userInfo.nickname || '';
            const avatarUrl = userInfo.headimgurl || '';
            AuthController.log('appWxLogin', '✅ 用户信息', { openid, nickname: nickname || '(空)' });

            // ③ 写入用户表（UPSERT），返回不可变主键 id 用于签发 JWT
            AuthController.log('appWxLogin', '③ 写入用户表');
            const id = await AuthController.upsertUser(openid, nickname, avatarUrl);

            // ④ 签发 JWT（payload 携带 id 统一账户主键 + openid 兼容旧关联）
            const now = Math.floor(Date.now() / 1000);
            const exp = now + 7 * 24 * 3600;
            const jwt = signJwt({ id, openid, nickname, iat: now, exp }, process.env.JWT_SECRET!);
            AuthController.log('appWxLogin', '✅ JWT 签发成功', { id });

            // ⑤ 返回 token + 用户信息（前端存储 token，后续请求用 Authorization 头）
            createResponse(res, 200, 'success', {
                token: jwt,
                userInfo: {
                    openid,
                    nickname,
                    avatar: avatarUrl,
                },
            });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            AuthController.log('appWxLogin', '❌ 登录流程异常', { error: errMsg });
            createResponse(res, 500, `微信登录失败: ${errMsg}`);
        }
    }

    static async exchangeCodeForToken(code: string): Promise<any> {
        const res = await fetch(
            `https://api.weixin.qq.com/sns/oauth2/access_token` +
            `?appid=${process.env.WECHAT_APPID}` +
            `&secret=${process.env.WECHAT_SECRET}` +
            `&code=${code}` +
            `&grant_type=authorization_code`,
        );
        return res.json();
    }

    static async fetchWechatUserInfo(accessToken: string, openid: string): Promise<any> {
        const res = await fetch(
            `https://api.weixin.qq.com/sns/userinfo` +
            `?access_token=${accessToken}` +
            `&openid=${openid}` +
            `&lang=zh_CN`,
        );
        return res.json();
    }

    /** UPSERT 微信用户并返回不可变主键 id（统一账户模型：openid 为可空唯一索引） */
    private static async upsertUser(openid: string, nickname: string, avatarUrl: string): Promise<string> {
        const result = await pool.query(
            `INSERT INTO users (id, openid, nickname, avatar_url)
             VALUES (gen_random_uuid(), $1, $2, $3)
             ON CONFLICT(openid) DO UPDATE SET
                 nickname = EXCLUDED.nickname,
                 avatar_url = EXCLUDED.avatar_url
             RETURNING id`,
            [openid, nickname, avatarUrl],
        );
        return result.rows[0].id as string;
    }
}
