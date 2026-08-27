/**
 * 业绩报告自动更新服务
 *
 * 每天凌晨 00:00 定时执行，从 Tushare 获取业绩预告/快报 + 正式报告数据。
 *
 * 架构（2026-08 重构）：**放弃"候选池"**。旧方案是拉一个大候选名单（研报+自选股），对每只候选股
 * 依次查 income+forecast+report_rc 三接口（候选数×3 次调用，又沉又慢，还因依赖研报导致正式财报
 * 滞后——多氟多 8.18 披露被 8.21 才发现）。现改为**按日期增量发现，各类型只查自己的发现源**：
 *
 * - 业绩正式报告（formal）：`disclosure_date.actual_date=昨日` 全市场发现 → 对命中的股票逐只拉 `income` 明细
 *   （`actual_date` 是真实披露日，T+1 权威发现，根治滞后；income 不能批量只能按股，故只在 discovery 命中时拉）
 * - 业绩预告（express←forecast）：`forecast.ann_date=昨日` 批量发现，行内自带净利润范围+摘要，无需按股
 * - 业绩快报（express←express_vip）：`express_vip(end_date=当前季)` 全量分页，客户端过滤 `ann_date=昨日`；
 *   express 普通接口只能按股，express_vip 可一次返回某报告期全部公司（不含 ISSN/每日过滤能力）
 * - 研发评级（rating）：`report_rc.report_date=昨日` 批量发现，行内自带评级/EPS
 *
 * 四源各自 INSERT+通知，已存在（symbol+report_type+ann_date）跳过，通知 sourceKey 幂等。
 * 若某日四源均无新增，回退用前 2 个自然日的日期窗口重扫补漏（仍是按日期批量，轻量）。
 *
 * 关键事实（实测验证）：`forecast`/`report_rc`/`disclosure_date` 支持按日期全市场批查；
 * `express_vip` 按 end_date/quarter 全量（不按 ann_date）；`income`/`cashflow`/`balancesheet`/express 都必须传 ts_code。
 * `express`（快报）与 `forecast`（预告）目标公司基本不重叠（银行/券商常发快报但从不发预告），故两者都需要。
 *
 * 字段说明：
 * - 快报/预告（report_type='express'）：预告走 forecast（summary+net_profit_max），快报走 express_vip（n_income+revenue）
 * - 正式报告（report_type='formal'）：income 明细
 * - 评级（report_type='rating'）：report_rc
 * - 预披露提醒（reportType='disclosure-schedule'）：disclosure_date.pre_date 前瞻通知
 */

import pool from '../../core/db';
import { CacheService } from '../../shared/utils/CacheService';
import { NotificationService } from '../../core/notification/NotificationService';
import {
    getIncome, getReportRc, getDisclosureDate, getForecastByAnnDate, getExpressVip,
    type DisclosureDateRow,
} from '../quote/TushareService';
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

/** 获取N天前的日期字符串 YYYYMMDD（N=1即昨天） */
function getDaysAgoCompact(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return shanghaiDateYyyymmdd(d);
}

