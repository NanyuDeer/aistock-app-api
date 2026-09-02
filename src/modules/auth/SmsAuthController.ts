/**
 * 短信验证码登录 + 手机/微信双向绑定（统一账户模型，2026-08-25）
 *
 * - POST /api/auth/sms/send     发送验证码（Redis 缓存 + 限流，dev 回显日志）
 * - POST /api/auth/sms/login    手机号 + 验证码登录（无账户自动创建）
 * - POST /api/auth/bind/phone   Bearer 登录态下给当前账户绑定手机号
 * - POST /api/auth/bind/wechat  Bearer 登录态下给当前账户绑定微信（需手机+验证码证明归属）
 *
 * 冲突策略（2026-08-31 起）：phone / openid 已属其他 id 时调用 accountMerge.mergeConflictAccount
 * 自动合并（自选股并集 / 设置以主账户为准 / VIP 继承 / 身份转移），不再 409 拒绝。
 * dev 环境放行固定测试码 SMS_DEV_TEST_CODE（登录/绑定校验共用）。
 */
import { Request, Response, NextFunction } from 'express';
import { signJwt, verifyJwt } from '../../shared/utils/jwt';
import { createResponse } from '../../shared/utils/response';
import { extractTokenFromRequest, isTokenRevoked, REVOKED_MESSAGE } from '../../shared/utils/tokenBlacklist';
import pool from '../../core/db';
import { SmsService, SMS_DEV_TEST_CODE } from '../../core/sms/SmsService';
import { generateSmsCode, isValidMainlandPhone, setCode, consumeCode, isRateLimited } from '../../core/sms/smsCodeStore';
import { mergeConflictAccount } from './accountMerge';
import { AuthController } from './controller';

type AuthResult = { ok: true; id: string; openid: string } | { ok: false; code: number; message: string };

