import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { signJwt } from '../../shared/utils/jwt';
import { createResponse } from '../../shared/utils/response';
import { CacheService } from '../../shared/utils/CacheService';
import pool from '../../core/db';
// 注意：微信 API 调用必须使用原生 fetch，不能用 sessionFetch（自定义 https.Agent keepAlive），
// 否则微信服务器会返回 HTTP 412 Precondition Failed。详见 project_memory.md。

export class ScanLoginController {
    // 内存 fallback：当 PostgreSQL 不可用时（本地降级模式），用 Map 存储 state
    // 与 CacheService 的 dual-write 策略一致，详见 project_memory.md
    private static memoryStates = new Map<string, {
        status: 'pending' | 'confirmed';
        openid?: string;
        jwt?: string;
        expiresAt: Date;
    }>();

    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[ScanLogin][${stage}] ${ts} ${message}${detail}`);
    }

    private static async cleanExpiredStates(): Promise<void> {
        // 清理内存中的过期 state
        const now = new Date();
        for (const [state, record] of ScanLoginController.memoryStates) {
            if (record.expiresAt < now) {
                ScanLoginController.memoryStates.delete(state);
            }
        }
        // 清理数据库中的过期 state（失败时不影响流程，降级模式）
        try {
            await pool.query('DELETE FROM scan_login_states WHERE expires_at < CURRENT_TIMESTAMP');
        } catch (err) {
            // 数据库不可用时静默失败
        }
    }

    static async getServerAccessToken(): Promise<string> {
        const cacheKey = 'wechat:server_access_token';
        const cached = await CacheService.get<string>(cacheKey);
        if (cached) {
            ScanLoginController.log('accessToken', '命中缓存');
            return cached;
        }

        ScanLoginController.log('accessToken', '请求微信获取 server access_token');
        const res = await fetch(
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
            const wxRes = await fetch(
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

            // 先检查 HTTP 状态码
            if (!wxRes.ok) {
                const errText = await wxRes.text().catch(() => '');
                ScanLoginController.log('generateQr', '❌ 微信API返回非200状态', { status: wxRes.status, body: errText.slice(0, 200) });
                createResponse(res, 500, `微信API错误(${wxRes.status}): ${errText.slice(0, 100) || '无响应体'}`);
                return;
            }

            // 解析响应体
            const wxText = await wxRes.text().catch(() => '');
            if (!wxText || wxText.trim() === '') {
                ScanLoginController.log('generateQr', '❌ 微信API返回空响应', { status: wxRes.status });
                createResponse(res, 500, '微信API返回空响应，请检查公众号配置');
                return;
            }

            let wxData: any;
            try {
                wxData = JSON.parse(wxText);
            } catch (parseErr: any) {
                ScanLoginController.log('generateQr', '❌ 微信API响应非JSON', { body: wxText.slice(0, 200) });
                createResponse(res, 500, `微信API响应格式错误: ${wxText.slice(0, 100)}`);
                return;
            }

            if (wxData.errcode) {
                ScanLoginController.log('generateQr', '❌ 创建二维码失败', { errcode: wxData.errcode, errmsg: wxData.errmsg });
                createResponse(res, 500, `创建二维码失败: ${wxData.errmsg}`);
                return;
            }

            const ticket: string = wxData.ticket;
            const qrUrl = `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(ticket)}`;

            const expiresAt = new Date(Date.now() + 300 * 1000);
            try {
                await pool.query(
                    `INSERT INTO scan_login_states (state, status, expires_at) VALUES ($1, 'pending', $2)`,
                    [state, expiresAt.toISOString()],
                );
            } catch (dbErr) {
                // 数据库不可用时（本地降级模式），用内存 Map 存储 state
                ScanLoginController.log('generateQr', '⚠️ 数据库不可用，使用内存 Map 存储 state', { state });
                ScanLoginController.memoryStates.set(state, { status: 'pending', expiresAt });
            }

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

            // 先尝试数据库查询
            let record: any = null;
            try {
                const result = await pool.query(
                    `SELECT state, status, openid, jwt, expires_at
                     FROM scan_login_states
                     WHERE state = $1 AND expires_at > CURRENT_TIMESTAMP`,
                    [state],
                );
                record = result.rows[0];
            } catch (dbErr) {
                // 数据库不可用时（本地降级模式），从内存 Map 查询
                ScanLoginController.log('scanEvent', '⚠️ 数据库不可用，从内存 Map 查询', { state });
                const memRecord = ScanLoginController.memoryStates.get(state);
                if (memRecord && memRecord.expiresAt > new Date()) {
                    record = { status: memRecord.status };
                }
            }

            if (!record) {
                ScanLoginController.log('scanEvent', '❌ state 不存在或已过期', { state });
                return;
            }

            if (record.status !== 'pending') {
                ScanLoginController.log('scanEvent', 'state 非 pending，跳过', { state, status: record.status });
                return;
            }

            // 获取用户昵称和头像（通过公众号 user/info 接口）
            let nickname = '';
            let avatarUrl = '';
            try {
                const accessToken = await ScanLoginController.getServerAccessToken();
                const userRes = await fetch(
                    `https://api.weixin.qq.com/cgi-bin/user/info` +
                    `?access_token=${accessToken}` +
                    `&openid=${openid}` +
                    `&lang=zh_CN`,
                );
                const userData: any = await userRes.json();
                if (userData.nickname) nickname = userData.nickname;
                if (userData.headimgurl) avatarUrl = userData.headimgurl;
                ScanLoginController.log('scanEvent', '用户信息获取', { openid, nickname: nickname || '(空)', hasAvatar: !!avatarUrl });
            } catch (userInfoErr) {
                // 获取用户信息失败不中断登录流程，仅记录 openid
                ScanLoginController.log('scanEvent', '⚠️ 获取用户信息失败，继续登录流程', { error: String(userInfoErr) });
            }

            const now = Math.floor(Date.now() / 1000);
            const exp = now + 7 * 24 * 3600;
            const jwt = signJwt({ openid, nickname, iat: now, exp }, process.env.JWT_SECRET!);

            try {
                await pool.query(
                    `INSERT INTO users (openid, nickname, avatar_url)
                     VALUES ($1, $2, $3)
                     ON CONFLICT(openid) DO UPDATE SET
                         nickname = CASE WHEN EXCLUDED.nickname != '' THEN EXCLUDED.nickname ELSE users.nickname END,
                         avatar_url = CASE WHEN EXCLUDED.avatar_url != '' THEN EXCLUDED.avatar_url ELSE users.avatar_url END`,
                    [openid, nickname, avatarUrl],
                );
                await pool.query(
                    `UPDATE scan_login_states SET status = 'confirmed', openid = $1, jwt = $2 WHERE state = $3`,
                    [openid, jwt, state],
                );
            } catch (dbErr) {
                // 数据库不可用时，更新内存 Map
                ScanLoginController.log('scanEvent', '⚠️ 数据库不可用，更新内存 Map', { state });
                ScanLoginController.memoryStates.set(state, {
                    status: 'confirmed',
                    openid,
                    jwt,
                    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
                });
            }

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

        let record: any = null;
        try {
            const result = await pool.query(
                `SELECT state, status, openid, jwt, expires_at FROM scan_login_states WHERE state = $1`,
                [state],
            );
            record = result.rows[0];
        } catch (dbErr) {
            // 数据库不可用时（本地降级模式），从内存 Map 查询
            ScanLoginController.log('poll', '⚠️ 数据库不可用，从内存 Map 查询', { state });
            const memRecord = ScanLoginController.memoryStates.get(state);
            if (memRecord) {
                record = {
                    status: memRecord.status,
                    openid: memRecord.openid,
                    jwt: memRecord.jwt,
                    expires_at: memRecord.expiresAt,
                };
            }
        }

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
                token: record.jwt,
                timestamp: new Date().toISOString(),
            });
            return;
        }

        createResponse(res, 200, record.status, { status: record.status });
    }
}
