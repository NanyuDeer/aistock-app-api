/**
 * 恐贪指数 REST 路由 handlers（对齐原 Python FastAPI /api/fear-greed/*）。
 */
import { Router, type Request, type Response } from 'express';
import { createResponse } from '../../shared/utils/response';
import { buildDashboard, getHistory, getLatestJq, refreshJq } from './FearGreedService';

/** GET /api/fear-greed/dashboard?index=jq — 首页主面板数据 */
export async function dashboard(req: Request, res: Response): Promise<void> {
    const index = String(req.query.index ?? 'jq');
    if (index !== 'jq') {
        createResponse(res, 400, 'index 只支持 jq（韭圈儿）');
        return;
    }
    try {
        const data = await buildDashboard();
        createResponse(res, 200, 'success', data);
    } catch (err) {
        console.error('[FearGreed] dashboard failed:', err instanceof Error ? err.message : String(err));
        createResponse(res, 500, `指数计算失败: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** GET /api/fear-greed/indexes — 两套指数最新值（当前仅 jq） */
export async function indexes(_req: Request, res: Response): Promise<void> {
    try {
        const data = await getLatestJq();
        createResponse(res, 200, 'success', { jq: data });
    } catch (err) {
        console.error('[FearGreed] indexes failed:', err instanceof Error ? err.message : String(err));
        createResponse(res, 500, `指数计算失败: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** GET /api/fear-greed/history?index=jq&days=60 — 历史走势 */
export async function history(req: Request, res: Response): Promise<void> {
    const index = String(req.query.index ?? 'jq');
    if (index !== 'jq') {
        createResponse(res, 400, 'index 只支持 jq（韭圈儿）');
        return;
    }
    const days = Math.min(Math.max(Number(req.query.days ?? 60), 1), 500);
    try {
        const data = await getHistory(days);
        createResponse(res, 200, 'success', data);
    } catch (err) {
        console.error('[FearGreed] history failed:', err instanceof Error ? err.message : String(err));
        createResponse(res, 500, `历史查询失败: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** POST /api/fear-greed/refresh — 强制刷新（重新采集 + 计算 + 落库） */
export async function refresh(_req: Request, res: Response): Promise<void> {
    try {
        const data = await refreshJq();
        createResponse(res, 200, 'success', data);
    } catch (err) {
        console.error('[FearGreed] refresh failed:', err instanceof Error ? err.message : String(err));
        createResponse(res, 500, `刷新失败: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * 恐贪指数公开路由（无需鉴权，前端温度计/主面板调用）。
 * 需在 index.ts 挂载到 /api/fear-greed（此前漏挂，导致前端恒 404、退化为默认值）。
 */
export const fearGreedRouter: Router = Router();
fearGreedRouter.get('/dashboard', dashboard);
fearGreedRouter.get('/indexes', indexes);
fearGreedRouter.get('/history', history);
fearGreedRouter.post('/refresh', refresh);
