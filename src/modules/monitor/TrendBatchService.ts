import pool from '../../core/db';
import { TrendScoreService } from './TrendScoreService';
import { ensureCacheBuilt, getBestBoardForStock, getCacheStatus } from './RotationBoardCache';
import * as TushareService from '../quote/TushareService';

export interface TrendBatchResult {
    total: number;
    success: number;
    skipped: number;
    failed: number;
    prefiltered?: number;
}

/**
 * 预筛选条件常量
 * 成交额阈值与 TenxScoreService.AVG_AMOUNT_THRESHOLD 完全对齐（300000千元 = 3000万元）
 */
const PREFILTER = {
    MIN_CLOSE: 2,                    // 最低股价 2 元
    MIN_AVG_AMOUNT: 300000,          // 20日日均成交额 ≥ 300000千元（= 3000万元），与 vetoCheck 一致
    MIN_TURNOVER_RATE: 0.3,          // 换手率 ≥ 0.3%
    AMOUNT_LOOKBACK_DAYS: 30,        // 拉取近 30 自然日 daily 数据（覆盖 ~20 交易日）
    MOMENTUM_DAYS: 60,               // 60 日动量检查
};

/** 交易日列表（YYYYMMDD 格式，近 N 自然日） */
function getRecentCalendarDays(days: number): string[] {
    const dates: string[] = [];
    for (let i = 0; i <= days; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    }
    return dates;
}

export class TrendBatchService {
    private static running = false;

    static isRunning(): boolean {
        return TrendBatchService.running;
    }

    /**
     * 阶段 1：用 bulk 接口预筛选，快速排除 ST、低流动性、低价股
     *
     * 筛选标准与 vetoCheck 完全对齐：
     * - 20日日均成交额 ≥ 3000万（与 AVG_AMOUNT_THRESHOLD 一致）
     * - 非 ST/*ST（与 getStStatus 一致，但用 stock_basic name 批量获取）
     *
     * 额外筛选（vetoCheck 不检查但有助于减少候选量）：
     * - 股价 ≥ 2 元
     * - 换手率 ≥ 0.3%
     * - 60日跌幅不超过 10%
     */
    static async prefilterStocks(): Promise<string[]> {
        console.log('[TrendBatch] === 阶段1: 预筛选 ===');

        // --- 1. 找到最近的交易日 ---
        let latestDate = '';
        let dailyBasic: TushareService.DailyBasicFullRow[] = [];

        for (const dateStr of getRecentCalendarDays(7)) {
            try {
                const basic = await TushareService.getDailyBasicByDate(dateStr);
                if (basic.length > 0) {
                    latestDate = dateStr;
                    dailyBasic = basic;
                    break;
                }
            } catch { /* 继续试前一天 */ }
        }

        if (dailyBasic.length === 0) {
            console.error('[TrendBatch] 预筛选失败: 无法获取近期交易日 daily_basic 数据');
            return [];
        }

        console.log(`[TrendBatch] 最新交易日: ${latestDate}, 全市场 ${dailyBasic.length} 只股票`);

        // --- 2. 批量获取 ST 股票名单（stock_basic 接口，1 次调用） ---
        const stSet = new Set<string>();
        try {
            const stockBasic = await TushareService.getStockBasicBulk();
            for (const row of stockBasic) {
                if (row.name.includes('ST') || row.name.includes('*ST')) {
                    stSet.add(row.ts_code);
                }
            }
            console.log(`[TrendBatch] ST 股票名单: ${stSet.size} 只`);
        } catch (e) {
            console.warn('[TrendBatch] 获取 stock_basic 失败，跳过 ST 排除:', e instanceof Error ? e.message : e);
        }

        // --- 3. 批量计算 20 日日均成交额 ---
        // 拉取近 30 个自然日的 daily 数据，按股票聚合 amount
        const amountSumMap = new Map<string, number>(); // ts_code → 总成交额（千元）
        const amountCountMap = new Map<string, number>(); // ts_code → 交易日天数

        const lookbackDates = getRecentCalendarDays(PREFILTER.AMOUNT_LOOKBACK_DAYS);
        let daysFetched = 0;

        for (const dateStr of lookbackDates) {
            if (dateStr === latestDate) continue; // 跳过当天，用 daily 接口的数据
            try {
                const daily = await TushareService.getDailyByDate(dateStr);
                if (daily.length > 0) {
                    daysFetched++;
                    for (const row of daily) {
                        amountSumMap.set(row.ts_code, (amountSumMap.get(row.ts_code) || 0) + (row.amount || 0));
                        amountCountMap.set(row.ts_code, (amountCountMap.get(row.ts_code) || 0) + 1);
                    }
                }
            } catch { /* 非交易日，跳过 */ }
        }

        // 也要加上当天的 daily 数据
        try {
            const todayDaily = await TushareService.getDailyByDate(latestDate);
            if (todayDaily.length > 0) {
                daysFetched++;
                for (const row of todayDaily) {
                    amountSumMap.set(row.ts_code, (amountSumMap.get(row.ts_code) || 0) + (row.amount || 0));
                    amountCountMap.set(row.ts_code, (amountCountMap.get(row.ts_code) || 0) + 1);
                }
            }
        } catch { /* ignore */ }

        console.log(`[TrendBatch] 20日日均成交额: 获取了 ${daysFetched} 个交易日数据, 覆盖 ${amountSumMap.size} 只股票`);

        // --- 4. 构建 60 日前收盘价映射（用于动量筛选） ---
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
        } catch {
            console.warn('[TrendBatch] 获取60日前数据失败，跳过动量筛选');
        }

