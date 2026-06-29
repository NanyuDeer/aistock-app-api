import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { signJwt } from '../utils/jwt';
import { createResponse } from '../utils/response';
import { CacheService } from '../services/CacheService';
import { sessionFetch } from '../utils/httpAgent';
import pool from '../db';

export class ScanLoginController {
    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[ScanLogin][${stage}] ${ts} ${message}${detail}`);
    }

    private static async cleanExpiredStates(): Promise<void> {
        await pool.query('DELETE FROM scan_login_states WHERE expires_at < CURRENT_TIMESTAMP');
    }

    static async getServerAccessToken(): Promise<string> {
        const cacheKey = 'wechat:server_access_token';
        const cached = await CacheService.get<string>(cacheKey);
        if (cached) {
            ScanLoginController.log('accessToken', '命中缓存');
            return cached;
        }

        ScanLoginController.log('accessToken', '请求微信获取 server access_token');
        const res = await sessionFetch(
            `https://api.weixin.qq.com/cgi-bin/token` +
            `?grant_type=client_credential` +
            `&appid=${process.env.WECHAT_APPID}` +
            `&secret=${process.env.WECHAT_SECRET}`,
        );
        const data: any = await res.json();

        if (data.errcode) {
            ScanLoginController.log('accessToken', '❌ 获取失败', { errcode: data.errcode, errmsg: data.errmsg });
            throw new Error(`获取 server access_token 失败: ${data.errmsg}`);
        }

        const token: string = data.access_token;
        const expiresIn: number = data.expires_in || 7200;
        await CacheService.set(cacheKey, token, Math.max(expiresIn - 200, 60));
        ScanLoginController.log('accessToken', '✅ 获取成功，已缓存', { expiresIn });
        return token;
    }

    static async generateQrCode(req: Request, res: Response, _next: NextFunction): Promise<void> {
        ScanLoginController.log('generateQr', '收到生成二维码请求');

        try {
            const state = crypto.randomUUID().replace(/-/g, '');
            const sceneStr = `login_${state}`;

            const accessToken = await ScanLoginController.getServerAccessToken();

            ScanLoginController.log('generateQr', '调用微信创建临时二维码', { sceneStr });
            const wxRes = await sessionFetch(
                `https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=${accessToken}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        expire_seconds: 300,
                        action_name: 'QR_STR_SCENE',
                        action_info: { scene: { scene_str: sceneStr } },
                    }),
                },
            );
            const wxData: any = await wxRes.json();

            if (wxData.errcode) {
                ScanLoginController.log('generateQr', '❌ 创建二维码失败', { errcode: wxData.errcode, errmsg: wxData.errmsg });
                createResponse(res, 500, `创建二维码失败: ${wxData.errmsg}`);
                return;
            }

            const ticket: string = wxData.ticket;
            const qrUrl = `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(ticket)}`;

            const expiresAt = new Date(Date.now() + 300 * 1000).toISOString();
            await pool.query(
                `INSERT INTO scan_login_states (state, status, expires_at) VALUES ($1, 'pending', $2)`,
                [state, expiresAt],
            );

            ScanLoginController.log('generateQr', '✅ 二维码生成成功', { state });
            createResponse(res, 200, 'success', { state, qr_url: qrUrl, expire_seconds: 300 });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            ScanLoginController.log('generateQr', '❌ 生成二维码异常', { error: errMsg });
            createResponse(res, 500, `生成二维码失败: ${errMsg}`);
        }
    }

    static async handleScanEvent(openid: string, sceneStr: string): Promise<void> {
        ScanLoginController.log('scanEvent', '收到扫码事件', { openid, sceneStr });

        try {
            if (!sceneStr.startsWith('login_')) {
                ScanLoginController.log('scanEvent', '非登录场景，跳过', { sceneStr });
                return;
            }

            const state = sceneStr.replace('login_', '');

            const result = await pool.query(
                `SELECT state, status, openid, jwt, expires_at
                 FROM scan_login_states
                 WHERE state = $1 AND expires_at > CURRENT_TIMESTAMP`,
                [state],
            );
            const record = result.rows[0];

            if (!record) {
                ScanLoginController.log('scanEvent', '❌ state 不存在或已过期', { state });
                return;
            }

            if (record.status !== 'pending') {
                ScanLoginController.log('scanEvent', 'state 非 pending，跳过', { state, status: record.status });
                return;
            }

            await pool.query(
                `INSERT INTO users (openid, nickname, avatar_url)
                 VALUES ($1, '', '')
                 ON CONFLICT(openid) DO UPDATE SET openid = EXCLUDED.openid`,
                [openid],
            );

            const now = Math.floor(Date.now() / 1000);
            const exp = now + 7 * 24 * 3600;
            const jwt = signJwt({ openid, iat: now, exp }, process.env.JWT_SECRET!);

            await pool.query(
                `UPDATE scan_login_states SET status = 'confirmed', openid = $1, jwt = $2 WHERE state = $3`,
                [openid, jwt, state],
            );

            ScanLoginController.log('scanEvent', '✅ 登录确认完成', { state, openid });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            ScanLoginController.log('scanEvent', '❌ 处理扫码事件异常', { error: errMsg });
            throw err;
        }
    }

    static async poll(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const state = req.query.state as string;

        ScanLoginController.log('poll', '收到轮询请求', { state });

        if (!state) {
            createResponse(res, 400, '缺少 state 参数');
            return;
        }

        await ScanLoginController.cleanExpiredStates();

        const result = await pool.query(
            `SELECT state, status, openid, jwt, expires_at FROM scan_login_states WHERE state = $1`,
            [state],
        );
        const record = result.rows[0] as any;

        if (!record) {
            ScanLoginController.log('poll', '❌ state 不存在或已过期', { state });
            createResponse(res, 404, '二维码已过期或 state 无效');
            return;
        }

        if (record.status === 'pending') {
            createResponse(res, 200, 'pending', { status: 'pending' });
            return;
        }

        if (record.status === 'confirmed') {
            ScanLoginController.log('poll', '✅ 登录已确认，返回 JWT', { state, openid: record.openid });

            const cookieParts = [
                `token=${record.jwt}`,
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
            createResponse(res, 200, 'confirmed', {
                status: 'confirmed',
                openid: record.openid,
                timestamp: new Date().toISOString(),
            });
            return;
        }

        createResponse(res, 200, record.status, { status: record.status });
    }
}
