/**
 * 邮箱验证码登录 + 邮箱/微信双向绑定（统一账户模型，2026-08-25）
 *
 * - POST /api/auth/email/send     发送验证码（Redis 缓存 + 限流，dev 回显日志）
 * - POST /api/auth/email/login    邮箱 + 验证码登录（无账户自动创建）
 * - POST /api/auth/bind/email     Bearer 登录态下给当前账户绑定邮箱
 * - POST /api/auth/bind/wechat    Bearer 登录态下给当前账户绑定微信（需邮箱+验证码证明归属）
 *
 * 与 SmsAuthController 平行（复制其 setAuthCookie / resolveAuth / verifyCode 私有逻辑，
 * 保持独立解耦，短信控制器完全不动）。邮箱统一 toLowerCase 归一化，防大小写重复建户。
 */
import { Request, Response, NextFunction } from 'express';
import type { PoolClient } from 'pg';
import { signJwt, verifyJwt } from '../../shared/utils/jwt';
import { createResponse } from '../../shared/utils/response';
import { extractTokenFromRequest, isTokenRevoked, REVOKED_MESSAGE } from '../../shared/utils/tokenBlacklist';
import pool from '../../core/db';
import { EmailService, EMAIL_DEV_TEST_CODE, isValidEmail } from '../../core/email/EmailService';
import { generateSmsCode, setCode, consumeCode, isRateLimited } from '../../core/sms/smsCodeStore';
import { AuthController } from './controller';

type AuthResult = { ok: true; id: string; openid: string } | { ok: false; code: number; message: string };

/** users 表行（绑定接口返回用） */
type UserRow = {
    id: string;
    openid: string | null;
    email: string | null;
    nickname: string | null;
    avatar_url: string | null;
};

/** 邮箱接管结果 */
type TakeoverResult =
    | { ok: true; row: UserRow }
    | { ok: false; reason: 'notAbandoned' | 'noAccount' | 'error' };