export class SmsAuthController {
    private static log(stage: string, message: string, data?: unknown): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[SmsAuth][${stage}] ${ts} ${message}${detail}`);
    }

    /** 种 httpOnly 登录 Cookie（Web/H5 端 cookie 鉴权；App 端忽略 Set-Cookie），与 AuthController/ScanLoginController 对齐 */
    private static setAuthCookie(res: Response, token: string): void {
        const cookieParts = [
            `token=${token}`,
            'Path=/',
            'HttpOnly',
            'Secure',
            'SameSite=Lax',
            `Max-Age=${7 * 24 * 3600}`,
        ];
        if (process.env.COOKIE_DOMAIN) cookieParts.push(`Domain=${process.env.COOKIE_DOMAIN}`);
        res.setHeader('Set-Cookie', cookieParts.join('; '));
    }

    /** 鉴权：信任 JWT 载荷（id 优先，旧 token 用 openid 回填），逻辑与 UserController.requireAuth 对齐 */
    private static async resolveAuth(req: Request): Promise<AuthResult> {
        const token = extractTokenFromRequest(req);
        if (!token) return { ok: false, code: 401, message: '未登录' };
        const payload = verifyJwt(token, process.env.JWT_SECRET!);
        if (!payload) return { ok: false, code: 401, message: 'token 无效或已过期' };
        if (await isTokenRevoked(payload.jti)) return { ok: false, code: 401, message: REVOKED_MESSAGE };
        const id = payload.id ?? payload.openid;
        return { ok: true, id, openid: payload.openid };
    }

    /** 验证码校验：dev 放行固定测试码，否则单次消费 Redis 中的验证码 */
    private static async verifyCode(phone: string, code: string): Promise<boolean> {
        const isDev = process.env.NODE_ENV !== 'production';
        if (isDev && code === SMS_DEV_TEST_CODE) return true;
        return consumeCode(phone, code);
    }

    /** 发送验证码：POST /api/auth/sms/send（可选 body.scenario：login 默认 / bind 绑定前发送） */
    static async sendSms(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const phone = String(req.body?.phone ?? '').trim();
        const scenario = (String(req.body?.scenario ?? '')).trim();
        if (!isValidMainlandPhone(phone)) {
            createResponse(res, 400, '手机号格式不正确');
            return;
        }
        if (await isRateLimited(phone)) {
            createResponse(res, 429, '发送过于频繁，请稍后再试');
            return;
        }
        const code = generateSmsCode();
        await setCode(phone, code);
        try {
            await SmsService.send(phone, code, scenario === 'bind' ? 'bind' : 'login');
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            SmsAuthController.log('send', '❌ 发送验证码失败', { phone, error: errMsg });
            createResponse(res, 500, `验证码发送失败: ${errMsg}`);
            return;
        }
        SmsAuthController.log('send', '✅ 验证码已发送（dev 回显）', { phone });
        createResponse(res, 200, 'success', { expireSeconds: 300 });
    }

    /** 手机号 + 验证码登录：POST /api/auth/sms/login */
    static async smsLogin(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const phone = String(req.body?.phone ?? '').trim();
        const code = String(req.body?.code ?? '').trim();
        if (!isValidMainlandPhone(phone)) {
            createResponse(res, 400, '手机号格式不正确');
            return;
        }
        if (!code) {
            createResponse(res, 400, '验证码不能为空');
            return;
        }
        const ok = await SmsAuthController.verifyCode(phone, code);
        if (!ok) {
            createResponse(res, 400, '验证码错误或已过期');
            return;
        }

        // 按 phone 取或建账户（ON CONFLICT DO UPDATE ... RETURNING 原子处理并发首登）
        let row: { id: string; openid: string | null; phone: string | null; nickname: string | null; avatar_url: string | null };
        try {
            const result = await pool.query(
                `INSERT INTO users (id, phone)
                 VALUES (gen_random_uuid(), $1)
                 ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
                 RETURNING id, openid, phone, nickname, avatar_url`,
                [phone],
            );
            row = result.rows[0] as typeof row;
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            SmsAuthController.log('login', '❌ 账户取建失败', { phone, error: errMsg });
            createResponse(res, 500, '登录失败，请稍后再试');
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const exp = now + 7 * 24 * 3600;
        const token = signJwt(
            { id: row.id, openid: row.openid ?? '', nickname: row.nickname ?? '', iat: now, exp },
            process.env.JWT_SECRET!,
        );

        // Web/H5 端依赖 httpOnly cookie 鉴权（扫码登录同款），App 端继续用 body token
        SmsAuthController.setAuthCookie(res, token);

        SmsAuthController.log('login', '✅ 登录成功', { id: row.id, openid: row.openid });
        createResponse(res, 200, 'success', {
            token,
            userInfo: {
                id: row.id,
                openid: row.openid ?? null,
                nickname: row.nickname ?? '',
                avatar: row.avatar_url ?? '',
                phone: row.phone ?? null,
            },
        });
    }

    /** 绑定手机号：POST /api/auth/bind/phone（Bearer 已登录） */
    static async bindPhone(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await SmsAuthController.resolveAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const phone = String(req.body?.phone ?? '').trim();
        const code = String(req.body?.code ?? '').trim();
        if (!isValidMainlandPhone(phone)) {
            createResponse(res, 400, '手机号格式不正确');
            return;
        }
        if (!code) {
            createResponse(res, 400, '验证码不能为空');
            return;
        }
        if (!(await SmsAuthController.verifyCode(phone, code))) {
            createResponse(res, 400, '验证码错误或已过期');
            return;
        }

        // 归属冲突：该手机号已属其他账户 → 验证码已证明手机号归属，自动合并进当前账户
        const conflict = await pool.query('SELECT id FROM users WHERE phone = $1 AND id <> $2', [phone, auth.id]);
        let row: { id: string; openid: string | null; phone: string | null; nickname: string | null; avatar_url: string | null };
        if (conflict.rows.length > 0) {
            const result = await mergeConflictAccount(String(conflict.rows[0].id), auth.id);
            if (!result.ok) {
                const code = result.reason === 'noAccount' ? 404 : 500;
                const message = result.reason === 'noAccount' ? '账户不存在' : '绑定失败，请稍后再试';
                createResponse(res, code, message);
                return;
            }
            row = result.row;
            SmsAuthController.log('bindPhone', '✅ 手机号绑定成功（冲突账户已自动合并）', { id: auth.id, phone, oldId: conflict.rows[0].id });
        } else {
            const updated = await pool.query(
                `UPDATE users SET phone = $1 WHERE id = $2
                 RETURNING id, openid, phone, nickname, avatar_url`,
                [phone, auth.id],
            );
            row = updated.rows[0];
            if (!row) {
                createResponse(res, 404, '账户不存在');
                return;
            }
            SmsAuthController.log('bindPhone', '✅ 手机号绑定成功', { id: auth.id, phone });
        }

        createResponse(res, 200, 'success', {
            id: row.id,
            openid: row.openid ?? null,
            phone: row.phone ?? null,
            nickname: row.nickname ?? '',
            avatar: row.avatar_url ?? '',
            wechatBound: !!row.openid,
            phoneBound: !!row.phone,
        });
    }

    /** 绑定微信：POST /api/auth/bind/wechat（Bearer 登录态手机账户，手机+验证码证明归属） */
    static async bindWechat(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await SmsAuthController.resolveAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const phone = String(req.body?.phone ?? '').trim();
        const code = String(req.body?.code ?? '').trim();
        const wxCode = String(req.body?.wxCode ?? '').trim();
        if (!isValidMainlandPhone(phone) || !code || !wxCode) {
            createResponse(res, 400, '参数不完整：需 phone、code、wxCode');
            return;
        }
        if (!(await SmsAuthController.verifyCode(phone, code))) {
            createResponse(res, 400, '验证码错误或已过期');
            return;
        }
        // 手机号须属于当前账户（证明该手机归本人，防把他人微信绑到自己名下）
        const ownPhone = await pool.query('SELECT id FROM users WHERE phone = $1 AND id = $2', [phone, auth.id]);
        if (ownPhone.rows.length === 0) {
            createResponse(res, 403, '该手机号不属于当前账户');
            return;
        }

        // 用 wxCode 换 openid + 昵称/头像
        let openid: string;
        let nickname = '';
        let avatarUrl = '';
        try {
            const tokenData = await AuthController.exchangeCodeForToken(wxCode);
            if (tokenData.errcode) {
                createResponse(res, 400, `微信授权失败: ${tokenData.errmsg}`);
                return;
            }
            openid = String(tokenData.openid);
            const userInfo = await AuthController.fetchWechatUserInfo(tokenData.access_token, openid);
            nickname = userInfo.nickname || '';
            avatarUrl = userInfo.headimgurl || '';
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            SmsAuthController.log('bindWechat', '❌ 微信换 openid 失败', { error: errMsg });
            createResponse(res, 500, `微信授权失败: ${errMsg}`);
            return;
        }

        // 归属冲突：该微信已属其他账户 → 验证码已证明归属，自动合并（微信昵称/头像随 openid 转移）
        const conflict = await pool.query('SELECT id FROM users WHERE openid = $1 AND id <> $2', [openid, auth.id]);
        let row: { id: string; openid: string | null; phone: string | null; nickname: string | null; avatar_url: string | null };
        if (conflict.rows.length > 0) {
            const result = await mergeConflictAccount(String(conflict.rows[0].id), auth.id, { nickname, avatarUrl });
            if (!result.ok) {
                const code = result.reason === 'noAccount' ? 404 : 500;
                const message = result.reason === 'noAccount' ? '账户不存在' : '绑定失败，请稍后再试';
                createResponse(res, code, message);
                return;
            }
            row = result.row;
            SmsAuthController.log('bindWechat', '✅ 微信绑定成功（冲突账户已自动合并）', { id: auth.id, openid, oldId: conflict.rows[0].id });
        } else {
            const updated = await pool.query(
                `UPDATE users SET openid = $1,
                     nickname = COALESCE(NULLIF(nickname, ''), $2),
                     avatar_url = COALESCE(NULLIF(avatar_url, ''), $3)
                 WHERE id = $4
                 RETURNING id, openid, phone, nickname, avatar_url`,
                [openid, nickname, avatarUrl, auth.id],
            );
            row = updated.rows[0];
            if (!row) {
                createResponse(res, 404, '账户不存在');
                return;
            }
            SmsAuthController.log('bindWechat', '✅ 微信绑定成功', { id: auth.id, openid });
        }

        createResponse(res, 200, 'success', {
            id: row.id,
            openid: row.openid ?? null,
            phone: row.phone ?? null,
            nickname: row.nickname ?? '',
            avatar: row.avatar_url ?? '',
            wechatBound: !!row.openid,
            phoneBound: !!row.phone,
        });
    }
}
