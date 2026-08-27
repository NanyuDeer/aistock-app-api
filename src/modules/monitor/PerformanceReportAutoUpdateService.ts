/**
 * 业绩报告自动更新服务
 *
 * 每天凌晨 00:00 定时执行，从 Tushare 获取业绩快报（express）+ 正式报告（formal）数据。
 *
 * 架构（无候选池，各类型只去自己的发现源按"前一天日期"批量增量）：
 * - 业绩快报（report_type='express'）：`express_vip` 按最近两个报告期全量分页
 *   （该接口不支持按 ann_date 过滤，需整报告期拉全量），客户端筛 `ann_date`=目标日期
 * - 正式报告（report_type='formal'）：`disclosure_date.actual_date`=目标日期
 *   全市场发现（真实披露日，T+1 权威），命中后才逐股拉 `income`
 * - 若目标日期无新增，用前 2 个自然日窗口重扫补漏（仍按日期批量，轻量）
 *
 * 已下线：
 * - 业绩预告（forecast）分支：业绩预告单独不建逻辑
 * - 研报评级（rating）分支：report_rc 只归业绩预测（第 1 套）使用，避免同一批研报触发两套通知
 * - 预披露提醒（disclosure_date.pre_date 前瞻）：目前用不上
 */

import pool from '../../core/db';
import { CacheService } from '../../shared/utils/CacheService';
import {
    getExpressVip, getIncome, getDisclosureDate,
    type ExpressVipRow, type DisclosureDateRow,
} from '../quote/TushareService';
import { AiTagService } from './AiTagService';

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

