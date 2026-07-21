import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import { TrendScoreService } from './TrendScoreService';
import { VetoError } from './TenxScoreService';
import pool from '../../core/db';

/** 安全解析 jsonb 字段：pg 驱动已将 jsonb 解析为 JS 对象，无需再 JSON.parse */
function parseJsonb(val: unknown): unknown[] {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
        try { return JSON.parse(val); } catch { return []; }
    }
    return [];
}

export class TrendScoreController {
    static async getScore(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = String(req.params.symbol || '');

        try {
            const result = await pool.query(
                'SELECT * FROM trend_scores WHERE symbol = $1 ORDER BY score_date DESC LIMIT 1',
                [symbol],
            );

            if (result.rows.length === 0) {
                try {
                    const calcResult = await TrendScoreService.calculateTrendScore(symbol);
                    TrendScoreController.saveToDB(symbol, calcResult).catch(() => {});
                    const { rawData, ...response } = calcResult;
                    createResponse(res, 200, 'success (computed)', response);
                } catch (calcError: unknown) {
                    if (calcError instanceof VetoError) {
                        createResponse(res, 200, 'vetoed', {
                            vetoed: true,
                            symbol: calcError.symbol,
                            reasons: calcError.reasons,
                            avgAmount: calcError.avgAmount,
                            isSt: calcError.isSt,
                        });
                    } else {
                        createResponse(res, 500, calcError instanceof Error ? calcError.message : '查询评分失败');
                    }
                }
                return;
            }

            const row = result.rows[0] as Record<string, unknown>;
            const data = {
                symbol: row.symbol,
                score: Number(row.score),
                scoreDate: row.score_date,
                label: row.label,
                expectedMultiple: row.expected_multiple,
                description: row.description,
                aiConclusion: row.ai_conclusion,
                dimScores: parseJsonb(row.dim_scores),
                dimensions: parseJsonb(row.dimensions),
                updatedAt: row.updated_at,
            };

            createResponse(res, 200, 'success', data);
        } catch (error: unknown) {
            try {
                const calcResult = await TrendScoreService.calculateTrendScore(symbol);
                TrendScoreController.saveToDB(symbol, calcResult).catch(() => {});
                const { rawData, ...response } = calcResult;
                createResponse(res, 200, 'success (computed)', response);
            } catch (calcError: unknown) {
                if (calcError instanceof VetoError) {
                    createResponse(res, 200, 'vetoed', {
                        vetoed: true,
                        symbol: calcError.symbol,
                        reasons: calcError.reasons,
                        avgAmount: calcError.avgAmount,
                        isSt: calcError.isSt,
                    });
                } else {
                    createResponse(res, 500, calcError instanceof Error ? calcError.message : '查询评分失败');
                }
            }
        }
    }

    static async getDetail(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = String(req.params.symbol || '');

        try {
            const result = await pool.query(
                'SELECT * FROM trend_scores WHERE symbol = $1 ORDER BY score_date DESC LIMIT 1',
                [symbol],
            );

            if (result.rows.length > 0) {
                const row = result.rows[0] as Record<string, unknown>;
                const data = {
                    symbol: row.symbol,
                    score: Number(row.score),
                    scoreDate: row.score_date,
                    label: row.label,
                    expectedMultiple: row.expected_multiple,
                    description: row.description,
                    aiConclusion: row.ai_conclusion,
                    dimScores: parseJsonb(row.dim_scores),
                    dimensions: parseJsonb(row.dimensions),
                    updatedAt: row.updated_at,
                };
                createResponse(res, 200, 'success', data);
            } else {
                // 没有缓存，实时计算
                const calcResult = await TrendScoreService.calculateTrendScore(symbol);
                TrendScoreController.saveToDB(symbol, calcResult).catch(() => {});
                const { rawData, ...response } = calcResult;
                createResponse(res, 200, 'success (computed)', response);
            }
        } catch (error: unknown) {
            if (error instanceof VetoError) {
                createResponse(res, 200, 'vetoed', {
                    vetoed: true, symbol: error.symbol, reasons: error.reasons,
                    avgAmount: error.avgAmount, isSt: error.isSt,
                });
            } else {
                createResponse(res, 500, error instanceof Error ? error.message : '查询详情失败');
            }
        }
    }

    static async refreshScore(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = String(req.params.symbol || '');

        try {
            const result = await TrendScoreService.calculateTrendScore(symbol);
            TrendScoreController.saveToDB(symbol, result).catch(() => {});
            const { rawData, ...response } = result;
            createResponse(res, 200, 'success (refreshed)', response);
        } catch (error: unknown) {
            if (error instanceof VetoError) {
                createResponse(res, 200, 'vetoed', {
                    vetoed: true, symbol: error.symbol, reasons: error.reasons,
                    avgAmount: error.avgAmount, isSt: error.isSt,
                });
            } else {
                createResponse(res, 500, error instanceof Error ? error.message : '刷新评分失败');
            }
        }
    }

