import { Request, Response, NextFunction } from 'express';
import { signJwt } from '../../shared/utils/jwt';
import { createResponse } from '../../shared/utils/response';
import pool from '../../core/db';
import { consumeCode, isValidMainlandPhone } from '../../core/sms/smsCodeStore';
import { SMS_DEV_TEST_CODE } from '../../core/sms/SmsService';
import { isValidEmail, EMAIL_DEV_TEST_CODE } from '../../core/email/EmailService';
import { hashPassword, verifyPassword, isStrongPassword } from './passwordUtils';
import { isThrottled, recordFailure, clearAccountFailure } from './loginThrottle';

// 密码注册 / 密码登录（登录防刷，2026-09-26；2026-09-26 修订：仅账号维度节流，不降级）
// 路由：POST /api/auth/register、POST /api/auth/password/login
// 口径：注册即登录；登录失败口径统一（不暴露账号是否存在）；同账号 15 分钟内失败达到阈值才节流。

type Identity = { kind: 'phone' | 'email'; value: string };

type UserRow = {
    id: string;
    openid: string | null;
    phone: string | null;
    email: string | null;
    nickname: string | null;
    avatar_url: string | null;
    password_hash?: string | null;
};

function resolveIdentity(account: unknown): Identity | null {
    if (typeof account !== 'string') return null;
    const trimmed = account.trim();
    if (!trimmed) return null;
    if (isValidMainlandPhone(trimmed)) return { kind: 'phone', value: trimmed };
    const email = trimmed.toLowerCase();
    if (isValidEmail(email)) return { kind: 'email', value: email };
    return null;
}

function getClientIp(req: Request): string {
    return req.ip ?? '';
}