/** 获取N天前的日期 YYYYMMDD */
function getDaysAgoCompact(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** 报告期前后关系（0331→上年1231，其余回退一个季度） */
function prevPeriod(period: string): string {
    const y = Number(period.slice(0, 4));
    const md = period.slice(4);
    if (md === '0331') return `${y - 1}1231`;
    const seq: Record<string, string> = { '0630': '0331', '0930': '0630', '1231': '0930' };
    return `${y}${seq[md] || '0930'}`;
}

/** 最近 N 个已结束报告期（YYYYMMDD），从当前日期往前推 */
function getRecentPeriods(count: number): string[] {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1; // 1-12
    const d = now.getDate();
    const quarters: Array<[string, number, number]> = [['0331', 3, 31], ['0630', 6, 30], ['0930', 9, 30], ['1231', 12, 31]];

    // 当前已结束的最近报告期
    let period: string | null = null;
    for (let i = quarters.length - 1; i >= 0; i--) {
        const [md, qm, qd] = quarters[i];
        if (m > qm || (m === qm && d >= qd)) {
            period = `${y}${md}`;
            break;
        }
    }
    if (!period) period = `${y - 1}1231`; // 一季度末尚未到来（1/1-3/30）→ 上一年年报

    const periods: string[] = [period];
    for (let i = 1; i < count; i++) {
        period = prevPeriod(period);
        periods.push(period);
    }
    return periods;
}

interface ProcessResult {
    updated: number;
    skipped: number;
    errors: number;
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
        const today = new Date().toISOString().slice(0, 10);
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
            // 主路径：按"昨日"各源批量增量（formal ← actual_date / express ← express_vip 筛 ann_date）
            let result = await this.processSingleDay(yesterdayCompact);

            // 兜底：昨日各源均无新增时，用前 2 个自然日窗口重扫补漏（仍按日期批量，轻量）
            if (result.updated === 0) {
                const fallbackDate = getDaysAgoCompact(2);
                console.log(`[PerformanceReportAutoUpdate] 昨日无新增，前 2 日兜底重扫: ${fallbackDate}`);
                const fallback = await this.processSingleDay(fallbackDate);
                result = {
                    updated: result.updated + fallback.updated,
                    skipped: result.skipped + fallback.skipped,
                    errors: result.errors + fallback.errors,
                };
            }

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
     * 处理单个目标日期：formal + express 两源批量增量，命中股票补算 ai_tag
     */
    private static async processSingleDay(dateCompact: string): Promise<ProcessResult> {
        // 命中且需要补 ai_tag 的股票（按 symbol 去重）
        const symbolsToTag = new Set<string>();

        const express = await this.processExpress(dateCompact, symbolsToTag);
        const formal = await this.processFormal(dateCompact, symbolsToTag);

        // 对命中股票补算 ai_tag（新插入报告 + 历史空标签补偿）
        let tagErrors = 0;
        for (const symbol of symbolsToTag) {
            try {
                await this.updateAiTags(symbol);
            } catch (err: any) {
                tagErrors++;
                console.warn(`[PerformanceReportAutoUpdate] ${symbol} ai_tag 计算失败: ${err.message}`);
            }
        }

        return {
            updated: express.updated + formal.updated,
            skipped: express.skipped + formal.skipped,
            errors: express.errors + formal.errors + tagErrors,
        };
    }

    /**
     * 业绩快报 express ← express_vip（最近两个报告期全量分页 + 客户端筛 ann_date=目标日期）
     */
    private static async processExpress(dateCompact: string, symbolsToTag: Set<string>): Promise<ProcessResult> {
        const periods = getRecentPeriods(2);
        const nameCache = new Map<string, string>();
        let updated = 0;
        let skipped = 0;
        let errors = 0;

        for (const period of periods) {
            let rows: ExpressVipRow[];
            try {
                rows = await getExpressVip(period);
            } catch (err: any) {
                errors++;
                console.warn(`[PerformanceReportAutoUpdate] express_vip(${period}) 获取失败: ${err.message}`);
                continue;
            }
            console.log(`[PerformanceReportAutoUpdate] express_vip(${period}) 返回 ${rows.length} 行`);

            for (const row of rows) {
                const annDate = String(row.ann_date || '').replace(/-/g, '');
                if (annDate !== dateCompact) continue;

                const symbol = tsCodeToSymbol(row.ts_code);
                if (!/^\d{6}$/.test(symbol)) continue;

                const exists = await this.checkExists(symbol, 'express', annDate);
                if (exists) {
                    skipped++;
                    continue;
                }

                try {
                    if (!nameCache.has(symbol)) {
                        nameCache.set(symbol, await this.getStockName(symbol));
                    }
                    const stockName = nameCache.get(symbol) || '';

                    await pool.query(
                        `INSERT INTO performance_reports
                         (symbol, stock_name, report_type, ann_date, end_date,
                          total_revenue, n_income, n_income_attr_p, basic_eps, summary, created_at)
                         VALUES ($1, $2, 'express', $3, $4, $5, $6, $7, $8, $9, NOW())
                         ON CONFLICT (symbol, report_type, ann_date) DO NOTHING`,
                        [
                            symbol,
                            stockName,
                            annDate,
                            String(row.end_date || '').replace(/-/g, ''),
                            row.revenue ?? null,
                            row.n_income ?? null,
                            // express_vip 无归母净利润字段，用净利润近似
                            row.n_income ?? null,
                            row.diluted_eps ?? null,
                            row.perf_summary || '',
                        ]
                    );
                    updated++;
                    symbolsToTag.add(symbol);
                } catch (err: any) {
                    errors++;
                    console.warn(`[PerformanceReportAutoUpdate] ${symbol} express 插入失败: ${err.message}`);
                }
            }
        }

        return { updated, skipped, errors };
    }

    /**
     * 业绩正式报告 formal ← disclosure_date.actual_date=目标日期 全市场发现，命中后逐股拉 income
     */
    private static async processFormal(dateCompact: string, symbolsToTag: Set<string>): Promise<ProcessResult> {
        let rows: DisclosureDateRow[];
        try {
            rows = await getDisclosureDate({ actual_date: dateCompact });
        } catch (err: any) {
            console.warn(`[PerformanceReportAutoUpdate] disclosure_date(actual_date=${dateCompact}) 获取失败: ${err.message}`);
            return { updated: 0, skipped: 0, errors: 1 };
        }

        // 去重 + 过滤合法 A 股代码
        const symbols = Array.from(new Set(rows.map(r => tsCodeToSymbol(r.ts_code)))).filter(s => /^\d{6}$/.test(s));
        console.log(`[PerformanceReportAutoUpdate] disclosure_date 命中 ${symbols.length} 只股票`);

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
                    // income 只能按股取：近 7 天窗口，只采纳 ann_date=目标日期 的行
                    const incomeRows = await getIncome(symbol, getDaysAgoCompact(7));
                    const hit = incomeRows.filter(r => String(r.ann_date || '').replace(/-/g, '') === dateCompact);
                    if (hit.length === 0) {
                        skipped++;
                        continue;
                    }

                    const stockName = await PerformanceReportAutoUpdateService.getStockName(symbol);
                    let hasNew = false;
                    for (const row of hit) {
                        const annDate = String(row.ann_date || '').replace(/-/g, '');
                        const exists = await PerformanceReportAutoUpdateService.checkExists(symbol, 'formal', annDate);
                        if (exists) {
                            skipped++;
                            continue;
                        }

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
                                String(row.end_date || '').replace(/-/g, ''),
                                row.total_revenue ?? null,
                                row.n_income ?? null,
                                row.n_income_attr_p ?? null,
                                row.basic_eps ?? null,
                            ]
                        );
                        hasNew = true;
                    }

                    if (hasNew) {
                        updated++;
                        symbolsToTag.add(symbol);
                    } else {
                        skipped++;
                    }
                } catch (err: any) {
                    errors++;
                    console.warn(`[PerformanceReportAutoUpdate] ${symbol} formal 更新失败: ${err.message}`);
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
        }
    }

    /** 是否正在运行 */
    static isRunning(): boolean {
        return this.running;
    }
}
