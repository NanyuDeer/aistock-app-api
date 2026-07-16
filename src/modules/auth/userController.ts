import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import { verifyJwt } from '../../shared/utils/jwt';
import { isValidAShareSymbol } from '../../shared/utils/validator';
import pool from '../../core/db';

export class UserController {
    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[User][${stage}] ${ts} ${message}${detail}`);
    }

    private static async requireAuth(req: Request): Promise<{ ok: true; openid: string } | { ok: false; code: number; message: string }> {
        // 优先从 Authorization: Bearer <token> header 读取（App/H5 标准方式）
        let token: string | undefined;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.slice(7);
        }
        // Fallback: 从 Cookie 读取（兼容旧版 Web 端）
        if (!token) {
            const cookie = req.headers.cookie || '';
            const tokenMatch = cookie.match(/(?:^|;\s*)token=([^;]+)/);
            if (tokenMatch) token = tokenMatch[1];
        }
        if (!token) return { ok: false, code: 401, message: '未登录' };
        const payload = verifyJwt(token, process.env.JWT_SECRET!);
        if (!payload) return { ok: false, code: 401, message: 'token 无效或已过期' };
        return { ok: true, openid: payload.openid };
    }

    private static extractSymbols(req: Request, allowQuery = true): string[] {
        if (req.is('application/json') && req.body && Array.isArray(req.body.symbols)) {
            return req.body.symbols.map((s: any) => String(s).trim()).filter(Boolean);
        }
        if (allowQuery) {
            const qp = req.query.symbols as string || req.query.symbol as string;
            if (qp) return qp.split(',').map(s => s.trim()).filter(Boolean);
        }
        return [];
    }

    private static async buildFavoritesResponse(res: Response, openid: string): Promise<void> {
        const userResult = await pool.query(
            'SELECT openid, nickname, avatar_url, created_at FROM users WHERE openid = $1',
            [openid],
        );
        const user = userResult.rows[0];

        const stocksResult = await pool.query(
            `SELECT us.symbol, s.name, s.market, us.created_at
             FROM user_stocks us
             LEFT JOIN stocks s ON us.symbol = s.symbol
             WHERE us.openid = $1
             ORDER BY us.created_at DESC`,
            [openid],
        );

        createResponse(res, 200, 'success', {
            openid: user?.openid || openid,
            nickname: user?.nickname || '',
            avatar_url: user?.avatar_url || '',
            created_at: user?.created_at || null,
            自选股: stocksResult.rows.map((s: any) => ({
                股票代码: s.symbol,
                股票简称: s.name || null,
                市场代码: s.market || null,
                添加时间: s.created_at || null,
            })),
        });
    }

    static async me(req: Request, res: Response, _next: NextFunction): Promise<void> {
        UserController.log('me', '收到获取用户信息请求');

        const auth = await UserController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const { openid } = auth;

        const userResult = await pool.query(
            'SELECT openid, nickname, avatar_url, created_at FROM users WHERE openid = $1',
            [openid],
        );
        const user = userResult.rows[0];

        if (!user) {
            UserController.log('me', '❌ 用户不存在', { openid });
            createResponse(res, 404, '用户不存在');
            return;
        }

        const stocksResult = await pool.query(
            `SELECT us.symbol, s.name, s.market, us.created_at
             FROM user_stocks us
             LEFT JOIN stocks s ON us.symbol = s.symbol
             WHERE us.openid = $1
             ORDER BY us.created_at DESC`,
            [openid],
        );

        createResponse(res, 200, 'success', {
            openid: user.openid,
            nickname: user.nickname,
            avatar_url: user.avatar_url,
            created_at: user.created_at,
            自选股: stocksResult.rows.map((s: any) => ({
                股票代码: s.symbol,
                股票简称: s.name || null,
                市场代码: s.market || null,
                添加时间: s.created_at || null,
            })),
        });
    }

    static async addFavorites(req: Request, res: Response, _next: NextFunction): Promise<void> {
        UserController.log('addFavorites', '收到添加自选股请求');

        const auth = await UserController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const { openid } = auth;

        const symbols = UserController.extractSymbols(req);
        if (symbols.length === 0) {
            createResponse(res, 400, '缺少 symbols 参数');
            return;
        }

        const validSymbols = symbols.filter(isValidAShareSymbol);
        if (validSymbols.length === 0) {
            createResponse(res, 400, 'symbols 均无效，需 6 位 A 股代码');
            return;
        }

        for (const sym of validSymbols) {
            await pool.query(
                'INSERT INTO user_stocks (openid, symbol) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [openid, sym],
            );
        }

        UserController.log('addFavorites', '✅ 添加完成', { openid, count: validSymbols.length });
        await UserController.buildFavoritesResponse(res, openid);
    }

    static async removeFavorites(req: Request, res: Response, _next: NextFunction): Promise<void> {
        UserController.log('removeFavorites', '收到删除自选股请求');

        const auth = await UserController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const { openid } = auth;

        const isDelete = req.method === 'DELETE';
        const symbols = UserController.extractSymbols(req, !isDelete);
        if (symbols.length === 0) {
            createResponse(res, 400, '缺少 symbols 参数');
            return;
        }

        const validSymbols = symbols.filter(isValidAShareSymbol);
        if (validSymbols.length === 0) {
            createResponse(res, 400, 'symbols 均无效，需 6 位 A 股代码');
            return;
        }

        for (const sym of validSymbols) {
            await pool.query(
                'DELETE FROM user_stocks WHERE openid = $1 AND symbol = $2',
                [openid, sym],
            );
        }

        UserController.log('removeFavorites', '✅ 删除完成', { openid, count: validSymbols.length });
        await UserController.buildFavoritesResponse(res, openid);
    }

    static async getPushNews(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await UserController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        createResponse(res, 200, 'success', { 推送新闻: [] });
    }

    static async getPushHistory(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await UserController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const { openid } = auth;

        const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 100);
        const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
        const status = String(req.query.status || '').trim();
        const symbol = String(req.query.symbol || '').trim();

        const conditions = ['openid = $1'];
        const values: any[] = [openid];

        if (status && ['sent', 'skipped', 'failed'].includes(status)) {
            values.push(status);
            conditions.push(`status = $${values.length}`);
        }
        if (symbol && isValidAShareSymbol(symbol)) {
            values.push(symbol);
            conditions.push(`symbol = $${values.length}`);
        }

        const whereClause = conditions.join(' AND ');
        const totalResult = await pool.query(
            `SELECT COUNT(*)::int AS total
             FROM wechat_push_logs
             WHERE ${whereClause}`,
            values,
        );

        const listValues = [...values, limit, offset];
        const result = await pool.query(
            `SELECT
                event_id,
                symbol,
                stock_name,
                event_type,
                level,
                summary,
                status,
                error_msg,
                sent_at,
                click_url
             FROM wechat_push_logs
             WHERE ${whereClause}
             ORDER BY sent_at DESC
             LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
            listValues,
        );

        createResponse(res, 200, 'success', {
            total: totalResult.rows[0]?.total || 0,
            limit,
            offset,
            items: result.rows.map((item: any) => ({
                event_id: item.event_id,
                stock_code: item.symbol,
                stock_name: item.stock_name,
                event_type: item.event_type,
                level: item.level,
                summary: item.summary,
                status: item.status,
                error_msg: item.error_msg || null,
                sent_at: item.sent_at || null,
                detail_url: item.click_url || null,
            })),
        });
    }

    static async getPushRanking(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await UserController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const { openid } = auth;

        const date = String(req.query.date || '').trim();
        const dateCondition = /^\d{4}-\d{2}-\d{2}$/.test(date)
            ? 'sent_at::date = $2::date'
            : 'sent_at::date = CURRENT_DATE';
        const values: any[] = /^\d{4}-\d{2}-\d{2}$/.test(date) ? [openid, date] : [openid];

        const result = await pool.query(
            `SELECT
                symbol,
                stock_name,
                COUNT(*)::int AS push_count,
                SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END)::int AS sent_count,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failed_count,
                SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END)::int AS skipped_count,
                MAX(CASE level
                    WHEN 'L4' THEN 4
                    WHEN 'L3' THEN 3
                    WHEN 'L2' THEN 2
                    WHEN 'L1' THEN 1
                    ELSE 0
                END)::int AS max_level_score,
                (array_agg(level ORDER BY
                    CASE level
                        WHEN 'L4' THEN 4
                        WHEN 'L3' THEN 3
                        WHEN 'L2' THEN 2
                        WHEN 'L1' THEN 1
                        ELSE 0
                    END DESC, sent_at DESC))[1] AS max_level,
                (array_agg(summary ORDER BY sent_at DESC))[1] AS latest_summary,
                MAX(sent_at) AS latest_sent_at,
                (array_agg(click_url ORDER BY sent_at DESC))[1] AS detail_url
             FROM wechat_push_logs
             WHERE openid = $1 AND ${dateCondition}
             GROUP BY symbol, stock_name
             ORDER BY max_level_score DESC, push_count DESC, latest_sent_at DESC
             LIMIT 50`,
            values,
        );

        createResponse(res, 200, 'success', {
            date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
            items: result.rows.map((item: any, index: number) => ({
                rank: index + 1,
                stock_code: item.symbol,
                stock_name: item.stock_name,
                push_count: item.push_count,
                sent_count: item.sent_count,
                failed_count: item.failed_count,
                skipped_count: item.skipped_count,
                max_level: item.max_level || null,
                latest_summary: item.latest_summary || null,
                latest_sent_at: item.latest_sent_at || null,
                detail_url: item.detail_url || null,
                cumulative_return: null,
            })),
        });
    }

    static async getSettings(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await UserController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const { openid } = auth;

        const result = await pool.query(
            `SELECT setting_type, enabled, updated_at
             FROM user_settings
             WHERE openid = $1
             ORDER BY setting_type ASC`,
            [openid],
        );

        createResponse(res, 200, 'success', {
            openid,
            settings: result.rows.map((item: any) => ({
                setting_type: item.setting_type,
                enabled: Number(item.enabled) === 1,
                updated_at: item.updated_at || null,
            })),
        });
    }

    static async updateSetting(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const settingType = String(req.params.settingType || '');

        if (!/^[A-Za-z0-9_-]{1,64}$/.test(settingType)) {
            createResponse(res, 400, 'Invalid settingType - 仅支持字母/数字/_/-，长度 1-64');
            return;
        }

        const auth = await UserController.requireAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        const { openid } = auth;

        const body = req.body;
        const enabledRaw = body?.enabled;
        let enabledValue: 0 | 1 | null = null;
        if (typeof enabledRaw === 'boolean') {
            enabledValue = enabledRaw ? 1 : 0;
        } else if (enabledRaw === 0 || enabledRaw === 1) {
            enabledValue = enabledRaw;
        }

        if (enabledValue === null) {
            createResponse(res, 400, 'Invalid enabled - enabled 必须是 boolean 或 0/1');
            return;
        }

        await pool.query(
            `INSERT INTO user_settings (openid, setting_type, enabled, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT(openid, setting_type)
             DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP`,
            [openid, settingType, enabledValue],
        );

        const updatedResult = await pool.query(
            `SELECT setting_type, enabled, updated_at
             FROM user_settings
             WHERE openid = $1 AND setting_type = $2`,
            [openid, settingType],
        );
        const updated = updatedResult.rows[0];

        createResponse(res, 200, 'success', {
            openid,
            setting_type: updated?.setting_type || settingType,
            enabled: Number(updated?.enabled ?? enabledValue) === 1,
            updated_at: updated?.updated_at || null,
        });
    }
}
