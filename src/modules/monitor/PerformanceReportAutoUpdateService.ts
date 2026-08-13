/**
 * 业绩报告自动更新服务
 *
 * 每天凌晨 00:00 定时执行，从 Tushare 获取业绩快报（预告）+ 正式报告数据。
 *
 * 数据源：
 * - Tushare forecast 接口：业绩快报/预告（含净利润变动、摘要）
 * - Tushare income 接口：正式财报（含营收、净利润、EPS）
 * - Tushare report_rc 接口：卖方研报评级（含 EPS 预测、评级、机构）
 *
 * 字段说明：
 * - 快报（report_type='express'）：基于 forecast 接口，提供净利润预测范围、摘要
 * - 正式报告（report_type='formal'）：基于 income 接口，提供营收、净利润、EPS等
 * - 评级（report_type='rating'）：基于 report_rc 接口，提供机构评级、EPS预测
 */

import pool from '../../core/db';
import { CacheService } from '../../shared/utils/CacheService';
import { NotificationService } from '../../core/notification/NotificationService';
import { getForecast, getIncome, getReportRc, type ForecastRow, type IncomeRow, type ReportRcRow } from '../quote/TushareService';
import { AiTagService } from './AiTagService';
import { shanghaiDateStr, shanghaiDateYyyymmdd } from '../../shared/utils/shanghaiTime';

/** 从 ts_code 提取6位股票代码 */
function tsCodeToSymbol(tsCode: string): string {
    return tsCode.split('.')[0];
}

/** 获取前一天的日期字符串 YYYY-MM-DD */
function getYesterdayStr(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return shanghaiDateStr(d);
}

/** 获取前一天的日期字符串 YYYYMMDD（Tushare格式） */
function getYesterdayCompact(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return shanghaiDateYyyymmdd(d);
}

/** 获取N天前的日期 YYYYMMDD */
function getDaysAgoCompact(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return shanghaiDateYyyymmdd(d);
}

export class PerformanceReportAutoUpdateService {
    private static running = false;

    /**
     * 执行自动更新
     */
    static async run(): Promise<{ updated: number; skipped: number; errors: number }> {
        if (this.running) {
            console.log('[PerformanceReportAutoUpdate] 已在运行中，跳过');
            return { updated: 0, skipped: 0, errors: 0 };
        }

        // 检查今天是否已经执行过
        const today = shanghaiDateStr();
        const lastRunDate = await CacheService.get<string>('performance_report:auto_update:date');
        if (lastRunDate === today) {
            console.log('[PerformanceReportAutoUpdate] 今天已执行过，跳过');
            return { updated: 0, skipped: 0, errors: 0 };
        }

        this.running = true;
        const yesterday = getYesterdayStr();
        const yesterdayCompact = getYesterdayCompact();
        console.log(`[PerformanceReportAutoUpdate] 开始执行，目标日期: ${yesterday}`);

        try {
            // 策略1：通过 report_rc 按日期查询有新研报的股票（精确增量）
            let symbolsToUpdate: string[] = [];
            try {
                symbolsToUpdate = await this.getSymbolsFromReportRc(yesterdayCompact);
                console.log(`[PerformanceReportAutoUpdate] report_rc 获取到 ${symbolsToUpdate.length} 只有新报告的股票`);
            } catch (err: any) {
                console.warn(`[PerformanceReportAutoUpdate] report_rc 不可用: ${err.message}，回退到全量更新`);
            }

            // 策略2：回退到全量更新已有记录的股票
            if (symbolsToUpdate.length === 0) {
                symbolsToUpdate = await this.getSymbolsFromDatabase();
                console.log(`[PerformanceReportAutoUpdate] 回退策略：获取到 ${symbolsToUpdate.length} 只有记录的股票`);
            }

            if (symbolsToUpdate.length === 0) {
                console.log('[PerformanceReportAutoUpdate] 没有需要更新的股票');
                await CacheService.put('performance_report:auto_update:date', today, 25 * 3600);
                this.running = false;
                return { updated: 0, skipped: 0, errors: 0 };
            }

            // 执行更新
            const result = await this.updateSymbols(symbolsToUpdate, yesterdayCompact);

            // 标记今天已执行
            await CacheService.put('performance_report:auto_update:date', today, 25 * 3600);

            console.log(`[PerformanceReportAutoUpdate] 完成: 更新 ${result.updated}, 跳过 ${result.skipped}, 失败 ${result.errors}`);
            this.running = false;
            return result;
        } catch (err: any) {
            console.error('[PerformanceReportAutoUpdate] 执行失败:', err.message);
            this.running = false;
            throw err;
        }
    }

    /**
     * 策略1：通过 Tushare report_rc 接口获取前一天有新研报的股票
     */
    private static async getSymbolsFromReportRc(reportDate: string): Promise<string[]> {
        const rows = await getReportRc({ report_date: reportDate });
        const symbolSet = new Set<string>();
        for (const row of rows) {
            const symbol = tsCodeToSymbol(row.ts_code);
            if (/^\d{6}$/.test(symbol)) {
                symbolSet.add(symbol);
            }
        }
        return Array.from(symbolSet);
    }

