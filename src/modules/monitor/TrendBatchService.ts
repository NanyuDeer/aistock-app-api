import pool from '../../core/db';
import { TrendScoreService } from './TrendScoreService';
import { ensureCacheBuilt } from './RotationBoardCache';
import * as TushareService from '../quote/TushareService';

export interface TrendBatchResult {
    total: number;
    success: number;
    skipped: number;
    failed: number;
    prefiltered?: number;
}

/** 预筛选条件常量 */
const PREFILTER = {
    MIN_CLOSE: 2,                    // 最低股价 2 元
    MIN_AMOUNT_WAN: 3000,            // 日均成交额 ≥ 3000 万元（单位：千元，3000万 = 30000千元）
    MIN_TURNOVER_RATE: 0.3,          // 换手率 ≥ 0.3%
    MOMENTUM_DAYS: 60,               // 60 日动量检查
};

export class TrendBatchService {
    private static running = false;

    static isRunning(): boolean {
        return TrendBatchService.running;
    }

    /**
     * 阶段 1：用 bulk 接口预筛选，快速排除 ST、低流动性、低价股
     * 仅 2-3 次 API 调用即可覆盖全市场
     */
    static async prefilterStocks(): Promise<string[]> {
        console.log('[TrendBatch] === 阶段1: 预筛选 ===');

        // 找到最近的交易日（往前试 7 天）
        let latestDate = '';
        let dailyBasic: TushareService.DailyBasicFullRow[] = [];
        let dailyPrices: TushareService.DailyPriceRow[] = [];

        for (let i = 0; i <= 7; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
            try {
                const [basic, daily] = await Promise.all([
                    TushareService.getDailyBasicByDate(dateStr),
                    TushareService.getDailyByDate(dateStr),
                ]);
                if (basic.length > 0 && daily.length > 0) {
                    latestDate = dateStr;
                    dailyBasic = basic;
                    dailyPrices = daily;
                    break;
                }
            } catch (e) {
                // 继续试前一天
            }
        }

        if (dailyBasic.length === 0) {
            console.error('[TrendBatch] 预筛选失败: 无法获取近期交易日数据');
            return [];
        }

        console.log(`[TrendBatch] 预筛选数据日期: ${latestDate}, 全市场 ${dailyBasic.length} 只股票`);

        // 构建 amount 映射（daily 接口的 amount 单位：千元）
        const amountMap = new Map<string, number>();
        for (const row of dailyPrices) {
            amountMap.set(row.ts_code, row.amount);
        }

        // 构建 60 日前收盘价映射（用于动量筛选）
        const momentumDate = new Date();
        momentumDate.setDate(momentumDate.getDate() - 90); // 90 自然日 ≈ 60 交易日
        const momentumDateStr = momentumDate.toISOString().slice(0, 10).replace(/-/g, '');
        const close60dAgoMap = new Map<string, number>();
        try {
            const daily60dAgo = await TushareService.getDailyByDate(momentumDateStr);
            for (const row of daily60dAgo) {
                close60dAgoMap.set(row.ts_code, row.close);
            }
            console.log(`[TrendBatch] 60日前(${momentumDateStr})数据: ${close60dAgoMap.size} 只`);
        } catch (e) {
            console.warn('[TrendBatch] 获取60日前数据失败，跳过动量筛选');
        }

        // 筛选
        const candidates: string[] = [];
        let stCount = 0, lowAmountCount = 0, lowPriceCount = 0, noMomentumCount = 0;

        for (const row of dailyBasic) {
            const tsCode = row.ts_code;

            // 排除 ST
            if (row.is_st === 1) {
                stCount++;
                continue;
            }

            // 排除低价股
            if (row.close < PREFILTER.MIN_CLOSE) {
                lowPriceCount++;
                continue;
            }

            // 排除低成交额（单位：千元，3000万 = 30000千元）
            const amount = amountMap.get(tsCode) || 0;
            if (amount < PREFILTER.MIN_AMOUNT_WAN * 10) {
                lowAmountCount++;
                continue;
            }

            // 排除低换手率
            if (row.turnover_rate < PREFILTER.MIN_TURNOVER_RATE) {
                lowAmountCount++;
                continue;
            }

            // 动量筛选：60 日涨幅为正（如果数据可用）
            if (close60dAgoMap.size > 0) {
                const close60dAgo = close60dAgoMap.get(tsCode);
                if (close60dAgo && close60dAgo > 0) {
                    const changePct = (row.close - close60dAgo) / close60dAgo;
                    if (changePct < -0.1) {
                        // 60 日跌幅超过 10% 排除
                        noMomentumCount++;
                        continue;
                    }
                }
            }

            // 转换 ts_code → symbol（去 .SH/.SZ 后缀）
            const symbol = tsCode.split('.')[0];
            candidates.push(symbol);
        }

        console.log(
            `[TrendBatch] 预筛选完成: ${candidates.length} 只候选股 ` +
            `(排除: ST=${stCount}, 低价=${lowPriceCount}, 低流动=${lowAmountCount}, 弱动量=${noMomentumCount})`,
        );

        return candidates;
    }

