// src/modules/insight/controller.ts
// 自选股洞察 - 前端查询 API（用户侧）
// - GET /api/cn/favorites/insights          列表：登录用户自选股过滤 events + LEFT JOIN results，LIMIT 100
// - GET /api/cn/favorites/insights/:eventId 详情：事件 + 归因结果 + 来源文章联表（登录 + 自选股归属校验）
//
// 鉴权模式跟随 stock-trace/controller.ts：无 req.user 中间件，
// 从 Authorization Bearer token 解析 JWT 取 openid；响应格式一致 res.json({ code, data })。
import type { NextFunction, Request, Response } from 'express';
import pool from '../../core/db';
import { verifyJwt } from '../../shared/utils/jwt';

interface InsightListRow {
    event_id: string;
    symbol: string;
    stock_name: string;
    trade_date: string | Date;
    event_type: string;
    direction: string;
    created_at: Date;
    attribution_status: string | null;
    confidence: string | null;
    primary_driver: unknown;
    secondary_drivers: unknown;
    display_report: unknown;
}

interface InsightDetailRow {
    event_id: string;
    symbol: string;
    stock_name: string;
    trade_date: string | Date;
    event_type: string;
    direction: string;
    insight_group: string;
    source_id: string | null;
    status: string;
    created_at: Date;
    attribution_status: string | null;
    confidence: string | null;
    primary_driver: unknown;
    secondary_drivers: unknown;
    display_report: unknown;
    podcast_brief: string | null;
    title: string | null;
    keywords: unknown;
    source_url: string | null;
    published_at: Date | null;
    /** 价格异动字段（LATERAL join watchlist_price_snapshots） */
    move_bps: number | null;
    snap_direction: string | null;
    open_price: number | null;
    latest_price: number | null;
    price_source: string | null;
}

function openidFromRequest(req: Request): string | null {
    const bearer = req.headers.authorization;
    const token = typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
    if (!token || !process.env.JWT_SECRET) return null;
    return verifyJwt(token, process.env.JWT_SECRET)?.openid || null;
}

function eventIdFromRequest(req: Request): string {
    const value = req.params.eventId;
    return Array.isArray(value) ? value[0] || '' : value || '';
}

export class InsightController {
    /** 列表：登录用户自选股的洞察事件（LEFT JOIN 归因结果，未出结果时归因字段为 null） */
    static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const openid = openidFromRequest(req);
            if (!openid) {
                res.status(401).json({ code: 401, message: 'unauthorized' });
                return;
            }
            const { rows } = await pool.query<InsightListRow>(
                `SELECT e.event_id, e.symbol, e.stock_name, e.trade_date, e.event_type, e.direction, e.created_at,
                        r.attribution_status, r.confidence, r.primary_driver, r.secondary_drivers, r.display_report
                 FROM watchlist_insight_events e
                 JOIN user_stocks us ON us.symbol = e.symbol AND us.openid = $1
                 LEFT JOIN watchlist_insight_results r ON r.event_id = e.event_id AND r.analysis_version = 'watchlist-insight-v1'
                 ORDER BY e.created_at DESC LIMIT 100`,
                [openid],
            );
            res.json({ code: 200, data: rows });
        } catch (error) {
            next(error);
        }
    }

    /** 详情：事件 + 归因结果 + 来源文章（联表），仅限登录用户的自选股事件 */
    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // 与列表接口同款鉴权：先解析登录用户，未登录直接 401（不触库）
            const openid = openidFromRequest(req);
            if (!openid) {
                res.status(401).json({ code: 401, message: 'unauthorized' });
                return;
            }
            const eventId = eventIdFromRequest(req);
            if (!eventId) {
                res.status(404).json({ code: 404, message: 'not found' });
                return;
            }
            // JOIN user_stocks 校验归属：仅返回登录用户自选股对应的事件，无归属行即 404
            const { rows } = await pool.query<InsightDetailRow>(
                `SELECT e.*, r.attribution_status, r.confidence, r.primary_driver, r.secondary_drivers,
                        r.display_report, r.podcast_brief, s.title, s.keywords, s.source_url, s.published_at,
                        snap.move_bps, snap.snap_direction, snap.open_price, snap.latest_price, snap.price_source
                 FROM watchlist_insight_events e
                 JOIN user_stocks us ON us.symbol = e.symbol AND us.openid = $1
                 LEFT JOIN watchlist_insight_results r ON r.event_id = e.event_id AND r.analysis_version = 'watchlist-insight-v1'
                 LEFT JOIN watchlist_insight_sources s ON s.source_id = e.source_id
                 LEFT JOIN LATERAL (
                     SELECT move_bps, direction AS snap_direction, open_price, latest_price, price_source
                     FROM watchlist_price_snapshots ps
                     WHERE ps.symbol = e.symbol AND ps.trade_date = e.trade_date
                     ORDER BY ps.snapshot_time DESC LIMIT 1
                 ) snap ON true
                 WHERE e.event_id = $2`,
                [openid, eventId],
            );
            if (rows.length === 0) {
                res.status(404).json({ code: 404, message: 'not found' });
                return;
            }
            res.json({ code: 200, data: rows[0] });
        } catch (error) {
            next(error);
        }
    }
}
