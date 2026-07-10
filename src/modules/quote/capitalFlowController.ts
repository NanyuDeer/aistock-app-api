import { Request, Response, NextFunction } from 'express';
import { getCapitalFlow, getCapitalFlowWithAi } from './TushareCapitalFlowService';
import { CacheService } from '../../shared/utils/CacheService';
import { createResponse } from '../../shared/utils/response';
import { getAShareAdaptiveCacheTtlSeconds } from '../../shared/utils/tradingTime';

const CAPITAL_FLOW_CACHE_KEY_PREFIX = 'capital_flow:';
const CAPITAL_FLOW_TRADING_TTL_SECONDS = 3 * 60;
const CAPITAL_FLOW_CLOSE_UPDATE_TIME = { hour: 19, minute: 5 };
const CAPITAL_FLOW_BATCH_CACHE_KEY = 'capital_flow:batch_status';

export class CapitalFlowController {
    static async getCapitalFlow(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const rawSymbol = req.params.symbol;
        const symbol = Array.isArray(rawSymbol) ? rawSymbol[0] : rawSymbol;
        if (!symbol || !/^\d{6}$/.test(symbol)) {
            createResponse(res, 400, 'Invalid symbol - A股代码必须是6位数字');
            return;
        }

        const cacheKey = `${CAPITAL_FLOW_CACHE_KEY_PREFIX}${symbol}`;
        try {
            const cached = await CacheService.get<Record<string, any>>(cacheKey);
            if (cached) {
                createResponse(res, 200, 'success (cached)', cached);
                return;
            }
        } catch {}

        try {
            const data = await getCapitalFlowWithAi(symbol);
            try {
                const ttl = await getAShareAdaptiveCacheTtlSeconds(CAPITAL_FLOW_TRADING_TTL_SECONDS, { afterCloseUpdateTime: CAPITAL_FLOW_CLOSE_UPDATE_TIME });
                await CacheService.put(cacheKey, data as unknown as Record<string, any>, ttl);
            } catch {
                await CacheService.put(cacheKey, data as unknown as Record<string, any>, CAPITAL_FLOW_TRADING_TTL_SECONDS);
            }
            createResponse(res, 200, 'success', data);
        } catch (err: any) {
            const message = err instanceof Error ? err.message : '获取资金流向数据失败';
            console.error(`[CapitalFlow] ${symbol} error:`, message);
            createResponse(res, 500, message);
        }
    }

    static async batchPrefetch(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbolsParam = req.query.symbols as string;
        const force = req.query.force === '1';
        const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);

        let symbols: string[] = [];
        if (symbolsParam) {
            symbols = symbolsParam.split(',').filter(s => /^\d{6}$/.test(s.trim())).map(s => s.trim());
        }
        if (symbols.length === 0) {
            try {
                const pool = (await import('../../core/db')).default;
                const result = await pool.query('SELECT symbol FROM stocks ORDER BY symbol LIMIT $1', [limit]);
                symbols = result.rows.map((r: any) => r.symbol as string);
            } catch {
                createResponse(res, 500, '获取股票列表失败');
                return;
            }
        }

        createResponse(res, 200, `批量预取已启动，共${symbols.length}只股票`, { total: symbols.length, force });

        setImmediate(async () => {
            let success = 0, skipped = 0, failed = 0;
            for (const symbol of symbols) {
                try {
                    const cacheKey = `${CAPITAL_FLOW_CACHE_KEY_PREFIX}${symbol}`;
                    if (!force) {
                        const cached = await CacheService.get(cacheKey);
                        if (cached) { skipped++; continue; }
                    }
                    const data = await getCapitalFlow(symbol);
                    const ttl = await getAShareAdaptiveCacheTtlSeconds(CAPITAL_FLOW_TRADING_TTL_SECONDS, { afterCloseUpdateTime: CAPITAL_FLOW_CLOSE_UPDATE_TIME });
                    await CacheService.put(cacheKey, data as unknown as Record<string, any>, ttl);
                    success++;
                } catch (err: any) {
                    failed++;
                    console.error(`[CapitalFlowBatch] ${symbol} error:`, err?.message || err);
                }
            }
            console.log(`[CapitalFlowBatch] 完成: 成功=${success}, 跳过=${skipped}, 失败=${failed}`);
            try {
                await CacheService.put(CAPITAL_FLOW_BATCH_CACHE_KEY, {
                    lastRun: new Date().toISOString(),
                    total: symbols.length,
                    success, skipped, failed,
                }, 24 * 60 * 60);
            } catch {}
        });
    }

    static async getBatchStatus(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const status = await CacheService.get<Record<string, any>>(CAPITAL_FLOW_BATCH_CACHE_KEY);
            createResponse(res, 200, 'success', status || { lastRun: null });
        } catch {
            createResponse(res, 200, 'success', { lastRun: null });
        }
    }
}
