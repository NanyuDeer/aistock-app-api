import { Router, type Request, type Response } from 'express';
import { shanghaiDateStr } from '../../shared/utils/shanghaiTime';
import { PriceTriggerDetector } from './PriceTriggerDetector';
import { StockTraceService } from './StockTraceService';
import { StockTraceSnapshotService } from './StockTraceSnapshotService';
import { StockTraceResultService, type ExternalResultInput } from './StockTraceResultService';
import { StockTraceArtifactService } from './StockTraceArtifactService';
import { StockTraceJobService } from './StockTraceJobService';
import type { FavoriteSecurity, PriceFact } from './types';

const router: Router = Router();
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

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

router.post('/detect', async (_req: Request, res: Response) => {
    await PriceTriggerDetector.runOnce();
    res.json({ code: 200, data: { accepted: true } });
});

router.post('/jobs/publish', async (req: Request, res: Response) => {
    const body = req.body as { limit?: number };
    const result = await StockTraceJobService.publishPending(body.limit);
    res.json({ code: 200, data: result });
});

// ── 阶段 2.2：只读列表端点（个股溯源读层 skill 用，openid 走 query——internal 可信）──
/** 登录用户自选股异动溯源列表（复用 listUserEvents：openid 过滤 + analysis_status/primary_cause） */
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
        // 统一账户模型（master）后 listUserEvents(id, openid, limit, cursor?)：id 走 uuid user_id，
        // internal 场景只有 openid，传空串触发 scopeWhere 的 openid 兜底分支（老微信数据）。
        const { items } = await StockTraceService.listUserEvents('', openid, limit);
        const data = symbol ? items.filter((i) => i.symbol === symbol) : items;
        res.json({ code: 200, data });
    } catch (error: unknown) {
        res.status(500).json({ code: 500, message: errMsg(error) });
    }
});

router.patch('/jobs/:jobId', async (req: Request, res: Response) => {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
    const body = req.body as { status?: 'queued' | 'published' | 'processing' | 'completed' | 'failed' | 'dead_letter'; last_error_code?: string; increment_attempt?: boolean };
    if (!jobId || !body.status) {
        res.status(400).json({ code: 400, message: 'job id and status are required' });
        return;
    }
    const result = await StockTraceJobService.reportStatus(jobId, body.status, {
        lastErrorCode: body.last_error_code,
        incrementAttempt: body.increment_attempt,
    });
    if (!result) {
        res.status(404).json({ code: 404, message: 'Job not found' });
        return;
    }
    res.json({ code: 200, data: result });
});

router.get('/events/:eventId', async (req: Request, res: Response) => {
    const eventId = Array.isArray(req.params.eventId) ? req.params.eventId[0] : req.params.eventId;
    const result = await StockTraceService.getInternalEvent(eventId || '');
    if (!result) {
        res.status(404).json({ code: 404, message: 'Event not found' });
        return;
    }
    res.json({ code: 200, data: result });
});

router.get('/events/:eventId/analysis-context', async (req: Request, res: Response) => {
    const eventId = Array.isArray(req.params.eventId) ? req.params.eventId[0] : req.params.eventId;
    const revision = Number(req.query.trigger_revision);
    if (!eventId || !Number.isInteger(revision) || revision < 1) {
        res.status(400).json({ code: 400, message: 'valid trigger_revision is required' });
        return;
    }
    const context = await StockTraceSnapshotService.getAnalysisContext(eventId, revision);
    if (!context) {
        res.status(409).json({ code: 409, message: 'Snapshot is not ready' });
        return;
    }
    res.json({ code: 200, data: context });
});

router.post('/events', async (req: Request, res: Response) => {
    const body = req.body as Partial<FavoriteSecurity & PriceFact>;
    const latestPrice = Number(body.latestPrice);
    const previousClose = Number(body.previousClose);
    const changePct = Number(body.changePct);
    if (!body.symbol || !Number.isFinite(latestPrice) || !Number.isFinite(previousClose) || !Number.isFinite(changePct)) {
        res.status(400).json({ code: 400, message: 'symbol, latestPrice, previousClose and changePct are required' });
        return;
    }
    const observedAt = body.observedAt ? new Date(body.observedAt) : new Date();
    if (Number.isNaN(observedAt.getTime())) {
        res.status(400).json({ code: 400, message: 'observedAt is invalid' });
        return;
    }
    const security: FavoriteSecurity = {
        symbol: body.symbol,
        stockName: body.stockName || '',
        market: body.market || '',
        listDate: body.listDate || null,
    };
    const result = await StockTraceService.processPriceFact(security, {
        symbol: security.symbol,
        stockName: security.stockName,
        latestPrice,
        previousClose,
        changePct,
        observedAt,
    });
    res.status(result.mutation === 'created' ? 201 : 200).json({
        code: result.mutation === 'created' ? 201 : 200,
        data: result.event ? StockTraceService.toPublicEvent(result.event) : { mutation: result.mutation },
    });
});

router.post('/snapshots', async (req: Request, res: Response) => {
    const body = req.body as { event_id?: string; trigger_revision?: number; snapshot_stage?: 'initial' | 'enriched' | 'corrected' };
    if (!body.event_id || !['initial', 'enriched', 'corrected'].includes(body.snapshot_stage || '')) {
        res.status(400).json({ code: 400, message: 'event_id and valid snapshot_stage are required' });
        return;
    }
    const event = await StockTraceService.getTriggerEvent(body.event_id, body.trigger_revision);
    if (!event) {
        res.status(404).json({ code: 404, message: 'Event revision not found' });
        return;
    }
    const snapshot = body.snapshot_stage === 'initial'
        ? await StockTraceSnapshotService.captureInitial(event)
        : body.snapshot_stage === 'corrected'
            ? await StockTraceSnapshotService.captureCorrected(event)
            : await StockTraceSnapshotService.captureEnriched(event);
    res.status(201).json({ code: 201, data: snapshot });
});