export class PasswordAuthController {
    private static log(stage: string, message: string, data?: unknown): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[PasswordAuth][${stage}] ${ts} ${message}${detail}`);
    }

    private static setAuthCookie(res: Response, token: string): void {
        const cookieParts = [`token=${token}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', `Max-Age=${7 * 24 * 3600}`];
        if (process.env.COOKIE_DOMAIN) cookieParts.push(`Domain=${process.env.COOKIE_DOMAIN}`);
        res.setHeader('Set-Cookie', cookieParts.join('; '));
    }

    private static async verifyCode(identity: Identity, code: string): Promise<boolean> {
        const isDev = process.env.NODE_ENV !== 'production';
        const devCode = identity.kind === 'phone' ? SMS_DEV_TEST_CODE : EMAIL_DEV_TEST_CODE;
        if (isDev && code === devCode) return true;
        return consumeCode(identity.value, code);
    }

    private static issueToken(res: Response, row: UserRow): string {
        const now = Math.floor(Date.now() / 1000);
        const exp = now + 7 * 24 * 3600;
        // JwtPayload.openid 为必填；密码/手机号账号无 openid，签空串
        const token = signJwt(
            { id: row.id, openid: row.openid ?? '', nickname: row.nickname ?? '', iat: now, exp },
            process.env.JWT_SECRET!,
        );
        PasswordAuthController.setAuthCookie(res, token);
        return token;
    }

    static async register(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { account, password, code } = req.body ?? {};
            const identity = resolveIdentity(account);
            if (!identity) {
                createResponse(res, 400, '参数错误');
                return;
            }
            if (typeof password !== 'string' || !isStrongPassword(password)) {
                createResponse(res, 400, '密码至少 8 位且需包含字母和数字');
                return;
            }
            if (typeof code !== 'string' || !code) {
                createResponse(res, 400, '参数错误');
                return;
            }
            const codeOk = await PasswordAuthController.verifyCode(identity, code);
            if (!codeOk) {
                createResponse(res, 400, '验证码错误或已过期');
                return;
            }

            const hash = hashPassword(password);
            // 原子 upsert：仅在 password_hash 为空时写入；已有密码时 WHERE 不成立 → 无返回行 → 409
            let row: UserRow;
            try {
                const result =
                    identity.kind === 'phone'
                        ? await pool.query(
                              `INSERT INTO users (id, phone, password_hash)
                               VALUES (gen_random_uuid(), $1, $2)
                               ON CONFLICT (phone) DO UPDATE SET password_hash = EXCLUDED.password_hash
                               WHERE users.password_hash IS NULL
                               RETURNING id, openid, phone, email, nickname, avatar_url`,
                              [identity.value, hash],
                          )
                        : await pool.query(
                              `INSERT INTO users (id, email, password_hash)
                               VALUES (gen_random_uuid(), $1, $2)
                               ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
                               WHERE users.password_hash IS NULL
                               RETURNING id, openid, phone, email, nickname, avatar_url`,
                              [identity.value, hash],
                          );
                if (result.rows.length === 0) {
                    createResponse(res, 409, '该账号已设置密码');
                    return;
                }
                row = result.rows[0] as UserRow;
            } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : String(err);
                PasswordAuthController.log('register', '❌ 注册写库失败', { account: identity.value, error: errMsg });
                createResponse(res, 500, '注册失败，请稍后再试');
                return;
            }

            const token = PasswordAuthController.issueToken(res, row);
            PasswordAuthController.log('register', '✅ 注册成功', { id: row.id, kind: identity.kind });
            createResponse(res, 200, 'success', {
                token,
                userInfo: {
                    id: row.id,
                    openid: row.openid ?? null,
                    nickname: row.nickname ?? '',
                    avatar: row.avatar_url ?? '',
                    phone: row.phone ?? null,
                    email: row.email ?? null,
                },
            });
        } catch (err: unknown) {
            next(err);
        }
    }

    static async passwordLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { account, password } = req.body ?? {};
            const identity = resolveIdentity(account);
            if (!identity) {
                createResponse(res, 400, '参数错误');
                return;
            }
            if (typeof password !== 'string' || !password) {
                createResponse(res, 400, '参数错误');
                return;
            }

            const ip = getClientIp(req);
            if (await isThrottled(identity.value)) {
                PasswordAuthController.log('login', '⛔ 触发登录防刷', { account: identity.value, ip });
                createResponse(res, 429, '尝试过于频繁，请稍后再试');
                return;
            }

            let row: UserRow | undefined;
            try {
                const result =
                    identity.kind === 'phone'
                        ? await pool.query(
                              `SELECT id, openid, phone, email, nickname, avatar_url, password_hash FROM users WHERE phone = $1`,
                              [identity.value],
                          )
                        : await pool.query(
                              `SELECT id, openid, phone, email, nickname, avatar_url, password_hash FROM users WHERE email = $1`,
                              [identity.value],
                          );
                row = result.rows[0] as UserRow | undefined;
            } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : String(err);
                PasswordAuthController.log('login', '❌ 查询账户失败', { account: identity.value, error: errMsg });
                createResponse(res, 500, '登录失败，请稍后再试');
                return;
            }

            const passOk = !!row && verifyPassword(password, row.password_hash ?? null);
            if (!passOk) {
                // 账号不存在 / 未设置密码 / 密码错误，统一按失败处理并计数
                await recordFailure(identity.value);
                PasswordAuthController.log('login', '❌ 登录失败', { account: identity.value, ip });
                createResponse(res, 401, '账号或密码错误');
                return;
            }

            await clearAccountFailure(identity.value);
            const target = row as UserRow;
            const token = PasswordAuthController.issueToken(res, target);
            PasswordAuthController.log('login', '✅ 登录成功', { id: target.id, kind: identity.kind });
            createResponse(res, 200, 'success', {
                token,
                userInfo: {
                    id: target.id,
                    openid: target.openid ?? null,
                    nickname: target.nickname ?? '',
                    avatar: target.avatar_url ?? '',
                    phone: target.phone ?? null,
                    email: target.email ?? null,
                },
            });
        } catch (err: unknown) {
            next(err);
        }
    }
}
