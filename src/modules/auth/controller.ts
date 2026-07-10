import { Request, Response, NextFunction } from 'express';
import { signJwt } from '../../shared/utils/jwt';
import { createResponse } from '../../shared/utils/response';
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
            await AuthController.upsertUser(openid, nickname, avatarUrl);
            AuthController.log('callback', '✅ 写入成功');

            const now = Math.floor(Date.now() / 1000);
            const exp = now + 7 * 24 * 3600;
            AuthController.log('callback', '④ 签发 JWT', { openid, iat: now, exp });
            const jwt = signJwt({ openid, nickname, iat: now, exp }, process.env.JWT_SECRET!);
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

        const cookieParts = [
            'token=deleted',
            'Path=/',
            'HttpOnly',
            'Secure',
            'SameSite=Lax',
            'Max-Age=0',
            'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        ];
        if (process.env.COOKIE_DOMAIN) {
            cookieParts.push(`Domain=${process.env.COOKIE_DOMAIN}`);
        }

        res.setHeader('Set-Cookie', cookieParts.join('; '));
        createResponse(res, 200, 'success', null);
    }

    private static async exchangeCodeForToken(code: string): Promise<any> {
        const res = await fetch(
            `https://api.weixin.qq.com/sns/oauth2/access_token` +
            `?appid=${process.env.WECHAT_APPID}` +
            `&secret=${process.env.WECHAT_SECRET}` +
            `&code=${code}` +
            `&grant_type=authorization_code`,
        );
        return res.json();
    }

    private static async fetchWechatUserInfo(accessToken: string, openid: string): Promise<any> {
        const res = await fetch(
            `https://api.weixin.qq.com/sns/userinfo` +
            `?access_token=${accessToken}` +
            `&openid=${openid}` +
            `&lang=zh_CN`,
        );
        return res.json();
    }

    private static async upsertUser(openid: string, nickname: string, avatarUrl: string): Promise<void> {
        await pool.query(
            `INSERT INTO users (openid, nickname, avatar_url)
             VALUES ($1, $2, $3)
             ON CONFLICT(openid) DO UPDATE SET
                 nickname = EXCLUDED.nickname,
                 avatar_url = EXCLUDED.avatar_url`,
            [openid, nickname, avatarUrl],
        );
    }
}
