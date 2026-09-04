/**
 * 账户自动合并（绑定冲突时，2026-08-31）
 *
 * 触发：bindEmail / bindPhone / bindWechat 时目标身份已属另一账户（副账户），
 * 由两个 AuthController 调用，替代原先的"空壳接管 + 非空壳 409"两段式策略——
 * 副账户有数据也不再拒绝，改为完整合并进当前登录账户（主账户）。
 *
 * 合并语义（用户确认）：
 *  - 自选股：副账户 user_stocks 并集合并进主账户（重复 symbol 去重；user_id 与 openid 双通道都处理）
 *  - 设置：以主账户（当前登录）为准，副账户的 user_settings / user_notifications /
 *    user_subscriptions（飞书订阅）关联记录丢弃（openid 转移前必须清理，否则外键违规）
 *  - VIP：主 OR 副，任一为会员则合并后为会员
 *  - 身份：副账户的 openid/email/phone 逐列转移给主账户（仅主账户该列为空时可转移；
 *    主账户已有不同值时保留在副账户——唯一约束限制，极端场景以不丢登录通道优先）
 *  - 副账户：释放已转移身份后保留空壳行（防外键断裂 / 历史报告仍可关联原账户）
 */
import type { PoolClient } from 'pg';
import pool from '../../core/db';

export type IdentityColumn = 'openid' | 'email' | 'phone';

/** 合并后主账户行（绑定接口返回用） */
export interface MergeUserRow {
    id: string;
    openid: string | null;
    email: string | null;
    phone: string | null;
    nickname: string | null;
    avatar_url: string | null;
}

export type MergeResult =
    | { ok: true; row: MergeUserRow }
    | { ok: false; reason: 'noAccount' | 'error' };

/** 绑定微信时附带的昵称/头像（主账户为空才 COALESCE 补入，微信数据优先） */
export interface MergeOptions {
    nickname?: string;
    avatarUrl?: string;
}

const IDENTITY_COLS: IdentityColumn[] = ['openid', 'email', 'phone'];