    static async run(force: boolean = false): Promise<TrendBatchResult> {
        if (TrendBatchService.running) {
            console.log('[TrendBatch] 已有批量评分任务在运行，跳过');
            return { total: 0, success: 0, skipped: 0, failed: 0 };
        }
        TrendBatchService.running = true;

        let successCount = 0;
        let skipCount = 0;
        let failCount = 0;
        let total = 0;
        let prefiltered = 0;

        try {
            const today = new Date().toISOString().slice(0, 10);
            console.log(`[TrendBatch] 开始批量趋势股评分, force=${force}, date=${today}`);

            // 预热板块轮动反向缓存（~112次 ths_member 调用，覆盖全市股票）
            console.log('[TrendBatch] 预热板块轮动反向缓存...');
            await ensureCacheBuilt();

            // === 阶段 1：预筛选 ===
            let symbols: string[];

            if (force) {
                // force 模式也用预筛选，但不过滤已评分
                symbols = await TrendBatchService.prefilterStocks();
            } else {
                // 先获取候选股，再过滤已评分的
                const candidates = await TrendBatchService.prefilterStocks();

                // 批量查询已评分的股票（一次查询，而非逐股查询）
                if (candidates.length > 0) {
                    const existingResult = await pool.query(
                        'SELECT symbol FROM trend_scores WHERE score_date = $1 AND symbol = ANY($2)',
                        [today, candidates],
                    );
                    const existingSet = new Set(
                        existingResult.rows.map((r: Record<string, unknown>) => r.symbol as string),
                    );
                    skipCount = existingSet.size;
                    symbols = candidates.filter(s => !existingSet.has(s));
                } else {
                    symbols = [];
                }
            }

            prefiltered = symbols.length + skipCount;
            total = prefiltered;

            // === 阶段 2：完整评分 ===
            console.log(`[TrendBatch] === 阶段2: 完整评分 (${symbols.length} 只待评分, ${skipCount} 只已跳过) ===`);

            for (const symbol of symbols) {
                try {
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

                    if (successCount % 50 === 0) {
                        console.log(`[TrendBatch] 进度: ${successCount}/${symbols.length} 已完成`);
                    }
                } catch (err) {
                    failCount++;
                    console.error(`[TrendBatch] ${symbol} 评分失败:`, err instanceof Error ? err.message : err);
                }
            }

            console.log(`[TrendBatch] 完成: 候选${prefiltered} 成功${successCount} 跳过${skipCount} 失败${failCount}`);
            return { total, success: successCount, skipped: skipCount, failed: failCount, prefiltered };
        } catch (err) {
            console.error('[TrendBatch] 批量评分异常:', err instanceof Error ? err.message : err);
            return { total, success: successCount, skipped: skipCount, failed: failCount, prefiltered };
        } finally {
            TrendBatchService.running = false;
        }
    }
}
