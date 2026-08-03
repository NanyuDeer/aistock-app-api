import pool from '../../core/db';
import { TrendScoreService } from './TrendScoreService';
import { ensureCacheBuilt, getBestBoardForStock, getCacheStatus } from './RotationBoardCache';
import * as LeaderStockCache from './LeaderStockCache';
import * as TushareService from '../quote/TushareService';

export interface TrendBatchResult {
    total: number;
    success: number;
    skipped: number;
    failed: number;
    prefiltered?: number;
}

/**
 * 预筛选条件常量（保守档）
 *
 * 设计原则：预筛比 vetoCheck 更严。vetoCheck 是阶段2的生存底线（5000万成交额+非ST），
 * 预筛是阶段1的快速排除，目标是只留真正具备趋势潜力的股票，减少阶段2评分开销。
 *
 * 注：vetoCheck 中 AVG_AMOUNT_THRESHOLD = 500000千元（5000万元），为否决底线；
 *     预筛 MIN_AVG_AMOUNT 提升至 800000千元（8000万元），趋势股需更强流动性。
 */
const PREFILTER = {
    MIN_CLOSE: 3,                    // 最低股价 3 元（排除低价股波动风险）
    MIN_AVG_AMOUNT: 800000,          // 20日日均成交额 ≥ 800000千元（= 8000万元），比 vetoCheck(5000万) 更严
    MIN_TURNOVER_RATE: 1.0,          // 换手率 ≥ 1%（0.3% 为死股水平，趋势股必须活跃）
    AMOUNT_LOOKBACK_DAYS: 30,        // 拉取近 30 自然日 daily 数据（覆盖 ~20 交易日）
    MOMENTUM_DAYS: 60,               // 60 日动量检查
    MIN_BOARD_COUNT_60D: 5,          // 60日板块上榜次数 ≥ 5（趋势股赛道应更活跃）
    MIN_LIST_DAYS: 90,               // 上市满 90 自然日（≈60交易日），排除次新股数据不足
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
     * 阶段 1：用 bulk 接口预筛选，快速排除 ST、低流动性、低价股、次新股、弱动量股
     *
     * 筛选标准（保守档，比 vetoCheck 更严）：
     * - 非 ST/*ST（用 stock_basic name 批量获取）
     * - 股价 ≥ 3 元
     * - 20日日均成交额 ≥ 8000万（vetoCheck 底线为 5000万，预筛更严）
     * - 换手率 ≥ 1%
     * - 上市满 90 自然日（排除次新股，K线数据不足以判断趋势）
     * - 60日动量为正（趋势股必须上涨，排除横盘/下跌/崩盘股）
     * - 60日板块上榜次数 ≥ 5
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

        // --- 2. 批量获取 ST 股票名单与上市日期（stock_basic 接口，1 次调用） ---
        const stSet = new Set<string>();
        const listDateMap = new Map<string, string>(); // ts_code → list_date (YYYYMMDD)
        try {
            const stockBasic = await TushareService.getStockBasicBulk();
            for (const row of stockBasic) {
                if (row.name.includes('ST') || row.name.includes('*ST')) {
                    stSet.add(row.ts_code);
                }
                if (row.list_date) {
                    listDateMap.set(row.ts_code, row.list_date);
                }
            }
            console.log(`[TrendBatch] ST 股票名单: ${stSet.size} 只, 上市日期: ${listDateMap.size} 只`);
        } catch (e) {
            console.warn('[TrendBatch] 获取 stock_basic 失败，跳过 ST/次新股排除:', e instanceof Error ? e.message : e);
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
        // 计算 90 自然日前的日期（≈ 60 交易日），若该日为非交易日（节假日/周末），
        // 则向前回退查找最近一个有交易数据的日期，避免动量筛选因数据为空而完全失效
        const momentumDate = new Date();
        momentumDate.setDate(momentumDate.getDate() - 90); // 90 自然日 ≈ 60 交易日
        const momentumDateStr = momentumDate.toISOString().slice(0, 10).replace(/-/g, '');
        const close60dAgoMap = new Map<string, number>();
        let actualMomentumDateStr = '';
        try {
            const MAX_FALLBACK_DAYS = 10; // 最多回退10天，覆盖春节等长假
            for (let offset = 0; offset <= MAX_FALLBACK_DAYS; offset++) {
                const tryDate = new Date(momentumDate);
                tryDate.setDate(tryDate.getDate() - offset);
                const tryDateStr = tryDate.toISOString().slice(0, 10).replace(/-/g, '');
                const daily = await TushareService.getDailyByDate(tryDateStr);
                if (daily.length > 0) {
                    actualMomentumDateStr = tryDateStr;
                    for (const row of daily) {
                        close60dAgoMap.set(row.ts_code, row.close);
                    }
                    break;
                }
            }
            if (close60dAgoMap.size > 0) {
                const adjusted = actualMomentumDateStr !== momentumDateStr;
                console.log(`[TrendBatch] 60日前(${actualMomentumDateStr})数据: ${close60dAgoMap.size} 只${adjusted ? ' (原日期为非交易日，已回退)' : ''}`);
            } else {
                console.warn('[TrendBatch] 60日前数据连续10天均为空，跳过动量筛选');
            }
        } catch {
            console.warn('[TrendBatch] 获取60日前数据失败，跳过动量筛选');
        }

        // --- 5. 综合筛选 ---
        const candidates: string[] = [];
        let stCount = 0, lowAmountCount = 0, lowPriceCount = 0, noMomentumCount = 0, noBoardCount = 0, newStockCount = 0;

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

            // 排除次新股（上市不足 MIN_LIST_DAYS 自然日，K线数据不足以判断趋势）
            const listDate = listDateMap.get(tsCode);
            if (listDate && listDate.length === 8) {
                const listMs = new Date(
                    parseInt(listDate.slice(0, 4)),
                    parseInt(listDate.slice(4, 6)) - 1,
                    parseInt(listDate.slice(6, 8)),
                ).getTime();
                const daysSinceList = Math.floor((Date.now() - listMs) / 86400000);
                if (daysSinceList < PREFILTER.MIN_LIST_DAYS) {
                    newStockCount++;
                    continue;
                }
            }

            // 排除低 20 日日均成交额（预筛阈值 8000万，比 vetoCheck 5000万 更严）
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

            // 动量筛选：要求 60 日正动量（趋势股必须上涨，排除横盘/下跌/崩盘股）
            if (close60dAgoMap.size > 0) {
                const close60dAgo = close60dAgoMap.get(tsCode);
                if (close60dAgo && close60dAgo > 0) {
                    const changePct = (row.close - close60dAgo) / close60dAgo;
                    if (changePct <= 0) {
                        noMomentumCount++;
                        continue;
                    }
                } else {
                    // 60日前无收盘价数据（数据缺失或疑似次新），无法验证正动量，排除
                    noMomentumCount++;
                    continue;
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
            // 过滤 60 日上榜次数过少的（< MIN_BOARD_COUNT_60D 次）
            if (bestBoard.count60d < PREFILTER.MIN_BOARD_COUNT_60D) {
                noBoardCount++;
                continue;
            }

            candidates.push(symbol);
        }

        console.log(
            `[TrendBatch] 预筛选完成: ${candidates.length} 只候选股 ` +
            `(排除: ST=${stCount}, 低价=${lowPriceCount}, 次新=${newStockCount}, 低成交额/换手=${lowAmountCount}, ` +
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

            // 预热龙头股缓存（~112次同花顺页面爬取，构建龙头股代码集合）
            console.log('[TrendBatch] 预热龙头股缓存...');
            await LeaderStockCache.ensureCacheBuilt();

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
                            (symbol, score_date, score, label, expected_multiple, description, ai_conclusion, dim_scores, dimensions, raw_data, ma60_excluded, updated_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                        ON CONFLICT (symbol, score_date) DO UPDATE SET
                            score = EXCLUDED.score, label = EXCLUDED.label,
                            expected_multiple = EXCLUDED.expected_multiple,
                            description = EXCLUDED.description, ai_conclusion = EXCLUDED.ai_conclusion,
                            dim_scores = EXCLUDED.dim_scores, dimensions = EXCLUDED.dimensions,
                            raw_data = EXCLUDED.raw_data, ma60_excluded = EXCLUDED.ma60_excluded,
                            updated_at = EXCLUDED.updated_at
                    `, [
                        symbol, today, result.score, result.label, result.expectedMultiple,
                        result.description, result.aiConclusion, JSON.stringify(result.dimScores),
                        JSON.stringify(result.dimensions), rawDataJson, result.ma60Excluded, result.updatedAt,
                    ]);
                    successCount++;

                    // 单只股票评分成功日志（含分数和板块信息）
                    // 从 result.dimensions 中提取板块信息（不依赖缓存，缓存可能未命中）
                    let boardStr = '无板块';
                    const trackDim = result.dimensions?.find((d: { name: string }) => d.name === '行业赛道景气');
                    if (trackDim && trackDim.detail) {
                        const trackDetail = trackDim.detail as { sectorName?: string; sectorListCount60d?: number };
                        if (trackDetail.sectorName && trackDetail.sectorListCount60d) {
                            boardStr = `${trackDetail.sectorName}, 上榜${trackDetail.sectorListCount60d}次`;
                        }
                    }
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
