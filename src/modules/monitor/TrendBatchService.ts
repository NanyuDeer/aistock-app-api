import pool from '../../core/db';
import { TrendScoreService } from './TrendScoreService';
import { ensureCacheBuilt } from './RotationBoardCache';

export class TrendBatchService {
    static async run(force: boolean = false): Promise<void> {
        const today = new Date().toISOString().slice(0, 10);
        console.log(`[TrendBatch] 开始批量趋势股评分, force=${force}, date=${today}`);

        // 预热板块轮动反向缓存（~112次 ths_member 调用，覆盖全市股票）
        console.log('[TrendBatch] 预热板块轮动反向缓存...');
        await ensureCacheBuilt();

        // 获取所有股票代码
        const stocksResult = await pool.query('SELECT symbol FROM stocks ORDER BY symbol');
        const symbols: string[] = stocksResult.rows.map((r: Record<string, unknown>) => r.symbol as string);

        let successCount = 0;
        let skipCount = 0;
        let failCount = 0;

        for (const symbol of symbols) {
            try {
                // 非强制模式下跳过已评分的股票
                if (!force) {
                    const existing = await pool.query(
                        'SELECT 1 FROM trend_scores WHERE symbol = $1 AND score_date = $2',
                        [symbol, today],
                    );
                    if (existing.rows.length > 0) {
                        skipCount++;
                        continue;
                    }
                }

                const result = await TrendScoreService.calculateTrendScore(symbol);
                const rawDataJson = result.rawData ? JSON.stringify(result.rawData) : null;

                await pool.query(`
                    INSERT INTO trend_scores
                        (symbol, score_date, score, label, expected_multiple, description, ai_conclusion, dim_scores, dimensions, raw_data, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    ON CONFLICT (symbol, score_date) DO UPDATE SET
                        score = EXCLUDED.score, label = EXCLUDED.label,
                        expected_multiple = EXCLUDED.expected_multiple,
                        description = EXCLUDED.description, ai_conclusion = EXCLUDED.ai_conclusion,
                        dim_scores = EXCLUDED.dim_scores, dimensions = EXCLUDED.dimensions,
                        raw_data = EXCLUDED.raw_data, updated_at = EXCLUDED.updated_at
                `, [
                    symbol, today, result.score, result.label, result.expectedMultiple,
                    result.description, result.aiConclusion, JSON.stringify(result.dimScores),
                    JSON.stringify(result.dimensions), rawDataJson, result.updatedAt,
                ]);
                successCount++;
            } catch (err) {
                failCount++;
                console.error(`[TrendBatch] ${symbol} 评分失败:`, err instanceof Error ? err.message : err);
            }
        }

        console.log(`[TrendBatch] 完成: 成功${successCount} 跳过${skipCount} 失败${failCount}`);
    }
}
