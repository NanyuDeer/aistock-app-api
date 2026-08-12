// src/modules/insight/internalRouter.ts
// 自选股洞察 internal API（Python 归因 Agent 专用）：x-internal-token 鉴权
// - GET  /events/:eventId/context   取归因上下文（事件 + 来源文章）
// - PATCH /jobs/:jobId              回报任务状态
// - POST  /results/external         回写归因结果（upsert）
import { Router, type Request, type Response } from 'express';
import pool from '../../core/db';
import { reportStatus, type InsightJobStatus } from './InsightJobService';

const router: Router = Router();
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

/** Express 5 params 可能为 string | string[]，安全取 string（core/routes/internal 的助手未导出，本地等价实现） */
function param(req: Request, key: string): string {
    const val = req.params[key];
    return Array.isArray(val) ? val[0] : (val || '');
}

/** 从 unknown 错误中安全提取 message */
function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

router.use((req, res, next) => {
    if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
        res.status(403).json({ code: 403, message: 'Forbidden' });
        return;
    }
    next();
});

/** Python 取归因上下文：来源文章 + 事件信息 */
router.get('/events/:eventId/context', async (req: Request, res: Response) => {
    try {
        const eventId = param(req, 'eventId');
        const { rows } = await pool.query(
            `SELECT e.symbol, e.stock_name, e.trade_date, e.event_type, e.direction,
                    s.title, s.keywords, s.content, s.published_at, s.source_id
             FROM watchlist_insight_events e
             JOIN watchlist_insight_sources s ON s.source_id = e.source_id
             WHERE e.event_id = $1`,
            [eventId],
        );
        if (rows.length === 0) {
            res.status(404).json({ code: 404, message: 'Event not found' });
            return;
        }
        res.json({ code: 200, data: rows[0] });
    } catch (error: unknown) {
        res.status(502).json({ code: 502, message: errMsg(error) });
    }
});

/** Python 回报任务状态（status / last_error_code / increment_attempt） */
router.patch('/jobs/:jobId', async (req: Request, res: Response) => {
    const jobId = param(req, 'jobId');
    const body = req.body as { status?: InsightJobStatus; last_error_code?: string; increment_attempt?: boolean } | undefined;
    if (!jobId || !body?.status) {
        res.status(400).json({ code: 400, message: 'job id and status are required' });
        return;
    }
    try {
        const result = await reportStatus(jobId, body.status, {
            lastErrorCode: body.last_error_code,
            incrementAttempt: body.increment_attempt,
        });
        if (!result) {
            res.status(404).json({ code: 404, message: 'Job not found' });
            return;
        }
        res.json({ code: 200, data: { attempt_count: result.attemptCount } });
    } catch (error: unknown) {
        res.status(500).json({ code: 500, message: errMsg(error) });
    }
});

interface ExternalResultInput {
    event_id: string;
    analysis_version: string;
    attribution_status?: 'confirmed' | 'unconfirmed';
    confidence?: 'high' | 'medium' | 'low' | 'unconfirmed';
    primary_driver?: Record<string, unknown>;
    secondary_drivers?: unknown[];
    display_report?: Record<string, unknown>;
    podcast_brief?: string;
    validation_status?: 'llm' | 'rule_fallback';
    model_provider?: string;
}

/** Python 回写归因结果（按 (event_id, analysis_version) upsert，全字段覆盖） */
router.post('/results/external', async (req: Request, res: Response) => {
    const body = req.body as { result?: ExternalResultInput } | undefined;
    const result = body?.result;
    if (!result || !result.event_id || !result.analysis_version) {
        res.status(400).json({ code: 400, message: 'result.event_id and result.analysis_version are required' });
        return;
    }
    try {
        await pool.query(
            `INSERT INTO watchlist_insight_results
               (event_id, analysis_version, attribution_status, confidence, primary_driver,
                secondary_drivers, display_report, podcast_brief, validation_status, model_provider)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (event_id, analysis_version) DO UPDATE SET
               attribution_status = EXCLUDED.attribution_status,
               confidence = EXCLUDED.confidence,
               primary_driver = EXCLUDED.primary_driver,
               secondary_drivers = EXCLUDED.secondary_drivers,
               display_report = EXCLUDED.display_report,
               podcast_brief = EXCLUDED.podcast_brief,
               validation_status = EXCLUDED.validation_status,
               model_provider = EXCLUDED.model_provider`,
            [result.event_id, result.analysis_version, result.attribution_status ?? 'unconfirmed',
             result.confidence ?? 'low', JSON.stringify(result.primary_driver || {}),
             JSON.stringify(result.secondary_drivers || []), JSON.stringify(result.display_report || {}),
             result.podcast_brief || '', result.validation_status || 'llm', result.model_provider || ''],
        );
        // 结果落库后触发洞察推送（fire-and-forget：失败只记日志，不影响回写响应）
        void import('./InsightPushService').then(m => m.pushCreated(result.event_id)).catch(e =>
            console.error('[insight] push failed', e));
        res.status(201).json({ code: 201, data: {} });
    } catch (error: unknown) {
        res.status(500).json({ code: 500, message: errMsg(error) });
    }
});

/** 统一事件抓取中台：按日期读取同花顺原创/涨停雷达源（watchlist_insight_sources） */
router.get('/sources', async (req: Request, res: Response) => {
    try {
        const day = String(req.query.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
            res.status(400).json({ code: 400, message: 'Invalid date format' });
            return;
        }
        const { rows } = await pool.query(
            `SELECT source_id, title, content, keywords, published_at, source_id AS id
             FROM watchlist_insight_sources
             WHERE trade_date = $1::date
             ORDER BY published_at DESC`,
            [day],
        );
        res.json({ code: 200, data: { items: rows } });
    } catch (error: unknown) {
        res.status(502).json({ code: 502, message: errMsg(error) });
    }
});

export default router;