/** 邮箱归一化：去空格 + 小写（同一邮箱不同大小写视为同一账户） */
function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export class EmailAuthController {
    private static log(stage: string, message: string, data?: unknown): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[EmailAuth][${stage}] ${ts} ${message}${detail}`);
    }

    /** 种 httpOnly 登录 Cookie（与 SmsAuthController.setAuthCookie 一致） */
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

    /** 鉴权：信任 JWT 载荷（与 SmsAuthController.resolveAuth 一致） */
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
    private static async verifyCode(email: string, code: string): Promise<boolean> {
        const isDev = process.env.NODE_ENV !== 'production';
        if (isDev && code === EMAIL_DEV_TEST_CODE) return true;
        return consumeCode(email, code);
    }

    /** 发送验证码：POST /api/auth/email/send */
    static async sendEmail(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const email = normalizeEmail(String(req.body?.email ?? ''));
        if (!isValidEmail(email)) {
            createResponse(res, 400, '邮箱格式不正确');
            return;
        }
        if (await isRateLimited(email)) {
            createResponse(res, 429, '发送过于频繁，请稍后再试');
            return;
        }
        const code = generateSmsCode();
        await setCode(email, code);
        try {
            await EmailService.send(email, code);
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            EmailAuthController.log('send', '❌ 发送验证码失败', { email, error: errMsg });
            createResponse(res, 500, `验证码发送失败: ${errMsg}`);
            return;
        }
        EmailAuthController.log('send', '✅ 验证码已发送（dev 回显）', { email });
        createResponse(res, 200, 'success', { expireSeconds: 300 });
    }

    /** 邮箱 + 验证码登录：POST /api/auth/email/login */
    static async emailLogin(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const email = normalizeEmail(String(req.body?.email ?? ''));
        const code = String(req.body?.code ?? '').trim();
        if (!isValidEmail(email)) {
            createResponse(res, 400, '邮箱格式不正确');
            return;
        }
        if (!code) {
            createResponse(res, 400, '验证码不能为空');
            return;
        }
        const ok = await EmailAuthController.verifyCode(email, code);
        if (!ok) {
            createResponse(res, 400, '验证码错误或已过期');
            return;
        }

        // 按 email 取或建账户（ON CONFLICT DO UPDATE ... RETURNING 原子处理并发首登）
        let row: { id: string; openid: string | null; email: string | null; nickname: string | null; avatar_url: string | null };
        try {
            const result = await pool.query(
                `INSERT INTO users (id, email)
                 VALUES (gen_random_uuid(), $1)
                 ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
                 RETURNING id, openid, email, nickname, avatar_url`,
                [email],
            );
            row = result.rows[0] as typeof row;
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            EmailAuthController.log('login', '❌ 账户取建失败', { email, error: errMsg });
            createResponse(res, 500, '登录失败，请稍后再试');
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const exp = now + 7 * 24 * 3600;
        const token = signJwt(
            { id: row.id, openid: row.openid ?? '', nickname: row.nickname ?? '', iat: now, exp },
            process.env.JWT_SECRET!,
        );

        EmailAuthController.setAuthCookie(res, token);

        EmailAuthController.log('login', '✅ 登录成功', { id: row.id, openid: row.openid });
        createResponse(res, 200, 'success', {
            token,
            userInfo: {
                id: row.id,
                openid: row.openid ?? null,
                nickname: row.nickname ?? '',
                avatar: row.avatar_url ?? '',
                email: row.email ?? null,
            },
        });
    }

    /**
     * 空壳账户接管：目标身份（邮箱 / 微信 openid）已被另一账户占用时调用。
     *
     * 若占户为空壳账户（除被接管身份外无邮箱/微信/手机绑定、无自选股、无设置），且调用方
     * 已通过验证码证明当前用户持有该身份，则在事务内释放旧账户对应身份并绑定到当前账户——
     * 这是通用方案，适用于任何用户遇到"身份已绑空账户"的场景，而非一次性修数据。
     * 行锁（SELECT ... FOR UPDATE）防止检查与释放之间旧账户数据变化。
     *
     * @param identityColumn 被接管释放的 users 列（'email' 或 'openid'）
     * @param conflictId     当前占用该身份的账户 id
     * @param currentId      当前登录账户 id
     * @param bindSql        绑定当前账户的 SET 片段（首个占位符即身份值）
     * @param bindParams     绑定参数（身份值 + 可选附加列，如微信昵称/头像）
     */
    private static async takeoverIdentity(
        identityColumn: 'email' | 'openid',
        conflictId: string,
        currentId: string,
        bindSql: string,
        bindParams: unknown[],
    ): Promise<TakeoverResult> {
        let client: PoolClient;
        try {
            client = await pool.connect();
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            EmailAuthController.log('bind', '❌ 身份接管连接失败', { conflictId, error: errMsg });
            return { ok: false, reason: 'error' };
        }
        try {
            await client.query('BEGIN');
            // 行锁旧账户，确认其空壳性
            const locked = await client.query('SELECT email, openid, phone FROM users WHERE id = $1 FOR UPDATE', [conflictId]);
            const holder = locked.rows[0] as { email: string | null; openid: string | null; phone: string | null } | undefined;
            if (holder) {
                const hasStocks = await client.query('SELECT 1 FROM user_stocks WHERE user_id = $1 LIMIT 1', [conflictId]);
                const hasSettings = await client.query('SELECT 1 FROM user_settings WHERE openid = $1 LIMIT 1', [holder.openid]);
                // 空壳判定：除被接管身份外无其他绑定（邮箱/微信/手机）+ 无自选股/设置
                const otherIdentityNull = identityColumn === 'email' ? holder.openid === null : holder.email === null;
                const abandoned = otherIdentityNull && holder.phone === null
                    && hasStocks.rows.length === 0 && hasSettings.rows.length === 0;
                if (!abandoned) {
                    await client.query('ROLLBACK');
                    return { ok: false, reason: 'notAbandoned' };
                }
                // 释放旧账户的该身份（该账户无任何可保留数据）
                await client.query(`UPDATE users SET ${identityColumn} = NULL WHERE id = $1`, [conflictId]);
            }
            // 绑定到当前账户
            const updated = await client.query(
                `UPDATE users SET ${bindSql} WHERE id = $${bindParams.length + 1}
                 RETURNING id, openid, email, nickname, avatar_url`,
                [...bindParams, currentId],
            );
            const row = updated.rows[0] as UserRow | undefined;
            if (!row) {
                await client.query('ROLLBACK');
                return { ok: false, reason: 'noAccount' };
            }
            await client.query('COMMIT');
            return { ok: true, row };
        } catch (err: unknown) {
            await client.query('ROLLBACK').catch(() => { /* 连接可能已断，忽略回滚失败 */ });
            const errMsg = err instanceof Error ? err.message : String(err);
            EmailAuthController.log('bind', '❌ 身份接管事务失败', { conflictId, error: errMsg });
            return { ok: false, reason: 'error' };
        } finally {
            client.release();
        }
    }

    /** 绑定邮箱：POST /api/auth/bind/email（Bearer 已登录） */
    static async bindEmail(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await EmailAuthController.resolveAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const email = normalizeEmail(String(req.body?.email ?? ''));
        const code = String(req.body?.code ?? '').trim();
        if (!isValidEmail(email)) {
            createResponse(res, 400, '邮箱格式不正确');
            return;
        }
        if (!code) {
            createResponse(res, 400, '验证码不能为空');
            return;
        }
        if (!(await EmailAuthController.verifyCode(email, code))) {
            createResponse(res, 400, '验证码错误或已过期');
            return;
        }

        // 归属冲突：该邮箱已属其他账户
        const conflict = await pool.query('SELECT id FROM users WHERE email = $1 AND id <> $2', [email, auth.id]);
        let row: UserRow;
        if (conflict.rows.length > 0) {
            // 占户为空壳账户时，验证码已证明邮箱归属 → 自动接管；否则 409 拒绝
            const result = await EmailAuthController.takeoverIdentity(
                'email',
                String(conflict.rows[0].id),
                auth.id,
                'email = $1',
                [email],
            );
            if (!result.ok) {
                const code = result.reason === 'notAbandoned' ? 409 : result.reason === 'noAccount' ? 404 : 500;
                const message =
                    result.reason === 'notAbandoned' ? '该邮箱已绑定其他账户'
                    : result.reason === 'noAccount' ? '账户不存在'
                    : '绑定失败，请稍后再试';
                createResponse(res, code, message);
                return;
            }
            row = result.row;
            EmailAuthController.log('bindEmail', '✅ 邮箱接管成功（旧空账户已释放）', { id: auth.id, email, oldId: conflict.rows[0].id });
        } else {
            const updated = await pool.query(
                `UPDATE users SET email = $1 WHERE id = $2
                 RETURNING id, openid, email, nickname, avatar_url`,
                [email, auth.id],
            );
            row = updated.rows[0] as UserRow;
            if (!row) {
                createResponse(res, 404, '账户不存在');
                return;
            }
            EmailAuthController.log('bindEmail', '✅ 邮箱绑定成功', { id: auth.id, email });
        }

        createResponse(res, 200, 'success', {
            id: row.id,
            openid: row.openid ?? null,
            email: row.email ?? null,
            nickname: row.nickname ?? '',
            avatar: row.avatar_url ?? '',
            wechatBound: !!row.openid,
            emailBound: !!row.email,
        });
    }

    /** 绑定微信：POST /api/auth/bind/wechat（Bearer 登录态邮箱账户，邮箱+验证码证明归属） */
    static async bindWechat(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await EmailAuthController.resolveAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const email = normalizeEmail(String(req.body?.email ?? ''));
        const code = String(req.body?.code ?? '').trim();
        const wxCode = String(req.body?.wxCode ?? '').trim();
        if (!isValidEmail(email) || !code || !wxCode) {
            createResponse(res, 400, '参数不完整：需 email、code、wxCode');
            return;
        }
        if (!(await EmailAuthController.verifyCode(email, code))) {
            createResponse(res, 400, '验证码错误或已过期');
            return;
        }
        // 邮箱须属于当前账户（证明该邮箱归本人，防把他人微信绑到自己名下）
        const ownEmail = await pool.query('SELECT id FROM users WHERE email = $1 AND id = $2', [email, auth.id]);
        if (ownEmail.rows.length === 0) {
            createResponse(res, 403, '该邮箱不属于当前账户');
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
            EmailAuthController.log('bindWechat', '❌ 微信换 openid 失败', { error: errMsg });
            createResponse(res, 500, `微信授权失败: ${errMsg}`);
            return;
        }

        // 归属冲突：该微信已属其他账户 → 占户为空壳账户时自动接管；否则 409 + 引导
        const conflict = await pool.query('SELECT id FROM users WHERE openid = $1 AND id <> $2', [openid, auth.id]);
        let row: UserRow;
        if (conflict.rows.length > 0) {
            const result = await EmailAuthController.takeoverIdentity(
                'openid',
                String(conflict.rows[0].id),
                auth.id,
                `openid = $1, nickname = COALESCE(NULLIF(nickname, ''), $2), avatar_url = COALESCE(NULLIF(avatar_url, ''), $3)`,
                [openid, nickname, avatarUrl],
            );
            if (!result.ok) {
                const code = result.reason === 'notAbandoned' ? 409 : result.reason === 'noAccount' ? 404 : 500;
                const message =
                    result.reason === 'notAbandoned'
                        ? '该微信已绑定其他账户。若该账户有数据，请先用该微信登录一次，在「账号与安全」页绑定邮箱，即可保留原微信数据'
                        : result.reason === 'noAccount' ? '账户不存在' : '绑定失败，请稍后再试';
                createResponse(res, code, message);
                return;
            }
            row = result.row;
            EmailAuthController.log('bindWechat', '✅ 微信接管成功（旧空账户已释放）', { id: auth.id, openid, oldId: conflict.rows[0].id });
        } else {
            const updated = await pool.query(
                `UPDATE users SET openid = $1,
                     nickname = COALESCE(NULLIF(nickname, ''), $2),
                     avatar_url = COALESCE(NULLIF(avatar_url, ''), $3)
                 WHERE id = $4
                 RETURNING id, openid, email, nickname, avatar_url`,
                [openid, nickname, avatarUrl, auth.id],
            );
            row = updated.rows[0] as UserRow;
            if (!row) {
                createResponse(res, 404, '账户不存在');
                return;
            }
            EmailAuthController.log('bindWechat', '✅ 微信绑定成功', { id: auth.id, openid });
        }

        createResponse(res, 200, 'success', {
            id: row.id,
            openid: row.openid ?? null,
            email: row.email ?? null,
            nickname: row.nickname ?? '',
            avatar: row.avatar_url ?? '',
            wechatBound: !!row.openid,
            emailBound: !!row.email,
        });
    }
}
