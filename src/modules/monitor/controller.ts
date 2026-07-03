/**
 * 趋势风口 API 控制器
 *
 * 提供前端页面所需的公告/新闻研判数据查询接口。
 */

import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import { StockMonitorService } from './service';
import { verifyJwt } from '../../shared/utils/jwt';

export class StockMonitorController {
    /**
     * 从请求中提取用户openid（需要登录）
     */
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
     * GET /api/cn/trend-hotspots/events
     * 查询趋势风口列表
     *
     * Query params:
     *   - cycle: 周期筛选 (all/short/mid/long)，默认 all
     *   - change_type: 信息类型(news/announcement)或影响级别
     *   - stock_code: 指定股票代码
     *   - limit: 每页条数，默认 20
     *   - offset: 偏移量，默认 0
     */
    static async getEvents(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const cycle = String(req.query.cycle || 'all');
            const change_type = req.query.change_type ? String(req.query.change_type) : undefined;
            const stock_code = req.query.stock_code ? String(req.query.stock_code) : undefined;
            const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10), 1), 100);
            const offset = Math.max(parseInt(String(req.query.offset || '0'), 10), 0);

            const result = await StockMonitorService.getEvents({
                cycle,
                change_type,
                stock_code,
                limit,
                offset,
            });

            createResponse(res, 200, 'success', result);
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[TrendHotspotController] getEvents error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * GET /api/cn/trend-hotspots/events/:stockCode
     * 查询指定股票的趋势风口
     */
    static async getEventsByStock(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const stockCode = String(req.params.stockCode || '').replace(/^(SH|SZ|BJ)/, '');
            if (!stockCode) {
                createResponse(res, 400, 'Missing stockCode');
                return;
            }

            const cycle = String(req.query.cycle || 'all');
            const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10), 1), 100);

            const events = await StockMonitorService.getEventsByStockCode(stockCode, { cycle, limit });

            createResponse(res, 200, 'success', { events });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[TrendHotspotController] getEventsByStock error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * GET /api/cn/trend-hotspots/stats
     * 获取趋势风口统计概览
     */
    static async getStats(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const stats = await StockMonitorService.getStats();
            createResponse(res, 200, 'success', stats);
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[TrendHotspotController] getStats error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * GET /api/cn/favorites/news
     * 查询用户自选股资讯（需登录）
     *
     * Query params:
     *   - cycle: 周期筛选 (all/short/mid/long)，默认 all
     *   - change_type: 信息类型(news/announcement)或影响级别
     *   - limit: 每页条数，默认 20
     *   - offset: 偏移量，默认 0
     */
    static async getFavoritesNews(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const auth = await StockMonitorController.requireAuth(req);
            if (!auth.ok) {
                createResponse(res, auth.code, auth.message);
                return;
            }
            const { openid } = auth;

            const cycle = String(req.query.cycle || 'all');
            const change_type = req.query.change_type ? String(req.query.change_type) : undefined;
            const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10), 1), 100);
            const offset = Math.max(parseInt(String(req.query.offset || '0'), 10), 0);

            const result = await StockMonitorService.getEventsByUserFavorites(openid, {
                cycle,
                change_type,
                limit,
                offset,
            });

            createResponse(res, 200, 'success', result);
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[StockMonitorController] getFavoritesNews error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }
}