export async function mergeConflictAccount(
    conflictId: string,
    currentId: string,
    opts: MergeOptions = {},
): Promise<MergeResult> {
    let client: PoolClient;
    try {
        client = await pool.connect();
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`[AccountMerge] 连接失败: ${errMsg}`);
        return { ok: false, reason: 'error' };
    }
    try {
        await client.query('BEGIN');
        // ① 行锁副账户（防检查与写入之间数据变化）
        const secRes = await client.query(
            'SELECT id, openid, email, phone, is_vip FROM users WHERE id = $1 FOR UPDATE',
            [conflictId],
        );
        const secondary = secRes.rows[0] as
            | { id: string; openid: string | null; email: string | null; phone: string | null; is_vip: boolean | null }
            | undefined;
        if (!secondary) {
            await client.query('ROLLBACK');
            return { ok: false, reason: 'noAccount' };
        }
        // ② 读主账户身份（决定哪些身份可转移）
        const mainRes = await client.query('SELECT openid, email, phone FROM users WHERE id = $1', [currentId]);
        const primary = mainRes.rows[0] as { openid: string | null; email: string | null; phone: string | null } | undefined;
        if (!primary) {
            await client.query('ROLLBACK');
            return { ok: false, reason: 'noAccount' };
        }

        // ③ 合并自选股（并集去重）：user_id 通道。
        //    user_stocks 无 id 列（复合唯一走 uq_user_stocks_userid_symbol / uq_user_stocks_openid_symbol
        //    两个 partial 索引），INSERT 不带 id、统一挂主账户 user_id 并置 openid NULL
        await client.query(
            `INSERT INTO user_stocks (user_id, openid, symbol, sort_order)
             SELECT $1, NULL, symbol, sort_order
             FROM user_stocks WHERE user_id = $2
             ON CONFLICT (user_id, symbol) WHERE user_id IS NOT NULL DO NOTHING`,
            [currentId, conflictId],
        );
        await client.query('DELETE FROM user_stocks WHERE user_id = $1', [conflictId]);
        // ③' 旧数据 openid 通道（user_id IS NULL 的老自选股）
        if (secondary.openid) {
            await client.query(
                `INSERT INTO user_stocks (user_id, openid, symbol, sort_order)
                 SELECT $1, NULL, symbol, sort_order
                 FROM user_stocks WHERE openid = $2 AND user_id IS NULL
                 ON CONFLICT (user_id, symbol) WHERE user_id IS NOT NULL DO NOTHING`,
                [currentId, secondary.openid],
            );
            await client.query('DELETE FROM user_stocks WHERE openid = $1 AND user_id IS NULL', [secondary.openid]);
        }

        // ④ 清理引用副账户 openid 的记录（设置以主账户为准；释放 openid 前必须，否则外键违规）。
        //    表可能不存在（如早期环境），to_regclass 先探活再删。
        if (secondary.openid) {
            const regRes = await client.query(
                `SELECT to_regclass('public.user_settings') AS t1,
                        to_regclass('public.user_notifications') AS t2,
                        to_regclass('public.user_subscriptions') AS t3`,
            );
            const reg = regRes.rows[0] as { t1: string | null; t2: string | null; t3: string | null };
            if (reg.t1) await client.query('DELETE FROM user_settings WHERE openid = $1', [secondary.openid]);
            if (reg.t2) await client.query('DELETE FROM user_notifications WHERE openid = $1', [secondary.openid]);
            if (reg.t3) await client.query('DELETE FROM user_subscriptions WHERE user_openid = $1', [secondary.openid]);
        }

        // ⑤ VIP 继承：主 OR 副（is_vip 列 NOT NULL DEFAULT false，无 NULL 风险）
        await client.query('UPDATE users SET is_vip = (is_vip OR $1) WHERE id = $2', [secondary.is_vip === true, currentId]);

        // ⑥ 主账户补身份：副账户有而主账户为空的列；绑定微信时附带昵称/头像（微信数据优先）
        const transfer: { col: IdentityColumn; val: string }[] = [];
        for (const col of IDENTITY_COLS) {
            const v = secondary[col];
            if (typeof v === 'string' && v !== '' && primary[col] === null) transfer.push({ col, val: v });
        }
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const t of transfer) {
            params.push(t.val);
            sets.push(`${t.col} = $${params.length}`);
        }
        if (opts.nickname) {
            params.push(opts.nickname);
            sets.push(`nickname = COALESCE(NULLIF(nickname, ''), $${params.length})`);
        }
        if (opts.avatarUrl) {
            params.push(opts.avatarUrl);
            sets.push(`avatar_url = COALESCE(NULLIF(avatar_url, ''), $${params.length})`);
        }
        // ⑦ 先释放副账户已转移身份（置 NULL，保留空壳行防外键断裂/历史报告失去关联）。
        //    必须先释放再给主账户补身份：否则主账户补入 email/openid 时副账户仍持有同值，
        //    触发唯一索引冲突（users_email_key / users_openid_key），事务回滚。
        if (transfer.length > 0) {
            await client.query(
                `UPDATE users SET ${transfer.map(t => `${t.col} = NULL`).join(', ')} WHERE id = $1`,
                [conflictId],
            );
        }

        // ⑥ 主账户补身份：副账户释放后才可补入（无唯一冲突）
        let row: MergeUserRow | undefined;
        if (sets.length > 0) {
            params.push(currentId);
            const updated = await client.query(
                `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}
                 RETURNING id, openid, email, phone, nickname, avatar_url`,
                params,
            );
            row = updated.rows[0] as MergeUserRow | undefined;
        } else {
            const fetched = await client.query(
                'SELECT id, openid, email, phone, nickname, avatar_url FROM users WHERE id = $1',
                [currentId],
            );
            row = fetched.rows[0] as MergeUserRow | undefined;
        }
        if (!row) {
            await client.query('ROLLBACK');
            return { ok: false, reason: 'noAccount' };
        }

        await client.query('COMMIT');
        return { ok: true, row };
    } catch (err: unknown) {
        await client.query('ROLLBACK').catch(() => { /* 连接可能已断，忽略回滚失败 */ });
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`[AccountMerge] 合并事务失败: ${errMsg}`);
        return { ok: false, reason: 'error' };
    } finally {
        client.release();
    }
}