function annDateToIso(annDate: string): string | undefined {
    if (!/^\d{8}$/.test(annDate)) return undefined;
    const date = new Date(
        `${annDate.slice(0, 4)}-${annDate.slice(4, 6)}-${annDate.slice(6, 8)}T00:00:00+08:00`,
    );
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** 由报告期 end_date（YYYYMMDD）生成中文期间标签（用于预披露提醒标题） */
function periodLabel(endDate: string): string {
    const mmdd = endDate.slice(4);
    switch (mmdd) {
        case '0331': return '一季报';
        case '0630': return '中报';
        case '0930': return '三季报';
        case '1231': return '年报';
        default: return '定期报告';
    }
}

/** 由当前日期推导"最近已完成的两个报告期"（用于 express_vip 批量拉取的窗口） */
function expressVipEndDates(): string[] {
    const d = new Date();
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    let latestY: number, latestQ: number;
    if (m <= 3) {
        latestY = y - 1;
        latestQ = 4;
    } else {
        latestY = y;
        latestQ = Math.floor((m - 1) / 3); // 4-6月->1季度, 7-9月->2季度, 10-12月->3季度
    }
    const prevQ = latestQ === 1 ? 4 : latestQ - 1;
    const prevY = prevQ === 4 ? latestY - 1 : latestY;
    const map = { 1: '0331', 2: '0630', 3: '0930', 4: '1231' } as Record<number, string>;
    return [`${latestY}${map[latestQ]}`, `${prevY}${map[prevQ]}`];
}

export class PerformanceReportAutoUpdateService {
    private static running = false;

    /**
     * 执行自动更新：按日期增量发现（无候选池），四源各自更新
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
        console.log(`[PerformanceReportAutoUpdate] 开始执行，目标日期: ${getYesterdayStr()}`);

        try {
            // 预披露提醒（今日/未来预计披露的正式财报，前瞻通知）——与昨日披露无关，每天必跑
            try {
                const preCount = await PerformanceReportAutoUpdateService.sendPreDisclosureReminders();
                console.log(`[PerformanceReportAutoUpdate] 预披露提醒完成: ${preCount} 条`);
            } catch (err: any) {
                console.warn(`[PerformanceReportAutoUpdate] 预披露提醒失败: ${err.message}`);
            }

            // 主流程：按昨日日期增量发现并更新四类数据
            const totals = await PerformanceReportAutoUpdateService.processSingleDay(getDaysAgoCompact(1));

            // 兜底：若昨日四源均无新增（如某源前一天接口异常 / 数据延迟），用前 2 个自然日窗口重扫补漏
            // 仍是按日期批量，轻量；INSERT 幂等（checkExists / ON CONFLICT / sourceKey），不会重复通知
            if (totals.updated === 0) {
                for (const age of [2, 3]) {
                    const caught = await PerformanceReportAutoUpdateService.processSingleDay(getDaysAgoCompact(age));
                    totals.updated += caught.updated;
                    totals.skipped += caught.skipped;
                    totals.errors += caught.errors;
                }
                console.log(`[PerformanceReportAutoUpdate] 昨日无新增，前拉补漏完成: 更新 ${totals.updated}`);
            }

            // 标记今天已执行
            await CacheService.put('performance_report:auto_update:date', today, 25 * 3600);

            console.log(`[PerformanceReportAutoUpdate] 完成: 更新 ${totals.updated}, 跳过 ${totals.skipped}, 失败 ${totals.errors}`);
            this.running = false;
            return totals;
        } catch (err: any) {
            console.error('[PerformanceReportAutoUpdate] 执行失败:', err.message);
            this.running = false;
            throw err;
        }
    }

    /**
     * 对某一天做四类数据的增量发现与更新（无候选池：每类只查自己的发现源）
     */
    private static async processSingleDay(day: string): Promise<{ updated: number; skipped: number; errors: number }> {
        let updated = 0;
        let skipped = 0;
        let errors = 0;
        // 记录当日新增了业绩记录的股票，供末尾统一补算 ai_tag
        const affectedSymbols = new Set<string>();

        // ---------- 1. 业绩预告（express）← forecast.ann_date 批量 ----------
        try {
            const forecastRows = await getForecastByAnnDate(day);
            for (const row of forecastRows) {
                const symbol = tsCodeToSymbol(row.ts_code);
                if (!/^\d{6}$/.test(symbol)) continue;
                const annDate = row.ann_date?.replace(/-/g, '');
                if (!annDate) continue;
                const stockName = await PerformanceReportAutoUpdateService.getStockName(symbol);
                const exists = await PerformanceReportAutoUpdateService.checkExists(symbol, 'express', annDate);
                if (exists) { skipped++; continue; }
                await pool.query(
                    `INSERT INTO performance_reports
                     (symbol, stock_name, report_type, ann_date, end_date, summary, n_income_attr_p, created_at)
                     VALUES ($1, $2, 'express', $3, $4, $5, $6, NOW())
                     ON CONFLICT (symbol, report_type, ann_date) DO NOTHING`,
                    [symbol, stockName, annDate, row.end_date?.replace(/-/g, '') || '', row.summary || '', row.net_profit_max ?? null],
                );
                await PerformanceReportAutoUpdateService.notifyFor(
                    symbol, stockName || symbol, annDate,
                    `${stockName || symbol}：业绩预告更新`,
                    row.summary || `公告日期 ${annDate}`,
                    'express',
                );
                updated++;
                affectedSymbols.add(symbol);
            }
        } catch (err: any) {
            errors++;
            console.warn(`[PerformanceReportAutoUpdate] ${day} 业绩预告(forecast)更新失败: ${err.message}`);
        }

        // ---------- 2. 业绩正式报告（formal）← disclosure_date.actual_date 发现 → 逐股 income 明细 ----------
        try {
            const disclosed = await getDisclosureDate({ actual_date: day });
            const symbols = Array.from(new Set(
                disclosed.map(r => tsCodeToSymbol(r.ts_code)).filter(s => /^\d{6}$/.test(s)),
            ));
            const incomeStart = getDaysAgoCompact(7); // 限制每个 income 拉取窗口，只取该日披露的正式财报
            const queue = [...symbols];
            const concurrency = 3;
            async function worker() {
                while (queue.length > 0) {
                    const symbol = queue.shift();
                    if (!symbol) break;
                    try {
                        const incomeRows = await getIncome(symbol, incomeStart);
                        const stockName = await PerformanceReportAutoUpdateService.getStockName(symbol);
                        for (const row of incomeRows) {
                            const annDate = row.ann_date?.replace(/-/g, '');
                            if (!annDate || annDate !== day) continue; // 只取该披露日的正式财报
                            if (await PerformanceReportAutoUpdateService.checkExists(symbol, 'formal', annDate)) continue;
                            await pool.query(
                                `INSERT INTO performance_reports
                                 (symbol, stock_name, report_type, ann_date, end_date,
                                  total_revenue, n_income, n_income_attr_p, basic_eps, created_at)
                                 VALUES ($1, $2, 'formal', $3, $4, $5, $6, $7, $8, NOW())
                                 ON CONFLICT (symbol, report_type, ann_date) DO NOTHING`,
                                [symbol, stockName, annDate, row.end_date?.replace(/-/g, '') || '',
                                 row.total_revenue ?? null, row.n_income ?? null, row.n_income_attr_p ?? null, row.basic_eps ?? null],
                            );
                            await PerformanceReportAutoUpdateService.notifyFor(
                                symbol, stockName || symbol, annDate,
                                `${stockName || symbol}：财报披露`,
                                `公告日期 ${annDate}`,
                                'formal',
                            );
                            updated++;
                            affectedSymbols.add(symbol);
                        }
                    } catch (err: any) {
                        errors++;
                        console.warn(`[PerformanceReportAutoUpdate] ${symbol} 正式报告(income)更新失败: ${err.message}`);
                    }
                    await new Promise(r => setTimeout(r, 500));
                }
            }
            await Promise.all(Array.from({ length: concurrency }, () => worker()));
        } catch (err: any) {
            errors++;
            console.warn(`[PerformanceReportAutoUpdate] ${day} 正式报告(disclosure_date)发现失败: ${err.message}`);
        }

        // ---------- 3. 业绩快报（express）← express_vip 全量(最近两报告期) → 过滤 ann_date=day ----------
        try {
            const seen = new Set<string>();
            for (const endDate of expressVipEndDates()) {
                const rows = await getExpressVip(endDate);
                for (const row of rows) {
                    const annDate = row.ann_date?.replace(/-/g, '');
                    if (annDate !== day) continue; // 只在"昨日公告的快报"里取
                    const symbol = tsCodeToSymbol(row.ts_code);
                    if (!/^\d{6}$/.test(symbol)) continue;
                    const key = `${symbol}:${annDate}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const stockName = await PerformanceReportAutoUpdateService.getStockName(symbol);
                    if (await PerformanceReportAutoUpdateService.checkExists(symbol, 'express', annDate)) { skipped++; continue; }
                    await pool.query(
                        `INSERT INTO performance_reports
                         (symbol, stock_name, report_type, ann_date, end_date,
                          total_revenue, n_income_attr_p, summary, created_at)
                         VALUES ($1, $2, 'express', $3, $4, $5, $6, $7, NOW())
                         ON CONFLICT (symbol, report_type, ann_date) DO NOTHING`,
                        [symbol, stockName, annDate, row.end_date?.replace(/-/g, '') || '',
                         row.revenue ?? null, row.n_income ?? null, `业绩快报，公告日期 ${annDate}`],
                    );
                    await PerformanceReportAutoUpdateService.notifyFor(
                        symbol, stockName || symbol, annDate,
                        `${stockName || symbol}：业绩快报更新`,
                        `业绩快报，公告日期 ${annDate}`,
                        'express',
                    );
                    updated++;
                    affectedSymbols.add(symbol);
                }
            }
        } catch (err: any) {
            errors++;
            console.warn(`[PerformanceReportAutoUpdate] ${day} 业绩快报(express_vip)更新失败: ${err.message}`);
        }

        // ---------- 4. 研发评级（rating）← report_rc.report_date 批量 ----------
        try {
            const ratingRows = await getReportRc({ report_date: day });
            for (const row of ratingRows) {
                const symbol = tsCodeToSymbol(row.ts_code);
                if (!/^\d{6}$/.test(symbol)) continue;
                const reportDate = row.report_date?.replace(/-/g, '');
                if (!reportDate || !row.eps) continue;
                const stockName = await PerformanceReportAutoUpdateService.getStockName(symbol);
                const exists = await PerformanceReportAutoUpdateService.checkExists(symbol, 'rating', reportDate);
                if (exists) { skipped++; continue; }
                await pool.query(
                    `INSERT INTO performance_reports
                     (symbol, stock_name, report_type, ann_date, end_date,
                      forecast_eps, rating, org_name, created_at)
                     VALUES ($1, $2, 'rating', $3, $4, $5, $6, $7, NOW())
                     ON CONFLICT (symbol, report_type, ann_date) DO NOTHING`,
                    [symbol, stockName, reportDate, row.quarter || '',
                     row.eps ?? null, row.rating || '', row.org_name || ''],
                );
                await PerformanceReportAutoUpdateService.notifyFor(
                    symbol, stockName || symbol, reportDate,
                    `${stockName || symbol}：研报评级更新`,
                    `${row.org_name || ''} ${row.rating || ''}`.trim() || `研报日期 ${reportDate}`,
                    'rating',
                );
                updated++;
            }
        } catch (err: any) {
            errors++;
            console.warn(`[PerformanceReportAutoUpdate] ${day} 研发评级(report_rc)更新失败: ${err.message}`);
        }

        // ---------- 末尾统一补算 ai_tag（仅对当日新增业绩记录的股票） ----------
        for (const symbol of affectedSymbols) {
            try {
                await PerformanceReportAutoUpdateService.updateAiTags(symbol);
            } catch (err: any) {
                console.warn(`[PerformanceReportAutoUpdate] ${symbol} ai_tag 补算失败: ${err.message}`);
            }
        }

        return { updated, skipped, errors };
    }

    /** 统一的入库通知封装（不抛错，失败仅告警，不中断主流程） */
    private static async notifyFor(
        symbol: string, stockName: string, annDate: string,
        title: string, summary: string, reportType: string,
    ): Promise<void> {
        try {
            await NotificationService.createForWatchers({
                category: 'performance_report',
                sourceKey: `performance-report:${symbol}:${reportType}:${annDate}`,
                symbol,
                stockName,
                title,
                summary,
                targetPath: `/modules/favorites/pages/detail?symbol=${encodeURIComponent(symbol)}&anchor=performance-report`,
                payload: { reportType, annDate },
                occurredAt: annDateToIso(annDate),
            });
        } catch (error) {
            console.warn('[PerformanceReportAutoUpdate] App notification failed:', error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * 预披露提醒：今日/未来预计披露正式财报的股票，前瞻通知给订阅者。
     * 用 disclosure_date.pre_date 拉取未来几日的披露计划，过滤「尚未实际披露（actual_date 为空）」的股票，
     * 对订阅者 createForWatchers 推送。预披露日期是事先公布的，天然不会产生"8.18 公告 8.21 才知"的滞后。
     */
    private static async sendPreDisclosureReminders(): Promise<number> {
        const today = new Date();
        interface Reminder { symbol: string; endDate: string; preDate: string; }
        const reminderMap = new Map<string, Reminder>();
        for (let k = 0; k < 3; k++) {
            const d = new Date(today);
            d.setDate(d.getDate() + k);
            const day = shanghaiDateYyyymmdd(d);
            let rows: DisclosureDateRow[];
            try {
                rows = await getDisclosureDate({ pre_date: day });
            } catch (err: any) {
                console.warn(`[PerformanceReportAutoUpdate] 预披露查询 ${day} 失败: ${err.message}`);
                break;
            }
            for (const row of rows) {
                if (row.actual_date) continue; // 已披露不再提醒
                const symbol = tsCodeToSymbol(row.ts_code);
                if (!/^\d{6}$/.test(symbol)) continue;
                reminderMap.set(`${symbol}:${row.end_date}`, { symbol, endDate: row.end_date, preDate: row.pre_date });
            }
            await new Promise(r => setTimeout(r, 500));
        }
        if (reminderMap.size === 0) return 0;

        const symbols = Array.from(new Set(Array.from(reminderMap.values()).map(r => r.symbol)));
        const nameResult = await pool.query(
            `SELECT symbol, name FROM stocks WHERE symbol = ANY($1::text[])`,
            [symbols],
        );
        const nameMap = new Map<string, string>();
        for (const row of nameResult.rows as { symbol: string; name: string }[]) {
            nameMap.set(row.symbol, row.name);
        }

        let notified = 0;
        for (const rem of reminderMap.values()) {
            const stockName = nameMap.get(rem.symbol) || rem.symbol;
            try {
                const n = await NotificationService.createForWatchers({
                    category: 'performance_report',
                    sourceKey: `performance-report-pre:${rem.symbol}:${rem.endDate}`,
                    symbol: rem.symbol,
                    stockName,
                    title: `${stockName}：预计披露${periodLabel(rem.endDate)}`,
                    summary: `预计披露日期 ${rem.preDate}`,
                    targetPath: `/modules/favorites/pages/detail?symbol=${encodeURIComponent(rem.symbol)}&anchor=performance-report`,
                    payload: { reportType: 'disclosure-schedule', preDate: rem.preDate, endDate: rem.endDate },
                    occurredAt: annDateToIso(rem.preDate),
                });
                notified += n;
            } catch (error) {
                console.warn('[PerformanceReportAutoUpdate] 预披露提醒通知失败:', error instanceof Error ? error.message : String(error));
            }
        }
        return notified;
    }

    /** 检查记录是否已存在 */
    private static async checkExists(symbol: string, reportType: string, annDate: string): Promise<boolean> {
        const result = await pool.query(
            `SELECT 1 FROM performance_reports WHERE symbol = $1 AND report_type = $2 AND ann_date = $3 LIMIT 1`,
            [symbol, reportType, annDate],
        );
        return result.rows.length > 0;
    }

    /** 获取股票名称 */
    private static async getStockName(symbol: string): Promise<string> {
        try {
            const result = await pool.query(
                `SELECT name FROM stocks WHERE symbol = $1 LIMIT 1`,
                [symbol],
            );
            return result.rows[0]?.name || '';
        } catch {
            return '';
        }
    }

    /**
     * 更新指定股票所有最新报告的 ai_tag（用 AiTagService 计算并写库）
     */
    private static async updateAiTags(symbol: string): Promise<void> {
        const formalRows = await pool.query(
            `SELECT end_date, total_revenue, n_income_attr_p, report_type
             FROM performance_reports
             WHERE symbol = $1 AND report_type IN ('formal', 'express')
               AND n_income_attr_p IS NOT NULL
             ORDER BY end_date ASC`,
            [symbol],
        );
        if (formalRows.rows.length === 0) return;

        for (const row of formalRows.rows) {
            let tag: string;
            if (row.report_type === 'formal') {
                tag = await AiTagService.computeForFormal(
                    symbol, row.end_date, row.total_revenue, row.n_income_attr_p,
                );
            } else {
                tag = await AiTagService.computeForExpress(symbol, row.end_date, row.n_income_attr_p);
            }
            await pool.query(
                `UPDATE performance_reports SET ai_tag = $1
                 WHERE symbol = $2 AND end_date = $3 AND report_type = $4`,
                [tag, symbol, row.end_date, row.report_type],
            );
        }
    }

    /** 是否正在运行 */
    static isRunning(): boolean {
        return this.running;
    }
}