// src/modules/insight/internalRouter.ts
// 自选股洞察 internal API（Python 归因 Agent 专用）：x-internal-token 鉴权
// - GET  /events/:eventId/context   取归因上下文（事件 + 来源文章 + 证据包）
// - PATCH /jobs/:jobId              回报任务状态
// - POST  /results/external         回写归因结果（upsert + 更新推送）
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

/** query 安全取 string（Express 5 query 可能为 string | string[] | ParsedQs） */
function queryStr(req: Request, key: string): string {
    const val = req.query[key];
    return Array.isArray(val) ? String(val[0] || '') : typeof val === 'string' ? val : '';
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

/** Python 取归因上下文：事件信息 + 来源文章（LEFT JOIN，价格异动事件 source_id 为 NULL） + 最新证据包 */
router.get('/events/:eventId/context', async (req: Request, res: Response) => {
    try {
        const eventId = param(req, 'eventId');
        const { rows } = await pool.query(
            `SELECT e.symbol, e.stock_name, e.trade_date, e.event_type, e.direction,
                    s.title, s.keywords, s.content, s.published_at, s.source_id,
                    s.source_url AS url
             FROM watchlist_insight_events e
             LEFT JOIN watchlist_insight_sources s ON s.source_id = e.source_id
             WHERE e.event_id = $1`,
            [eventId],
        );
        if (rows.length === 0) {
            res.status(404).json({ code: 404, message: 'Event not found' });
            return;
        }
        // 追加最新证据包（Python 归因侧读取 evidence_package 做多来源候选抽取）
        const pkg = await pool.query(
            `SELECT evidence FROM watchlist_evidence_packages
             WHERE event_id=$1 ORDER BY frozen_seq DESC LIMIT 1`, [eventId]);
        const evidencePackage = pkg.rows[0]?.evidence ?? [];
        res.json({ code: 200, data: { ...rows[0], evidence_package: evidencePackage } });
    } catch (error: unknown) {
        res.status(502).json({ code: 502, message: errMsg(error) });
    }
});

// ── 阶段 2.1：只读端点（insight 读层 skill 用，openid 走 query——internal 可信）──

/** 登录用户自选股洞察列表（等价前端 controller.list，openid 过滤 + 可选 symbol/limit） */
router.get('/events', async (req: Request, res: Response) => {
    const openid = queryStr(req, 'openid');
    if (!openid) {
        res.status(400).json({ code: 400, message: 'openid is required' });
        return;
    }
    const symbol = queryStr(req, 'symbol');
    const limitRaw = Number.parseInt(queryStr(req, 'limit'), 10);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 50;
    try {
        const { rows } = await pool.query(
            `SELECT e.event_id, e.symbol, e.stock_name, e.trade_date, e.event_type, e.direction, e.created_at,
                    r.attribution_status, r.confidence, r.primary_driver, r.secondary_drivers, r.display_report,
                    snap.move_bps, snap.change_pct, snap.open_price, snap.latest_price, snap.price_source
             FROM watchlist_insight_events e
             JOIN user_stocks us ON us.symbol = e.symbol AND us.openid = $1
             LEFT JOIN watchlist_insight_results r ON r.event_id = e.event_id AND r.analysis_version = 'watchlist-insight-v1'
             LEFT JOIN LATERAL (
                 SELECT move_bps, change_pct, open_price, latest_price, price_source
                 FROM watchlist_price_snapshots ps
                 WHERE ps.symbol = e.symbol AND ps.trade_date = e.trade_date
                 ORDER BY ps.snapshot_time DESC LIMIT 1
             ) snap ON true
             WHERE ($2::text IS NULL OR e.symbol = $2)
             ORDER BY e.created_at DESC LIMIT $3`,
            [openid, symbol || null, limit],
        );
        res.json({ code: 200, data: rows });
    } catch (error: unknown) {
        res.status(500).json({ code: 500, message: errMsg(error) });
    }
});

/** 登录用户自选股洞察详情（等价前端 controller.get：归属校验 + 追加最新证据包） */
router.get('/events/:eventId', async (req: Request, res: Response) => {
    const openid = queryStr(req, 'openid');
    if (!openid) {
        res.status(400).json({ code: 400, message: 'openid is required' });
        return;
    }
    const eventId = param(req, 'eventId');
    if (!eventId) {
        res.status(404).json({ code: 404, message: 'not found' });
        return;
    }
    try {
        const { rows } = await pool.query(
            `SELECT e.*, r.attribution_status, r.confidence, r.primary_driver, r.secondary_drivers,
                    r.display_report, r.podcast_brief, s.title, s.keywords, s.source_url, s.published_at,
                    snap.move_bps, snap.snap_direction, snap.open_price, snap.latest_price, snap.price_source
             FROM watchlist_insight_events e
             JOIN user_stocks us ON us.symbol = e.symbol AND us.openid = $1
             LEFT JOIN watchlist_insight_results r ON r.event_id = e.event_id AND r.analysis_version = 'watchlist-insight-v1'
             LEFT JOIN watchlist_insight_sources s ON s.source_id = e.source_id
             LEFT JOIN LATERAL (
                 SELECT move_bps, change_pct, direction AS snap_direction, open_price, latest_price, price_source
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
        const pkg = await pool.query(
            `SELECT evidence FROM watchlist_evidence_packages
             WHERE event_id=$1 ORDER BY frozen_seq DESC LIMIT 1`, [eventId]);
        res.json({ code: 200, data: { ...rows[0], evidence_package: pkg.rows[0]?.evidence ?? [] } });
    } catch (error: unknown) {
        res.status(500).json({ code: 500, message: errMsg(error) });
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

/** Python 回写归因结果（按 (event_id, analysis_version) upsert，全字段覆盖）
 *  - 首次落库（prior 无记录）：pushCreated
 *  - 更新落库且 isSubstantiveChange === true：pushUpdated
 *  - 无实质变化：不推送 */
router.post('/results/external', async (req: Request, res: Response) => {
    const body = req.body as { result?: ExternalResultInput } | undefined;
    const result = body?.result;
    if (!result || !result.event_id || !result.analysis_version) {
        res.status(400).json({ code: 400, message: 'result.event_id and result.analysis_version are required' });
        return;
    }
    try {
        // UPSERT 前读取旧记录，判断是否首次落库
        const prior = await pool.query(
            'SELECT 1 FROM watchlist_insight_results WHERE event_id=$1 AND analysis_version=$2',
            [result.event_id, result.analysis_version]);
        const isNew = prior.rows.length === 0;

        // UPSERT 前计算实质变化：INSERT 后旧值已被覆盖，此时判定将恒为 false（读到的 old 即新值）
        let changed = false;
        if (!isNew) {
            const { isSubstantiveChange } = await import('./InsightPushService');
            changed = await isSubstantiveChange(result.event_id, {
                attribution_status: result.attribution_status ?? 'unconfirmed',
                confidence: result.confidence ?? 'low',
                primary_driver: result.primary_driver || {},
            });
        }

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
        if (isNew) {
            void import('./InsightPushService').then(m => m.pushCreated(result.event_id)).catch(e =>
                console.error('[insight] push created failed', e));
        } else if (changed) {
            void import('./InsightPushService').then(m => m.pushUpdated(result.event_id)).catch(e =>
                console.error('[insight] push updated failed', e));
        }
        res.status(201).json({ code: 201, data: {} });
    } catch (error: unknown) {
        res.status(500).json({ code: 500, message: errMsg(error) });
    }
});

export default router;