    static async getTopStocks(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const limit = Math.min(200, Math.max(1, Number(req.query.limit || '50')));
        try {
            const result = await pool.query(`
                SELECT t.symbol, t.score, t.label, t.expected_multiple, t.score_date,
                       t.dim_scores, t.description,
                       COALESCE(s.name, '') as name,
                       COALESCE(s.industry, '') as industry
                FROM trend_scores t
                LEFT JOIN stocks s ON t.symbol = s.symbol
                WHERE t.score_date = (
                    SELECT MAX(t2.score_date) FROM trend_scores t2
                )
                AND t.label NOT IN ('D')
                AND (t.ma60_excluded IS NULL OR t.ma60_excluded = false)
                ORDER BY t.score DESC
                LIMIT $1
            `, [limit]);

            const items = result.rows.map((r: Record<string, unknown>) => ({
                symbol: r.symbol,
                name: r.name,
                industry: r.industry,
                score: Number(r.score),
                label: r.label,
                expectedMultiple: r.expected_multiple,
                scoreDate: r.score_date,
                dimScores: parseJsonb(r.dim_scores),
                description: r.description,
            }));

            createResponse(res, 200, 'success', items);
        } catch (error: unknown) {
            createResponse(res, 500, error instanceof Error ? error.message : '查询Top列表失败');
        }
    }

    static async batchRefresh(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbols: string[] = req.body?.symbols || [];
        if (!Array.isArray(symbols) || symbols.length === 0) {
            createResponse(res, 400, '请提供股票代码列表');
            return;
        }

        const results: Record<string, unknown>[] = [];
        let successCount = 0;

        for (const symbol of symbols) {
            try {
                const result = await TrendScoreService.calculateTrendScore(symbol);
                await TrendScoreController.saveToDB(symbol, result);
                results.push({ symbol, success: true, score: result.score, label: result.label });
                successCount++;
            } catch (error: unknown) {
                if (error instanceof VetoError) {
                    results.push({ symbol, success: false, vetoed: true, reasons: error.reasons });
                } else {
                    results.push({ symbol, success: false, error: error instanceof Error ? error.message : '未知错误' });
                }
            }
        }

        createResponse(res, 200, '批量评分完成', {
            total: symbols.length,
            success: successCount,
            failed: symbols.length - successCount,
            results,
        });
    }

    private static async saveToDB(symbol: string, result: { score: number; label: string; expectedMultiple: string; description: string; aiConclusion: string; dimScores: number[]; dimensions: unknown[]; rawData: unknown; ma60Excluded: boolean; updatedAt: string }): Promise<void> {
        const today = new Date().toISOString().slice(0, 10);
        const rawDataJson = result.rawData ? JSON.stringify(result.rawData) : null;

        try {
            await pool.query(`
                INSERT INTO trend_scores
                    (symbol, score_date, score, label, expected_multiple, description, ai_conclusion, dim_scores, dimensions, raw_data, ma60_excluded, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT (symbol, score_date) DO UPDATE SET
                    score = EXCLUDED.score,
                    label = EXCLUDED.label,
                    expected_multiple = EXCLUDED.expected_multiple,
                    description = EXCLUDED.description,
                    ai_conclusion = EXCLUDED.ai_conclusion,
                    dim_scores = EXCLUDED.dim_scores,
                    dimensions = EXCLUDED.dimensions,
                    raw_data = EXCLUDED.raw_data,
                    ma60_excluded = EXCLUDED.ma60_excluded,
                    updated_at = EXCLUDED.updated_at
            `, [
                symbol, today, result.score, result.label, result.expectedMultiple,
                result.description, result.aiConclusion, JSON.stringify(result.dimScores),
                JSON.stringify(result.dimensions), rawDataJson, result.ma60Excluded, result.updatedAt,
            ]);
        } catch {
            try {
                await pool.query(`
                    INSERT INTO trend_scores
                        (symbol, score_date, score, label, expected_multiple, description, ai_conclusion, dim_scores, dimensions, ma60_excluded, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    ON CONFLICT (symbol, score_date) DO UPDATE SET
                        score = EXCLUDED.score,
                        label = EXCLUDED.label,
                        expected_multiple = EXCLUDED.expected_multiple,
                        description = EXCLUDED.description,
                        ai_conclusion = EXCLUDED.ai_conclusion,
                        dim_scores = EXCLUDED.dim_scores,
                        dimensions = EXCLUDED.dimensions,
                        ma60_excluded = EXCLUDED.ma60_excluded,
                        updated_at = EXCLUDED.updated_at
                `, [
                    symbol, today, result.score, result.label, result.expectedMultiple,
                    result.description, result.aiConclusion, JSON.stringify(result.dimScores),
                    JSON.stringify(result.dimensions), result.ma60Excluded, result.updatedAt,
                ]);
            } catch {}
        }
    }
}