router.get('/snapshots/:snapshotId', async (req: Request, res: Response) => {
    const snapshotId = Array.isArray(req.params.snapshotId) ? req.params.snapshotId[0] : req.params.snapshotId;
    const snapshot = await StockTraceSnapshotService.getSnapshot(snapshotId || '');
    if (!snapshot) {
        res.status(404).json({ code: 404, message: 'Snapshot not found' });
        return;
    }
    res.json({ code: 200, data: snapshot });
});

router.post('/results', async (req: Request, res: Response) => {
    const body = req.body as { snapshot_id?: string; analysis_version?: string };
    if (!body.snapshot_id) {
        res.status(400).json({ code: 400, message: 'snapshot_id is required' });
        return;
    }
    try {
        const result = await StockTraceResultService.generateForSnapshot(body.snapshot_id, body.analysis_version);
        const artifact = await StockTraceArtifactService.publishForResult(result.resultId);
        res.status(201).json({ code: 201, data: { result, artifact } });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Result generation failed';
        res.status(message === 'snapshot_not_found' ? 404 : 422).json({ code: message === 'snapshot_not_found' ? 404 : 422, message });
    }
});

router.post('/results/external', async (req: Request, res: Response) => {
    const body = req.body as { result?: ExternalResultInput };
    if (!body.result) {
        res.status(400).json({ code: 400, message: 'result is required' });
        return;
    }
    try {
        const result = await StockTraceResultService.acceptExternalResult(body.result);
        const artifact = await StockTraceArtifactService.publishForResult(result.resultId);
        res.status(artifact ? 201 : 422).json({
            code: artifact ? 201 : 422,
            data: { result, artifact },
            message: artifact ? undefined : 'External result was rejected by validation',
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'External result writeback failed';
        res.status(message === 'snapshot_not_found' ? 404 : 422).json({ code: message === 'snapshot_not_found' ? 404 : 422, message });
    }
});

router.get('/results/:snapshotId', async (req: Request, res: Response) => {
    const snapshotId = Array.isArray(req.params.snapshotId) ? req.params.snapshotId[0] : req.params.snapshotId;
    const result = await StockTraceResultService.getBySnapshot(snapshotId || '', typeof req.query.analysis_version === 'string' ? req.query.analysis_version : undefined);
    if (!result) {
        res.status(404).json({ code: 404, message: 'Result not found' });
        return;
    }
    res.json({ code: 200, data: result });
});

router.post('/artifacts', async (req: Request, res: Response) => {
    const body = req.body as { result_id?: string };
    if (!body.result_id) {
        res.status(400).json({ code: 400, message: 'result_id is required' });
        return;
    }
    const artifact = await StockTraceArtifactService.publishForResult(body.result_id);
    if (!artifact) {
        res.status(422).json({ code: 422, message: 'Artifact requires a validated result' });
        return;
    }
    res.status(201).json({ code: 201, data: artifact });
});

router.get('/artifacts/:eventId', async (req: Request, res: Response) => {
    const eventId = Array.isArray(req.params.eventId) ? req.params.eventId[0] : req.params.eventId;
    const artifact = await StockTraceArtifactService.getEffectiveArtifact(eventId || '');
    if (!artifact) {
        res.status(404).json({ code: 404, message: 'Artifact not found' });
        return;
    }
    res.json({ code: 200, data: artifact });
});

// ── 阶段 2：轻量预判任务端点（agent-py 定时消费，2026-09-03）──

/** 当日自选股"异动/涨停 ∪ 重大利好/利空资讯"候选（symbol 去重）；trade_date 缺省为上海当日 */
router.get('/light-predict-targets', async (req: Request, res: Response) => {
    const tradeDate = queryStr(req, 'trade_date') || shanghaiDateStr(new Date());
    try {
        const targets = await StockTraceService.listLightPredictTargets(tradeDate);
        res.json({ code: 200, data: { trade_date: tradeDate, targets } });
    } catch (error: unknown) {
        res.status(500).json({ code: 500, message: errMsg(error) });
    }
});

/** 事件 forecast slot 级回写（midday/close 互不覆盖，slot 内覆盖）；事件不存在 404 */
router.patch('/events/:eventId/forecast', async (req: Request, res: Response) => {
    const eventId = Array.isArray(req.params.eventId) ? req.params.eventId[0] : req.params.eventId;
    const body = req.body as { slot?: unknown; forecast?: unknown };
    if (!eventId || (body.slot !== 'midday' && body.slot !== 'close')) {
        res.status(400).json({ code: 400, message: 'eventId and slot (midday|close) are required' });
        return;
    }
    if (!body.forecast || typeof body.forecast !== 'object' || Array.isArray(body.forecast)) {
        res.status(400).json({ code: 400, message: 'forecast object is required' });
        return;
    }
    try {
        const updated = await StockTraceService.upsertEventForecast(eventId, body.slot, body.forecast as Record<string, unknown>);
        if (!updated) {
            res.status(404).json({ code: 404, message: 'Event not found' });
            return;
        }
        res.json({ code: 200, data: { event_id: eventId, slot: body.slot } });
    } catch (error: unknown) {
        res.status(500).json({ code: 500, message: errMsg(error) });
    }
});

export default router;
