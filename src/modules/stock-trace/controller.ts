import type { NextFunction, Request, Response } from 'express';
import { verifyJwt } from '../../shared/utils/jwt';
import { isTokenRevoked } from '../../shared/utils/tokenBlacklist';
import { StockTraceService } from './StockTraceService';
import { StockTraceArtifactService } from './StockTraceArtifactService';
import { presentStockTraceAnalysis } from './StockTracePresentation';
import { StockTraceResultService } from './StockTraceResultService';
import { StockTraceJobService } from './StockTraceJobService';
import { InsightReportService } from './InsightReportService';
import { PriceTriggerDetector } from './PriceTriggerDetector';

/**
 * 统一账户模型鉴权（与 InsightController.authFromRequest 同款）：
 * 信任 JWT 载荷，id 为统一账户主键（邮箱/手机/微信均含），openid 仅兼容老微信数据。
 * 与 openidFromRequest 的差异：邮箱/手机账户 openid 为空串，不能据此判断登录态，
 * 必须用 id（payload.id ?? openid 兜底）判断是否登录，避免邮箱用户误走全局降级。
 */
async function authFromRequest(req: Request): Promise<{ id: string; openid: string } | null> {
    const bearer = req.headers.authorization;
    const token = typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
    if (!token || !process.env.JWT_SECRET) return null;
    const payload = verifyJwt(token, process.env.JWT_SECRET);
    if (!payload) return null;
    // token-revocation Step 2：命中黑名单按未登录处理（读侧 fail-open）
    if (await isTokenRevoked(payload.jti)) return null;
    // 旧 token 无 id 时用 openid 回填，保证老微信用户可用
    return { id: payload.id ?? payload.openid ?? '', openid: payload.openid ?? '' };
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

/** 报告章节之间的推送间隔（ms）：模板构建是毫秒级的，不加节奏则前端"瞬间铺满"、失去流式观感；调 0 即瞬时。 */
const REPORT_SECTION_INTERVAL_MS = 80;

async function presentEventAnalysis(eventId: string, event: Record<string, unknown>) {
    const revision = triggerRevision(event);
    const artifact = revision > 0
        ? await StockTraceArtifactService.getEffectiveArtifactForRevision(eventId, revision)
        : null;
    const latestResult = revision > 0
        ? await StockTraceResultService.getLatestForEventRevision(eventId, revision)
        : null;
    // 当前版本最新 job 状态（dead_letter → failed）；无 job 为 null，不透传 failed。
    // 优先级（unavailable > failed）由 presentStockTraceAnalysis 内部保证，与列表 SQL 一致。
    const jobStatus = revision > 0
        ? await StockTraceJobService.getLatestJobStatusForEventRevision(eventId, revision)
        : null;
    // 当前版本归因失败（无 artifact 且最新 result 被拒/失败）时，回退到该事件最近的有效归因，
    // 避免"有异动却看不到归因"（如重新归因失败会覆盖原本有效的旧版本归因）。
    if (!artifact && latestResult && (latestResult.validationStatus === 'rejected' || latestResult.processingStatus === 'failed')) {
        const fallback = await StockTraceArtifactService.getEffectiveArtifact(eventId);
        if (fallback) return presentStockTraceAnalysis(event, fallback, latestResult, jobStatus);
    }
    return presentStockTraceAnalysis(event, artifact, latestResult, jobStatus);
}

export class StockTraceController {
    static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const auth = await authFromRequest(req);
            const cursor = Array.isArray(req.query.cursor) ? req.query.cursor[0] : req.query.cursor;
            const cursorStr = typeof cursor === 'string' ? cursor : undefined;
            // visible_only（opt-in）：前端显式传参把过滤前置到 SQL（unavailable + 低置信 low）。
            // 仅当为 1/true 时透传 options.visibleOnly；internalRouter 不传该参 → 走原 SQL，语义逐字不变。
            const visibleRaw = Array.isArray(req.query.visible_only) ? req.query.visible_only[0] : req.query.visible_only;
            const visibleOnly = visibleRaw === '1' || visibleRaw === 'true';
            const options = visibleOnly ? { visibleOnly: true } : undefined;
            // 未登录降级：返回最近全局异动事件，符合"登录非必需"项目约束。
            // 登录用户按统一账户 id（user_id 优先）+ openid 兜底过滤，只看自己自选股的异动；
            // 可见性下界 = 持仓期（listUserEvents JOIN ON e.first_triggered_at >= us.created_at，2026-09-04）。
            const result = auth && auth.id
                ? await StockTraceService.listUserEvents(auth.id, auth.openid, limitFromRequest(req), cursorStr, options)
                : await StockTraceService.listRecentEvents(limitFromRequest(req), cursorStr, options);
            res.json({ code: 200, data: result });
        } catch (error) {
            next(error);
        }
    }

    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const auth = await authFromRequest(req);
            const eventId = eventIdFromRequest(req);
            // 未登录降级：返回全局事件详情（与 list 接口一致，符合"登录非必须"约束）
            const result = auth && auth.id
                ? await StockTraceService.getUserEvent(auth.id, auth.openid, eventId)
                : await StockTraceService.getRecentEvent(eventId);
            if (!result) {
                res.status(404).json({ code: 404, message: 'Event not found' });
                return;
            }
            const presentation = await presentEventAnalysis(eventId, result);
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

    /**
     * 完整洞察报告（前端用 fetch + ReadableStream 消费，故可带 Authorization 头并读状态码）：
     * 登录 + 自选归属 + 有效归因校验 + 章节构建**全部在开流前完成**，前置失败回真实
     * HTTP 状态码 + JSON；仅在开流后才异常时走 `data: {"type":"error"}` 兜底。
     */
    static async reportStream(req: Request, res: Response): Promise<void> {
        try {
            const auth = await authFromRequest(req);
            if (!auth || !auth.id) {
                res.status(401).json({ code: 401, message: '请先登录查看' });
                return;
            }
            const eventId = eventIdFromRequest(req);
            const event = eventId
                ? await StockTraceService.getUserEvent(auth.id, auth.openid, eventId)
                : null;
            if (!eventId || !event) {
                res.status(404).json({ code: 404, message: '该异动不在你的自选范围内，或已过期' });
                return;
            }
            const presentation = await presentEventAnalysis(eventId, event);
            if (!presentation.artifact) {
                res.status(409).json({ code: 409, message: '该异动暂无完整归因' });
                return;
            }
            const revision = triggerRevision(event);
            const result = revision > 0
                ? await StockTraceResultService.getLatestForEventRevision(eventId, revision)
                : null;
            const data = InsightReportService.buildReportData(event, presentation.artifact, result);
            // 章节在开流前取回：agent-py 不可用/结构非法时仍能回 502 状态码
            const report = await InsightReportService.fetchSections(data);

            res.setHeader('Content-Type', 'text/event-stream;charset=UTF-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();

            // 不分发具名事件（不写 `event:` 行），type 放进 data，前端按 `data: {...}\n\n` 分帧
            const send = (payload: { type: string } & Record<string, unknown>): void => {
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
            };
            const heartbeat = setInterval(() => { res.write(': keep-alive\n\n'); }, 15_000);
            try {
                send({ type: 'start', header: report.header, total: report.sections.length });
                for (let i = 0; i < report.sections.length; i += 1) {
                    const section = report.sections[i];
                    send({ type: 'section', index: i, heading: section.heading, blocks: section.blocks });
                    if (i < report.sections.length - 1) {
                        await new Promise((resolve) => { setTimeout(resolve, REPORT_SECTION_INTERVAL_MS); });
                    }
                }
                send({ type: 'done', message: 'success' });
            } finally {
                clearInterval(heartbeat);
                res.end();
            }
        } catch (error) {
            console.error('[InsightReport] stream failed:', error instanceof Error ? error.message : error);
            const message = '报告生成失败，请重试';
            if (res.headersSent) {
                res.write(`data: ${JSON.stringify({ type: 'error', code: 502, message })}\n\n`);
                res.end();
                return;
            }
            res.status(502).json({ code: 502, message });
        }
    }

    static async analysis(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const auth = await authFromRequest(req);
            const eventId = eventIdFromRequest(req);
            // 未登录降级：返回全局事件分析（与 list/get 接口一致）
            const event = auth && auth.id
                ? await StockTraceService.getUserEvent(auth.id, auth.openid, eventId)
                : await StockTraceService.getRecentEvent(eventId);
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
            const auth = await authFromRequest(req);
            const eventId = eventIdFromRequest(req);
            const sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] || '' : req.params.sourceId || '';
            // 未登录降级：查全局事件
            const event = auth && auth.id
                ? await StockTraceService.getUserEvent(auth.id, auth.openid, eventId)
                : await StockTraceService.getRecentEvent(eventId);
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
            const auth = await authFromRequest(req);
            // 已读状态存于 stock_trace_user_events（仅 openid 列），邮箱/手机账户 openid=''
            // 若写入会与所有此类账户共享同一条空 openid 记录（UNIQUE(event_id, openid) 覆盖），
            // 造成跨账户已读污染，故对 openid 空串的账户降级返回成功但不持久化（不影响查看事件）。
            const markOpenid = auth?.openid ?? '';
            if (!markOpenid) {
                res.json({ code: 200, data: { event_id: eventIdFromRequest(req), read: true } });
                return;
            }
            const updated = await StockTraceService.markRead(markOpenid, eventIdFromRequest(req));
            if (!updated) {
                res.status(404).json({ code: 404, message: 'Event not found' });
                return;
            }
            res.json({ code: 200, data: { event_id: eventIdFromRequest(req), read: true } });
        } catch (error) {
            next(error);
        }
    }

    /**
     * 手动触发一次异动检测（绕过交易时段限制）。
     * 非交易日/非交易时段也能检测自选股异动，检测完前端刷新列表即可看到新事件。
     */
    static async detect(_req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            await PriceTriggerDetector.runOnceForce();
            res.json({ code: 200, data: { triggered: true } });
        } catch (error) {
            next(error);
        }
    }
}
