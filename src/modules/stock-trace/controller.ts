import type { NextFunction, Request, Response } from 'express';
import { verifyJwt } from '../../shared/utils/jwt';
import { StockTraceService } from './StockTraceService';
import { StockTraceArtifactService } from './StockTraceArtifactService';
import { presentStockTraceAnalysis } from './StockTracePresentation';
import { StockTraceResultService } from './StockTraceResultService';

function openidFromRequest(req: Request): string | null {
    const bearer = req.headers.authorization;
    const token = typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
    if (!token || !process.env.JWT_SECRET) return null;
    return verifyJwt(token, process.env.JWT_SECRET)?.openid || null;
}

function limitFromRequest(req: Request): number {
    const raw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const limit = Number(raw || 20);
    return Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 20;
}

function eventIdFromRequest(req: Request): string {
    const value = req.params.eventId;
    return Array.isArray(value) ? value[0] || '' : value || '';
}

function triggerRevision(event: Record<string, unknown>): number {
    const value = Number(event.trigger_revision);
    return Number.isInteger(value) && value > 0 ? value : 0;
}

async function presentEventAnalysis(eventId: string, event: Record<string, unknown>) {
    const revision = triggerRevision(event);
    const artifact = revision > 0
        ? await StockTraceArtifactService.getEffectiveArtifactForRevision(eventId, revision)
        : null;
    const latestResult = revision > 0
        ? await StockTraceResultService.getLatestForEventRevision(eventId, revision)
        : null;
    return presentStockTraceAnalysis(event, artifact, latestResult);
}

export class StockTraceController {
    static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const openid = openidFromRequest(req);
            const cursor = Array.isArray(req.query.cursor) ? req.query.cursor[0] : req.query.cursor;
            const cursorStr = typeof cursor === 'string' ? cursor : undefined;
            // 未登录降级：返回最近全局异动事件，符合"登录非必需"项目约束。
            // 登录用户仍然按 openid 过滤，只看自己自选股的异动。
            const result = openid
                ? await StockTraceService.listUserEvents(openid, limitFromRequest(req), cursorStr)
                : await StockTraceService.listRecentEvents(limitFromRequest(req), cursorStr);
            res.json({ code: 200, data: result });
        } catch (error) {
            next(error);
        }
    }

    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const openid = openidFromRequest(req);
            if (!openid) {
                res.status(401).json({ code: 401, message: 'Unauthorized' });
                return;
            }
            const result = await StockTraceService.getUserEvent(openid, eventIdFromRequest(req));
            if (!result) {
                res.status(404).json({ code: 404, message: 'Event not found' });
                return;
            }
            const presentation = await presentEventAnalysis(eventIdFromRequest(req), result);
            res.json({
                code: 200,
                data: {
                    ...result,
                    analysis_status: presentation.processingStatus,
                    movement_view: presentation.artifact?.movementView || null,
                    unavailable: presentation.unavailable,
                },
            });
        } catch (error) {
            next(error);
        }
    }

    static async analysis(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const openid = openidFromRequest(req);
            if (!openid) {
                res.status(401).json({ code: 401, message: 'Unauthorized' });
                return;
            }
            const eventId = eventIdFromRequest(req);
            const event = await StockTraceService.getUserEvent(openid, eventId);
            if (!event) {
                res.status(404).json({ code: 404, message: 'Event not found' });
                return;
            }
            const presentation = await presentEventAnalysis(eventId, event);
            res.json({
                code: 200,
                data: {
                    event_id: eventId,
                    trigger_revision: triggerRevision(event),
                    processing_status: presentation.processingStatus,
                    artifact: presentation.artifact,
                    unavailable: presentation.unavailable,
                },
            });
        } catch (error) {
            next(error);
        }
    }

    static async evidence(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const openid = openidFromRequest(req);
            if (!openid) {
                res.status(401).json({ code: 401, message: 'Unauthorized' });
                return;
            }
            const eventId = eventIdFromRequest(req);
            const sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] || '' : req.params.sourceId || '';
            const event = await StockTraceService.getUserEvent(openid, eventId);
            if (!event) {
                res.status(404).json({ code: 404, message: 'Event not found' });
                return;
            }
            const evidence = await StockTraceArtifactService.getEvidence(
                eventId,
                sourceId,
                triggerRevision(event),
            );
            if (!evidence) {
                res.status(404).json({ code: 404, message: 'Evidence not found' });
                return;
            }
            res.json({ code: 200, data: evidence });
        } catch (error) {
            next(error);
        }
    }

    static async markRead(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const openid = openidFromRequest(req);
            if (!openid) {
                res.status(401).json({ code: 401, message: 'Unauthorized' });
                return;
            }
            const updated = await StockTraceService.markRead(openid, eventIdFromRequest(req));
            if (!updated) {
                res.status(404).json({ code: 404, message: 'Event not found' });
                return;
            }
            res.json({ code: 200, data: { event_id: eventIdFromRequest(req), read: true } });
        } catch (error) {
            next(error);
        }
    }
}