        // --- 5. 综合筛选 ---
        const candidates: string[] = [];
        let stCount = 0, lowAmountCount = 0, lowPriceCount = 0, noMomentumCount = 0, noBoardCount = 0;

        // 打印板块缓存覆盖情况
        const cacheStatus = getCacheStatus();
        console.log(`[TrendBatch] 板块轮动缓存: ${cacheStatus.stockCount} 只股票, ${cacheStatus.boardCount} 个板块`);

        for (const row of dailyBasic) {
            const tsCode = row.ts_code;

            // 排除 ST（用 stock_basic name 匹配）
            if (stSet.has(tsCode)) {
                stCount++;
                continue;
            }

            // 排除低价股
            if (row.close < PREFILTER.MIN_CLOSE) {
                lowPriceCount++;
                continue;
            }

            // 排除低 20 日日均成交额（与 vetoCheck 阈值完全一致）
            const sumAmount = amountSumMap.get(tsCode) || 0;
            const cnt = amountCountMap.get(tsCode) || 0;
            const avgAmount = cnt > 0 ? sumAmount / cnt : 0;
            if (avgAmount < PREFILTER.MIN_AVG_AMOUNT) {
                lowAmountCount++;
                continue;
            }

            // 排除低换手率
            if (row.turnover_rate < PREFILTER.MIN_TURNOVER_RATE) {
                lowAmountCount++;
                continue;
            }

            // 动量筛选：60 日跌幅超过 10% 排除
            if (close60dAgoMap.size > 0) {
                const close60dAgo = close60dAgoMap.get(tsCode);
                if (close60dAgo && close60dAgo > 0) {
                    const changePct = (row.close - close60dAgo) / close60dAgo;
                    if (changePct < -0.1) {
                        noMomentumCount++;
                        continue;
                    }
                }
            }

            // 转换 ts_code → symbol（去 .SH/.SZ 后缀）
            const symbol = tsCode.split('.')[0];

            // 排除不在任何 60 日上榜板块中的股票（零 API 调用，纯内存查询）
            const bestBoard = getBestBoardForStock(symbol);
            if (!bestBoard) {
                noBoardCount++;
                continue;
            }
            // 顺带过滤 60 日上榜次数过少的（<2 次）
            if (bestBoard.count60d < 2) {
                noBoardCount++;
                continue;
            }

            candidates.push(symbol);
        }

        console.log(
            `[TrendBatch] 预筛选完成: ${candidates.length} 只候选股 ` +
            `(排除: ST=${stCount}, 低价=${lowPriceCount}, 低成交额/换手=${lowAmountCount}, ` +
            `弱动量=${noMomentumCount}, 不在上榜板块=${noBoardCount})`,
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
                symbols = await TrendBatchService.prefilterStocks();
            } else {
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
            const phase2Start = Date.now();

            for (const symbol of symbols) {
                try {
                    // skipVeto=true：预筛选已用相同标准（20日日均成交额 + ST）过滤，
                    // 无需在 calculateTrendScore 内部重复调用 vetoCheck
                    const result = await TrendScoreService.calculateTrendScore(symbol, undefined, undefined, true);
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

                    // 单只股票评分成功日志（含分数和板块信息）
                    const boardInfo = getBestBoardForStock(symbol);
                    const boardStr = boardInfo ? `${boardInfo.boardName}, 上榜${boardInfo.count60d}次` : '无板块';
                    console.log(
                        `[TrendBatch] ✅ ${symbol} 完成 (score=${result.score.toFixed(1)}, ${result.label}, ${boardStr}) ` +
                        `[${successCount}/${symbols.length}]`,
                    );

                    if (successCount % 10 === 0) {
                        const elapsedSec = ((Date.now() - phase2Start) / 1000).toFixed(0);
                        const avgSec = (Number(elapsedSec) / successCount).toFixed(1);
                        const remaining = Math.round((Number(elapsedSec) / successCount) * (symbols.length - successCount));
                        console.log(
                            `[TrendBatch] --- 进度: ${successCount}/${symbols.length} ` +
                            `(${(successCount / symbols.length * 100).toFixed(1)}%) ` +
                            `已用${elapsedSec}s, 均${avgSec}s/只, 预计剩余${remaining}s ---`,
                        );
                    }
                } catch (err) {
                    failCount++;
                    console.error(`[TrendBatch] ❌ ${symbol} 失败: ${err instanceof Error ? err.message : err} [${successCount + failCount}/${symbols.length}]`);
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
