import { Router, type Request, type Response } from 'express';
import { StockInfoService } from './StockInfoService';

/**
 * crawler 模块 internal API（Python Agent 服务专用，X-Internal-Token 鉴权）。
 * 2026-09-03 起：仅重大资讯（无 stock_trace 事件）股票的轻量预判 forecast slot 回写端点。
 */
const router: Router = Router();
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

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

/** 情报事件 forecast slot 级回写（midday/close 互不覆盖）；judgement 行不存在 404 */
router.patch('/judgements/:id/forecast', async (req: Request, res: Response) => {
    const idRaw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = Number(idRaw);
    const body = req.body as { slot?: unknown; forecast?: unknown };
    if (!Number.isInteger(id) || id < 1 || (body.slot !== 'midday' && body.slot !== 'close')) {
        res.status(400).json({ code: 400, message: 'valid id and slot (midday|close) are required' });
        return;
    }
    if (!body.forecast || typeof body.forecast !== 'object' || Array.isArray(body.forecast)) {
        res.status(400).json({ code: 400, message: 'forecast object is required' });
        return;
    }
    try {
        const updated = await StockInfoService.upsertJudgementForecast(id, body.slot, body.forecast as Record<string, unknown>);
        if (!updated) {
            res.status(404).json({ code: 404, message: 'Judgement not found' });
            return;
        }
        res.json({ code: 200, data: { id, slot: body.slot } });
    } catch (error: unknown) {
        res.status(500).json({ code: 500, message: errMsg(error) });
    }
});

export default router;
