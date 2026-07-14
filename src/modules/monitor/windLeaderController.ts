/**
 * 风口龙头 API 控制器
 */

import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import { WindLeaderService } from './WindLeaderService';
import { WindLeaderAnalyzerService } from './WindLeaderAnalyzerService';
import { HotKeywordDetectorService } from './HotKeywordDetectorService';
import { HotBurstService } from './HotBurstService';

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'crawler-int-2026-token';

function verifyInternalToken(req: Request): boolean {
    const headerToken = req.headers['x-internal-token'];
    const bearerToken = req.headers.authorization?.replace('Bearer ', '');
    const token = String(Array.isArray(headerToken) ? headerToken[0] : headerToken || '') || bearerToken || '';
    return token === INTERNAL_TOKEN;
}

export class WindLeaderController {
    /**
     * GET /api/cn/wind-leaders
     * 获取风口龙头分析结果
     *
     * Query params:
     *   - limit: 返回的风口板块数量，默认8
     */
    static async getWindLeaders(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const limit = Math.min(Math.max(parseInt(String(req.query.limit || '8'), 10), 1), 20);
            const data = await WindLeaderService.getAnalysis(limit);

            if (!data) {
                createResponse(res, 404, '暂无风口龙头数据，请先执行分析');
                return;
            }

            createResponse(res, 200, 'success', data);
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[WindLeaderController] getWindLeaders error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * POST /api/internal/wind-leaders
     * 内部接口：接收外部推送的风口龙头数据（兼容旧Python引擎）
     */
    static async pushWindLeaders(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            if (!verifyInternalToken(req)) {
                createResponse(res, 401, 'invalid internal token');
                return;
            }

            const data = req.body;
            if (!data || !data.hot_sectors || !Array.isArray(data.hot_sectors)) {
                createResponse(res, 400, '数据格式错误，需要包含 hot_sectors 数组');
                return;
            }

            await WindLeaderService.saveData(data);
            console.log(`[WindLeaderController] 收到风口龙头数据推送，共 ${data.hot_sectors.length} 个板块，更新时间: ${data.update_time || '未知'}`);
            createResponse(res, 200, 'success', { count: data.hot_sectors.length, update_time: data.update_time });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[WindLeaderController] pushWindLeaders error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * POST /api/cn/wind-leaders/refresh
     * 使用TS版分析引擎重新执行风口龙头分析（已替代Python引擎）
     */
    static async refreshAnalysis(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            // 非交易日警告（不阻止执行，但提示调用方）
            const { isAShareTradingDay } = await import('../../shared/utils/tradingTime');
            const isTradingDay = await isAShareTradingDay();
            if (!isTradingDay) {
                console.warn('[WindLeaderController] 当前为非交易日，风口龙头分析可能产生空结果');
            }

            console.log('[WindLeaderController] 触发TS分析引擎重新分析...');
            const result = await WindLeaderAnalyzerService.runFullAnalysis();

            if (result.hot_sectors.length === 0) {
                createResponse(res, 200, '分析完成但未产生风口数据（可能为非交易日或外部API无数据），已保留上次有效数据', {
                    count: 0,
                    update_time: result.update_time || '',
                    trading_day: isTradingDay,
                });
                return;
            }

            createResponse(res, 200, 'success', {
                count: result.hot_sectors?.length || 0,
                update_time: result.update_time || '',
                trading_day: isTradingDay,
            });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[WindLeaderController] refreshAnalysis error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * POST /api/cn/hot-keywords/detect
     * 手动触发关键词爆发检测
     */
    static async detectHotKeywords(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const hotKeywords = await HotKeywordDetectorService.detectHotKeywords();
            createResponse(res, 200, 'success', { count: hotKeywords.length, keywords: hotKeywords });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[WindLeaderController] detectHotKeywords error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * GET /api/cn/hot-keywords
     * 查询最近爆发关键词
     *
     * Query params:
     *   - hours: 查询最近N小时，默认6
     *   - limit: 返回数量，默认20
     */
    static async getHotKeywords(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const hours = Math.min(Math.max(parseInt(String(req.query.hours || '6'), 10), 1), 72);
            const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10), 1), 100);
            const keywords = await HotKeywordDetectorService.getRecentHotKeywords(hours, limit);
            createResponse(res, 200, 'success', { count: keywords.length, keywords });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[WindLeaderController] getHotKeywords error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * POST /api/cn/institution-research/detect
     * 执行三步机构调研推荐热门股检测（关键词爆发+飞书消息+同花顺验证）
     */
    static async detectHotBurst(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const result = await HotBurstService.detectHotBurst();
            createResponse(res, 200, 'success', result);
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[WindLeaderController] detectHotBurst error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * GET /api/cn/institution-research
     * 查询最近机构调研推荐热门股检测结果
     * 默认返回三源共振及以上（resonanceCount >= 3）的信号（min_resonance=3）
     */
    static async getHotBurst(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const hours = Math.min(Math.max(parseInt(String(req.query.hours || '6'), 10), 1), 72);
            const minResonance = parseInt(String(req.query.min_resonance || '3'), 10);
            const result = await HotBurstService.getRecentBursts(hours, minResonance);
            if (!result) {
                createResponse(res, 404, '暂无机构调研推荐热门股检测数据');
                return;
            }
            createResponse(res, 200, 'success', result);
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[WindLeaderController] getHotBurst error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * GET /api/cn/institution-research/latest
     * 从 DB 直接获取最新的机构调研推荐热门股（轻量查询，不触发检测）
     * 供首页 HotBurstPanel 使用
     */
    static async getLatestRecords(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const limit = Math.min(Math.max(parseInt(String(req.query.limit || '5'), 10), 1), 20);
            const result = await HotBurstService.getLatestFromDB(limit);
            if (!result) {
                createResponse(res, 404, '暂无机构调研推荐热门股数据');
                return;
            }
            createResponse(res, 200, 'success', result);
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[WindLeaderController] getLatestRecords error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * GET /api/cn/institution-research/history
     * 查询历史机构调研推荐热门股记录
     * 默认仅返回三源共振及以上（resonance_count >= 3）的记录（min_resonance_only=true）
     */
    static async getHotBurstHistory(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10), 1), 200);
            const offset = Math.max(parseInt(String(req.query.offset || '0'), 10), 0);
            const minResonanceOnly = String(req.query.min_resonance_only) !== 'false';
            const result = await HotBurstService.getHistory(limit, offset, minResonanceOnly);
            createResponse(res, 200, 'success', result);
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[WindLeaderController] getHotBurstHistory error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }
}
