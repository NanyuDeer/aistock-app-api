/**
 * 业绩预测自动更新服务
 *
 * 每天 00:00 定时执行，仅更新前一天有新业绩预测报告的股票
 *
 * 策略：
 * 1. 优先使用 Tushare report_rc 接口，按前一天日期查询所有有新报告的股票（精确增量）
 * 2. 如果 report_rc 不可用（积分不足等），则回退到全量更新已有记录的股票：
 *    - 查询所有已有业绩预测记录的股票
 *    - 重新爬取并对比新旧数据，仅当有变化时更新
 */

import pool from '../../core/db';
import { getReportRc, type ReportRcRow } from '../quote/TushareService';
import { CacheService } from '../../shared/utils/CacheService';
import { sessionFetch } from '../../shared/utils/httpAgent';

/** 从 ts_code 提取6位股票代码 */
function tsCodeToSymbol(tsCode: string): string {
    return tsCode.split('.')[0];
}

/** 获取前一天的日期字符串 YYYY-MM-DD */
function getYesterdayStr(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
}

/** 获取前一天的日期字符串 YYYYMMDD（Tushare格式） */
function getYesterdayCompact(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export class ProfitForecastAutoUpdateService {
    private static running = false;

    /**
     * 执行自动更新
     * @returns 更新的股票数量等信息
     */
    static async run(): Promise<{ updated: number; skipped: number; errors: number; method: string }> {
        if (this.running) {
            console.log('[ProfitForecastAutoUpdate] 已在运行中，跳过');
            return { updated: 0, skipped: 0, errors: 0, method: 'skipped' };
        }

        // 检查今天是否已经执行过
        const today = new Date().toISOString().slice(0, 10);
        const lastRunDate = await CacheService.get<string>('profit_forecast:auto_update:date');
        if (lastRunDate === today) {
            console.log('[ProfitForecastAutoUpdate] 今天已执行过，跳过');
            return { updated: 0, skipped: 0, errors: 0, method: 'already_run' };
        }

        this.running = true;
        const yesterday = getYesterdayStr();
        const yesterdayCompact = getYesterdayCompact();
        console.log(`[ProfitForecastAutoUpdate] 开始执行，目标日期: ${yesterday}`);

        try {
            // 策略1：尝试使用 Tushare report_rc 接口（精确增量）
            let symbolsToUpdate: string[] = [];
            let method = '';

            try {
                symbolsToUpdate = await this.getSymbolsFromTushare(yesterdayCompact);
                method = 'tushare_report_rc';
                console.log(`[ProfitForecastAutoUpdate] Tushare report_rc 获取到 ${symbolsToUpdate.length} 只有新报告的股票`);
            } catch (err: any) {
                console.warn(`[ProfitForecastAutoUpdate] Tushare report_rc 不可用: ${err.message}，回退到全量更新已有记录`);
            }

            // 策略2：回退到全量更新已有记录的股票
            if (symbolsToUpdate.length === 0) {
                symbolsToUpdate = await this.getSymbolsFromDatabase();
                method = 'database_fallback';
                console.log(`[ProfitForecastAutoUpdate] 回退策略：获取到 ${symbolsToUpdate.length} 只有记录的股票`);
            }

            if (symbolsToUpdate.length === 0) {
                console.log('[ProfitForecastAutoUpdate] 没有需要更新的股票');
                await CacheService.put('profit_forecast:auto_update:date', today, 25 * 3600);
                this.running = false;
                return { updated: 0, skipped: 0, errors: 0, method: 'no_updates' };
            }

            // 执行增量更新
            const result = await this.updateSymbols(symbolsToUpdate, yesterday);

            // 标记今天已执行
            await CacheService.put('profit_forecast:auto_update:date', today, 25 * 3600);

            console.log(`[ProfitForecastAutoUpdate] 完成: 更新 ${result.updated}, 跳过 ${result.skipped}, 失败 ${result.errors}, 方法: ${method}`);
            this.running = false;
            return { ...result, method };
        } catch (err: any) {
            console.error('[ProfitForecastAutoUpdate] 执行失败:', err.message);
            this.running = false;
            throw err;
        }
    }

    /**
     * 策略1：使用 Tushare report_rc 接口获取前一天有新报告的股票
     * 这是最精确的方式，直接获取某日所有有新研报的股票列表
     */
    private static async getSymbolsFromTushare(yesterdayCompact: string): Promise<string[]> {
        const rows = await getReportRc({ report_date: yesterdayCompact });

        // 提取去重的股票代码
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
     * 策略2：获取数据库中所有已有业绩预测记录的股票
     * 作为 report_rc 不可用时的回退方案
     */
    private static async getSymbolsFromDatabase(): Promise<string[]> {
        const result = await pool.query(
            `SELECT symbol FROM earnings_forecast ORDER BY symbol`
        );
        return result.rows.map((r: { symbol: string }) => r.symbol).filter((s: string) => /^\d{6}$/.test(s));
    }

    /**
     * 执行增量更新：对指定股票列表重新爬取业绩预测
     * 爬取页面后，提取业绩预测详表中最新的报告日期，如果是前一天则更新，否则跳过
     * @param symbols 要更新的股票列表
     * @param yesterday 昨天的日期字符串，用于判断是否有新报告
     */
    private static async updateSymbols(symbols: string[], yesterday: string): Promise<{ updated: number; skipped: number; errors: number }> {
        let updated = 0;
        let skipped = 0;
        let errors = 0;
        const concurrency = 3;
        const intervalMs = 500;
        const queue = [...symbols];

        const yesterdayPatterns = [
            yesterday,                   // 2026-06-23
            yesterday.replace(/-/g, ''), // 20260623
            yesterday.replace(/-/g, '/'), // 2026/06/23
        ];

        async function worker() {
            while (queue.length > 0) {
                const symbol = queue.shift();
                if (!symbol) break;

                try {
                    const data = await ProfitForecastAutoUpdateService.fetchProfitForecast(symbol);

                    const detail = data['业绩预测详表_详细指标预测'];
                    if (!Array.isArray(detail) || detail.length === 0) {
                        skipped++;
                        continue;
                    }

                    // 提取详表中最新的报告日期（取所有报告日期中最晚的）
                    let latestReportDate = '';
                    for (const item of detail) {
                        const reportDate = item['报告日期'] || item['报告日期 '] || '';
                        if (reportDate && (!latestReportDate || reportDate > latestReportDate)) {
                            latestReportDate = reportDate;
                        }
                    }

                    // 检查最新报告日期是否为前一天
                    const isYesterdayReport = latestReportDate && yesterdayPatterns.some(p => latestReportDate.includes(p));

                    if (!isYesterdayReport) {
                        // 最新报告日期不是前一天，跳过不更新
                        skipped++;
                        continue;
                    }

                    const summary = typeof data['摘要'] === 'string' ? data['摘要'] : '';
                    const forecastNetProfitYoy = ProfitForecastAutoUpdateService.extractForecastNetProfitYoy(summary);
                    const updateTime = ProfitForecastAutoUpdateService.formatToChinaTimeWithMs(Date.now());

                    await pool.query(
                        `INSERT INTO earnings_forecast (symbol, update_time, summary, forecast_detail, forecast_netprofit_yoy)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (symbol) DO UPDATE SET
                            update_time = EXCLUDED.update_time,
                            summary = EXCLUDED.summary,
                            forecast_detail = EXCLUDED.forecast_detail,
                            forecast_netprofit_yoy = EXCLUDED.forecast_netprofit_yoy`,
                        [symbol, updateTime, summary, JSON.stringify(detail), forecastNetProfitYoy],
                    );
                    updated++;
                } catch (err: any) {
                    errors++;
                    console.warn(`[ProfitForecastAutoUpdate] ${symbol} 更新失败: ${err.message}`);
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

    /** 爬取个股业绩预测 */
    private static async fetchProfitForecast(symbol: string): Promise<Record<string, any>> {
        const url = `http://basic.10jqka.com.cn/${symbol}/worth.html`;
        const response = await sessionFetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' },
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`同花顺接口请求失败: ${response.status}`);

        const arrayBuffer = await response.arrayBuffer();
        const html = new TextDecoder('gbk').decode(arrayBuffer);

        const cleanHtml = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '');

        const cheerio = await import('cheerio');
        const $ = cheerio.load(cleanHtml, { scriptingEnabled: false });

        const result: Record<string, any> = { '摘要': '', '业绩预测详表_详细指标预测': [] };
        result['摘要'] = $('#forecast > div.bd > p.tip.clearfix').text().trim().replace(/\s+/g, ' ');

        const detailTable = $('#forecastdetail > div.bd > table.m_table.m_hl.ggintro.ggintro_1.organData');
        if (detailTable.length > 0) {
            const { parseTable } = await import('../../shared/utils/parser');
            result['业绩预测详表_详细指标预测'] = parseTable($, detailTable[0], '业绩预测详表-详细指标预测');
        }

        return result;
    }

    /** 从摘要中提取净利润同比 */
    private static extractForecastNetProfitYoy(summary: string): number | null {
        const match = summary.match(/预测\d{4}年净利润.*?较去年同比增长\s*([\d.]+)%/);
        if (match) return parseFloat(match[1]);
        const match2 = summary.match(/预测\d{4}年净利润.*?较去年同比下降\s*([\d.]+)%/);
        if (match2) return -parseFloat(match2[1]);
        return null;
    }

    /** 格式化时间为中国时区带毫秒 */
    private static formatToChinaTimeWithMs(timestamp: number): string {
        const d = new Date(timestamp + 8 * 3600 * 1000);
        return d.toISOString().slice(0, 23).replace('T', ' ');
    }

    /** 是否正在运行 */
    static isRunning(): boolean {
        return this.running;
    }
}
