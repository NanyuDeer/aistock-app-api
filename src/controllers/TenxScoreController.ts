import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../utils/response';
import { TenxScoreService } from '../services/TenxScoreService';
import { VetoError, vetoCheck } from '../services/TenxScoreService';
import { TenxBatchService } from '../services/TenxBatchService';
import pool from '../db';

export class TenxScoreController {
    static async getScore(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = String(req.params.symbol || '');

        try {
            const result = await pool.query(
                'SELECT * FROM tenx_scores WHERE symbol = $1 ORDER BY score_date DESC LIMIT 1',
                [symbol],
            );

            if (result.rows.length === 0) {
                try {
                    const calcResult = await TenxScoreService.calculateTenxScore(symbol);
                    TenxScoreController.saveToDB(symbol, calcResult).catch(() => {});
                    const { rawData, ...response } = calcResult;
                    createResponse(res, 200, 'success (computed)', response);
                } catch (calcError: any) {
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

            const row = result.rows[0] as any;
            const data = {
                ...row,
                dim_scores: JSON.parse(row.dim_scores || '[]'),
                indicators: JSON.parse(row.indicators || '[]'),
            };
            delete data.raw_data;

            createResponse(res, 200, 'success', data);
        } catch (error: any) {
            try {
                const calcResult = await TenxScoreService.calculateTenxScore(symbol);
                TenxScoreController.saveToDB(symbol, calcResult).catch(() => {});
                const { rawData, ...response } = calcResult;
                createResponse(res, 200, 'success (computed)', response);
            } catch (calcError: any) {
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

    static async getScoreHistory(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = String(req.params.symbol || '');
        const page = Math.max(1, Number(req.query.page || '1'));
        const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || '20')));
        const offset = (page - 1) * pageSize;

        try {
            const countResult = await pool.query(
                'SELECT COUNT(*) as total FROM tenx_scores WHERE symbol = $1',
                [symbol],
            );
            const total = Number(countResult.rows[0]?.total) || 0;

            const dataResult = await pool.query(
                'SELECT * FROM tenx_scores WHERE symbol = $1 ORDER BY score_date DESC LIMIT $2 OFFSET $3',
                [symbol, pageSize, offset],
            );

            const items = dataResult.rows.map((r: any) => {
                const item = {
                    ...r,
                    dim_scores: JSON.parse(r.dim_scores || '[]'),
                    indicators: JSON.parse(r.indicators || '[]'),
                };
                delete item.raw_data;
                return item;
            });

            createResponse(res, 200, 'success', { total, page, pageSize, items });
        } catch (error: any) {
            createResponse(res, 500, error instanceof Error ? error.message : '查询历史评分失败');
        }
    }

    static async refreshScore(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = String(req.params.symbol || '');
        const mode = String(req.query.mode || '');

        try {
            let cachedStaticData: any = undefined;

            if (mode === 'quick') {
                try {
                    const cached = await pool.query(
                        'SELECT raw_data FROM tenx_scores WHERE symbol = $1 ORDER BY score_date DESC LIMIT 1',
                        [symbol],
                    );
                    if (cached.rows[0]?.raw_data) {
                        cachedStaticData = JSON.parse(cached.rows[0].raw_data);
                    }
                } catch {}
            }

            const result = await TenxScoreService.calculateTenxScore(symbol, undefined, cachedStaticData);
            TenxScoreController.saveToDB(symbol, result).catch(() => {});

            const { rawData, ...response } = result;
            createResponse(res, 200, mode === 'quick' ? 'success (quick refreshed)' : 'success (refreshed)', response);
        } catch (error: any) {
            if (error instanceof VetoError) {
                createResponse(res, 200, 'vetoed', {
                    vetoed: true,
                    symbol: error.symbol,
                    reasons: error.reasons,
                    avgAmount: error.avgAmount,
                    isSt: error.isSt,
                });
            } else {
                createResponse(res, 500, error instanceof Error ? error.message : '刷新评分失败');
            }
        }
    }

    static async batchRefresh(req: Request, res: Response, _next: NextFunction): Promise<void> {
        let symbols: string[] = [];
        let mode: string | null = null;
        try {
            const body = req.body;
            symbols = body.symbols || [];
            mode = body.mode || null;
        } catch {
            createResponse(res, 400, '请求体格式错误，需要 { symbols: string[] }');
            return;
        }

        if (symbols.length === 0) {
            createResponse(res, 400, 'symbols不能为空');
            return;
        }
        if (symbols.length > 50) {
            createResponse(res, 400, '单次批量评分不超过50只股票');
            return;
        }

        const results: { symbol: string; success: boolean; data?: any; error?: string }[] = [];
        const interval = mode === 'quick' ? 1000 : 2000;

        for (let i = 0; i < symbols.length; i++) {
            const sym = symbols[i];
            try {
                let cachedStaticData: any = undefined;
                if (mode === 'quick') {
                    try {
                        const cached = await pool.query(
                            'SELECT raw_data FROM tenx_scores WHERE symbol = $1 ORDER BY score_date DESC LIMIT 1',
                            [sym],
                        );
                        if (cached.rows[0]?.raw_data) {
                            cachedStaticData = JSON.parse(cached.rows[0].raw_data);
                        }
                    } catch {}
                }

                const result = await TenxScoreService.calculateTenxScore(sym, undefined, cachedStaticData);
                TenxScoreController.saveToDB(sym, result).catch(() => {});
                const { rawData, ...response } = result;
                results.push({ symbol: sym, success: true, data: response });
            } catch (error: any) {
                results.push({ symbol: sym, success: false, error: error instanceof Error ? error.message : '评分计算失败' });
            }

            if (i < symbols.length - 1) {
                await new Promise(resolve => setTimeout(resolve, interval));
            }
        }

        const successCount = results.filter(r => r.success).length;
        createResponse(res, 200, `批量评分完成: ${successCount}/${symbols.length} 成功`, {
            total: symbols.length,
            success: successCount,
            failed: symbols.length - successCount,
            results,
        });
    }

    private static async saveToDB(symbol: string, result: any): Promise<void> {
        const today = new Date().toISOString().slice(0, 10);
        const rawDataJson = result.rawData ? JSON.stringify(result.rawData) : null;

        try {
            await pool.query(`
                INSERT INTO tenx_scores
                    (symbol, score_date, score, label, expected_multiple, description, ai_conclusion, dim_scores, indicators, raw_data, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                ON CONFLICT (symbol, score_date) DO UPDATE SET
                    score = EXCLUDED.score,
                    label = EXCLUDED.label,
                    expected_multiple = EXCLUDED.expected_multiple,
                    description = EXCLUDED.description,
                    ai_conclusion = EXCLUDED.ai_conclusion,
                    dim_scores = EXCLUDED.dim_scores,
                    indicators = EXCLUDED.indicators,
                    raw_data = EXCLUDED.raw_data,
                    updated_at = EXCLUDED.updated_at
            `, [
                symbol, today, result.score, result.label, result.expectedMultiple,
                result.description, result.aiConclusion, JSON.stringify(result.dimScores),
                JSON.stringify(result.dimensions), rawDataJson, result.updatedAt,
            ]);
        } catch {
            try {
                await pool.query(`
                    INSERT INTO tenx_scores
                        (symbol, score_date, score, label, expected_multiple, description, ai_conclusion, dim_scores, indicators, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    ON CONFLICT (symbol, score_date) DO UPDATE SET
                        score = EXCLUDED.score,
                        label = EXCLUDED.label,
                        expected_multiple = EXCLUDED.expected_multiple,
                        description = EXCLUDED.description,
                        ai_conclusion = EXCLUDED.ai_conclusion,
                        dim_scores = EXCLUDED.dim_scores,
                        indicators = EXCLUDED.indicators,
                        updated_at = EXCLUDED.updated_at
                `, [
                    symbol, today, result.score, result.label, result.expectedMultiple,
                    result.description, result.aiConclusion, JSON.stringify(result.dimScores),
                    JSON.stringify(result.dimensions), result.updatedAt,
                ]);
            } catch {}
        }
    }

    static async rebuildAll(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        const startTime = Date.now();
        TenxBatchService.run(true)
            .then(() => console.log(`[TenxScore] rebuildAll 完成, 耗时${((Date.now() - startTime) / 1000).toFixed(1)}秒`))
            .catch(err => console.error('[TenxScore] rebuildAll failed:', err?.message || err));
        createResponse(res, 200, '全量重算已启动，后台执行中，预计1-2分钟完成');
    }

    /** 独立的一票否决检查接口 */
    static async checkVeto(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = String(req.params.symbol || '');
        try {
            const result = await vetoCheck(symbol);
            createResponse(res, 200, 'success', result);
        } catch (error: any) {
            createResponse(res, 500, error instanceof Error ? error.message : '否决检查失败');
        }
    }

    /** 获取评分Top30股票列表（按分数降序） */
    static async getTopStocks(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const limit = Math.min(50, Math.max(1, Number(req.query.limit || '30')));
        try {
            const result = await pool.query(`
                SELECT t.symbol, t.score, t.label, t.expected_multiple, t.score_date,
                       t.dim_scores, t.description,
                       COALESCE(s.name, '') as name,
                       COALESCE(s.industry, '') as industry
                FROM tenx_scores t
                LEFT JOIN stocks s ON t.symbol = s.symbol
                WHERE t.score_date = (
                    SELECT MAX(t2.score_date) FROM tenx_scores t2
                )
                AND t.label NOT IN ('D')
                ORDER BY t.score DESC
                LIMIT $1
            `, [limit]);

            const items = result.rows.map((r: any) => ({
                symbol: r.symbol,
                name: r.name,
                industry: r.industry,
                score: Number(r.score),
                label: r.label,
                expectedMultiple: r.expected_multiple,
                scoreDate: r.score_date,
                dimScores: JSON.parse(r.dim_scores || '[]'),
                description: r.description,
            }));

            createResponse(res, 200, 'success', items);
        } catch (error: any) {
            createResponse(res, 500, error instanceof Error ? error.message : '获取Top股票失败');
        }
    }
}