    /**
     * 策略2：获取数据库中所有已有业绩报告记录的股票
     */
    private static async getSymbolsFromDatabase(): Promise<string[]> {
        const result = await pool.query(
            `SELECT DISTINCT symbol FROM performance_reports
             WHERE created_at < NOW() - INTERVAL '24 hours'
                OR created_at IS NULL
             ORDER BY symbol
             LIMIT 500`
        );
        return result.rows.map((r: { symbol: string }) => r.symbol).filter((s: string) => /^\d{6}$/.test(s));
    }

    /**
     * 执行增量更新
     */
    private static async updateSymbols(
        symbols: string[],
        yesterdayCompact: string
    ): Promise<{ updated: number; skipped: number; errors: number }> {
        let updated = 0;
        let skipped = 0;
        let errors = 0;
        const concurrency = 3;
        const intervalMs = 500;
        const queue = [...symbols];

        async function worker() {
            while (queue.length > 0) {
                const symbol = queue.shift();
                if (!symbol) break;

                try {
                    const stockName = await PerformanceReportAutoUpdateService.getStockName(symbol);

                    // 1. 获取业绩快报/预告数据 (forecast)
                    const forecastRows = await getForecast(symbol, getDaysAgoCompact(90));
                    let expressUpdated = false;
                    for (const row of forecastRows) {
                        const annDate = row.ann_date?.replace(/-/g, '');
                        if (!annDate) continue;
                        const exists = await PerformanceReportAutoUpdateService.checkExists(symbol, 'express', annDate);
                        if (exists) continue;

                        await pool.query(
                            `INSERT INTO performance_reports
                             (symbol, stock_name, report_type, ann_date, end_date, summary, n_income_attr_p, created_at)
                             VALUES ($1, $2, 'express', $3, $4, $5, $6, NOW())
                             ON CONFLICT (symbol, report_type, ann_date) DO NOTHING`,
                            [
                                symbol,
                                stockName,
                                annDate,
                                row.end_date?.replace(/-/g, '') || '',
                                row.summary || '',
                                row.net_profit_max ?? null,
                            ]
                        );
                        try {
                            await NotificationService.createForWatchers({
                                category: 'performance_report',
                                sourceKey: `performance-report:${symbol}:express:${annDate}`,
                                symbol,
                                stockName: stockName || symbol,
                                title: `${stockName || symbol}：业绩快报/预告更新`,
                                summary: row.summary || `公告日期 ${annDate}`,
                                targetPath: `/modules/favorites/pages/detail?symbol=${encodeURIComponent(symbol)}`,
                                payload: { reportType: 'express', annDate },
                            });
                        } catch (error) {
                            console.warn('[PerformanceReportAutoUpdate] App notification failed:', error instanceof Error ? error.message : String(error));
                        }
                        expressUpdated = true;
                    }

                    // 2. 获取正式报告数据 (income)
                    const incomeRows = await getIncome(symbol, getDaysAgoCompact(365));
                    let formalUpdated = false;
                    for (const row of incomeRows) {
                        const annDate = row.ann_date?.replace(/-/g, '');
                        if (!annDate) continue;
                        const exists = await PerformanceReportAutoUpdateService.checkExists(symbol, 'formal', annDate);
                        if (exists) continue;

                        await pool.query(
                            `INSERT INTO performance_reports
                             (symbol, stock_name, report_type, ann_date, end_date,
                              total_revenue, n_income, n_income_attr_p, basic_eps, created_at)
                             VALUES ($1, $2, 'formal', $3, $4, $5, $6, $7, $8, NOW())
                             ON CONFLICT (symbol, report_type, ann_date) DO NOTHING`,
                            [
                                symbol,
                                stockName,
                                annDate,
                                row.end_date?.replace(/-/g, '') || '',
                                row.total_revenue ?? null,
                                row.n_income ?? null,
                                row.n_income_attr_p ?? null,
                                row.basic_eps ?? null,
                            ]
                        );
                        try {
                            await NotificationService.createForWatchers({
                                category: 'performance_report',
                                sourceKey: `performance-report:${symbol}:formal:${annDate}`,
                                symbol,
                                stockName: stockName || symbol,
                                title: `${stockName || symbol}：财报披露`,
                                summary: `公告日期 ${annDate}`,
                                targetPath: `/modules/favorites/pages/detail?symbol=${encodeURIComponent(symbol)}`,
                                payload: { reportType: 'formal', annDate },
                            });
                        } catch (error) {
                            console.warn('[PerformanceReportAutoUpdate] App notification failed:', error instanceof Error ? error.message : String(error));
                        }
                        formalUpdated = true;
                    }

                    // 3. 获取研报评级数据 (report_rc)
                    try {
                        const reportRcRows = await getReportRc({
                            ts_code: symbol.length === 6
                                ? `${symbol}.${['6', '9'].includes(symbol[0]) ? 'SH' : 'SZ'}`
                                : symbol,
                            start_date: getDaysAgoCompact(30),
                        });
                        let ratingUpdated = false;
                        for (const row of reportRcRows) {
                            const reportDate = row.report_date?.replace(/-/g, '');
                            if (!reportDate || !row.eps) continue;
                            const exists = await PerformanceReportAutoUpdateService.checkExists(symbol, 'rating', reportDate);
                            if (exists) continue;

                            await pool.query(
                                `INSERT INTO performance_reports
                                 (symbol, stock_name, report_type, ann_date, end_date,
                                  forecast_eps, rating, org_name, created_at)
                                 VALUES ($1, $2, 'rating', $3, $4, $5, $6, $7, NOW())
                                 ON CONFLICT (symbol, report_type, ann_date) DO NOTHING`,
                                [
                                    symbol,
                                    stockName,
                                    reportDate,
                                    row.quarter || '',
                                    row.eps ?? null,
                                    row.rating || '',
                                    row.org_name || '',
                                ]
                            );
                            ratingUpdated = true;
                        }
                    } catch (err: any) {
                        // report_rc 可能积分不足，跳过不报错
                        console.warn(`[PerformanceReportAutoUpdate] ${symbol} report_rc 获取失败: ${err.message}`);
                    }

                    // 是否有新插入的报告
                    const hasNewReport = expressUpdated || formalUpdated;

                    // 是否还有"利润数据已就绪但标签为空"的报告需要补算
                    // （覆盖：插入时利润字段为空被跳过、或上次计算失败等情况）
                    const pendingTagFix = await pool.query(
                        `SELECT 1 FROM performance_reports
                         WHERE symbol = $1 AND report_type IN ('formal', 'express')
                           AND n_income_attr_p IS NOT NULL
                           AND (ai_tag IS NULL OR ai_tag = '')
                         LIMIT 1`,
                        [symbol]
                    );

                    if (hasNewReport || pendingTagFix.rows.length > 0) {
                        updated++;
                        // 为新插入的报告计算 ai_tag，并补偿历史空标签
                        await PerformanceReportAutoUpdateService.updateAiTags(symbol);
                    } else {
                        skipped++;
                    }
                } catch (err: any) {
                    errors++;
                    console.warn(`[PerformanceReportAutoUpdate] ${symbol} 更新失败: ${err.message}`);
                }

                if (intervalMs > 0) {
                    await new Promise(r => setTimeout(r, intervalMs));
                }
            }
        }

        const workers = Array.from({ length: concurrency }, () => worker());
        await Promise.all(workers);

        return { updated, skipped, errors };
    }

    /** 检查记录是否已存在 */
    private static async checkExists(symbol: string, reportType: string, annDate: string): Promise<boolean> {
        const result = await pool.query(
            `SELECT 1 FROM performance_reports WHERE symbol = $1 AND report_type = $2 AND ann_date = $3 LIMIT 1`,
            [symbol, reportType, annDate]
        );
        return result.rows.length > 0;
    }

    /** 获取股票名称 */
    private static async getStockName(symbol: string): Promise<string> {
        try {
            const result = await pool.query(
                `SELECT name FROM stocks WHERE symbol = $1 LIMIT 1`,
                [symbol]
            );
            return result.rows[0]?.name || '';
        } catch {
            return '';
        }
    }

    /**
     * 更新指定股票所有最新报告的 ai_tag
     * 使用 AiTagService 计算标签并写入数据库
     */
    private static async updateAiTags(symbol: string): Promise<void> {
        // 1. 查出所有需要更新标签的正式报告
        const formalRows = await pool.query(
            `SELECT end_date, total_revenue, n_income_attr_p, report_type
             FROM performance_reports
             WHERE symbol = $1 AND report_type IN ('formal', 'express')
               AND n_income_attr_p IS NOT NULL
             ORDER BY end_date ASC`,
            [symbol]
        );
        if (formalRows.rows.length === 0) return;

        // 2. 逐条计算标签并 UPDATE
        let prevRev: number | null = null;
        let prevProfit: number | null = null;

        for (const row of formalRows.rows) {
            let tag: string;
            if (row.report_type === 'formal') {
                const result = await AiTagService.computeForFormal(
                    symbol, row.end_date, row.total_revenue, row.n_income_attr_p
                );
                tag = result;
            } else {
                const result = await AiTagService.computeForExpress(
                    symbol, row.end_date, row.n_income_attr_p
                );
                tag = result;
            }

            await pool.query(
                `UPDATE performance_reports SET ai_tag = $1
                 WHERE symbol = $2 AND end_date = $3 AND report_type = $4`,
                [tag, symbol, row.end_date, row.report_type]
            );

            if (row.report_type === 'formal') {
                prevRev = row.total_revenue;
                prevProfit = row.n_income_attr_p;
            }
        }
    }

    /** 是否正在运行 */
    static isRunning(): boolean {
        return this.running;
    }
}
