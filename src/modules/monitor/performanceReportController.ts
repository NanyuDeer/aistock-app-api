/**
 * 业绩报告查询 Controller
 *
 * 提供业绩报告（快报+正式报告+研报评级）的列表查询、搜索、手动刷新接口。
 * 数据来源：Tushare，每日凌晨自动更新。
 */

import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import pool from '../../core/db';
import { PerformanceReportAutoUpdateService } from './PerformanceReportAutoUpdateService';
import { AiAnalysisService } from './AiAnalysisService';
import { AiScoreService } from './AiScoreService';

interface ReportRow {
    symbol: string;
    stock_name: string;
    report_type: string;
    ann_date: string;
    end_date: string;
    forecast_eps: number | null;
    rating: string;
    org_name: string;
    summary: string;
    total_revenue: number | null;
    n_income: number | null;
    n_income_attr_p: number | null;
    basic_eps: number | null;
    created_at: string;
    ai_tag: string | null;
    ai_score: number | null;
    revenue_yoy: number | null;
    profit_yoy: number | null;
}

type ReportSortBy = 'symbol' | 'ann_date' | 'total_revenue' | 'n_income_attr_p' | 'forecast_eps' | 'ai_score';
type ReportSortOrder = 'asc' | 'desc';

interface CommonListParams {
    page: number;
    pageSize: number;
    sortBy: ReportSortBy;
    sortOrder: ReportSortOrder;
}

/**
 * 根据当前日期计算最近已结束的报告期（YYYYMMDD 格式）
 * 报告期结束日：03-31（一季报）、06-30（半年报）、09-30（三季报）、12-31（年报）
 * 例：2026-08-07（Q3）→ 20260630（2026半年报）；2026-02-01 → 20251231（2025年报）
 */
function currentReportPeriod(now: Date = new Date()): string {
    const y = now.getFullYear();
    const m = now.getMonth() + 1; // 1-12
    const d = now.getDate();
    const quarters: Array<[number, number]> = [[3, 31], [6, 30], [9, 30], [12, 31]];
    // 从当年最后一个季度末往前找第一个不晚于当前日期的报告期
    for (let i = quarters.length - 1; i >= 0; i--) {
        const [qm, qd] = quarters[i];
        if (m > qm || (m === qm && d >= qd)) {
            return `${y}${String(qm).padStart(2, '0')}${qd}`;
        }
    }
    // 一季度末尚未到来（1/1-3/30）→ 上一年的年报
    return `${y - 1}1231`;
}

const LATEST_REPORT_CTE = `
    WITH latest AS (
        SELECT p.symbol, p.stock_name, p.report_type, p.ann_date, p.end_date,
               p.forecast_eps, p.rating, p.org_name, p.summary,
               p.total_revenue, p.n_income, p.n_income_attr_p, p.basic_eps, p.created_at, p.ai_tag,
               s.total_score AS ai_score,
               -- 同比：相对上一期（end_date 更早的最近一份报告）
               CASE WHEN p.total_revenue IS NOT NULL
                         AND prev.total_revenue IS NOT NULL AND prev.total_revenue <> 0
                    THEN ((p.total_revenue - prev.total_revenue) / ABS(prev.total_revenue) * 100)::float8
                    ELSE NULL END AS revenue_yoy,
               CASE WHEN p.n_income_attr_p IS NOT NULL
                         AND prev.n_income_attr_p IS NOT NULL AND prev.n_income_attr_p <> 0
                    THEN ((p.n_income_attr_p - prev.n_income_attr_p) / ABS(prev.n_income_attr_p) * 100)::float8
                    ELSE NULL END AS profit_yoy
        FROM performance_reports p
        LEFT JOIN stock_ai_scores s ON p.symbol = s.symbol
        INNER JOIN (
            SELECT symbol, report_type, MAX(ann_date) AS latest_ann_date
            FROM performance_reports
            GROUP BY symbol, report_type
        ) m ON p.symbol = m.symbol AND p.report_type = m.report_type AND p.ann_date = m.latest_ann_date
        LEFT JOIN LATERAL (
            SELECT total_revenue, n_income_attr_p
            FROM performance_reports
            WHERE symbol = p.symbol
              AND report_type IN ('formal', 'express')
              AND end_date IS NOT NULL AND end_date != ''
              AND end_date < p.end_date
            ORDER BY end_date DESC, report_type DESC
            LIMIT 1
        ) prev ON true
    )
`;

// ================================================================
// 业绩排序评分模型（多因子加权，总分 100）
// 维度：净利同比 35 / 营收同比 25 / 盈利质量 20 / 增长加速度 10 / 报告可靠性 10
// ================================================================

/** 维度一：净利润同比增长率（35分） */
function scoreNetProfitGrowth(yoyGrowth: number | null, opts?: { prevProfit: number | null; curProfit: number | null; abnormal: boolean }): number {
    // 特殊处理
    if (opts) {
        const { prevProfit, curProfit, abnormal } = opts;
        if (prevProfit !== null && prevProfit < 0 && curProfit !== null && curProfit > 0) return 30; // 扭盈
        if (prevProfit !== null && prevProfit > 0 && curProfit !== null && curProfit < 0) return 0;   // 转亏
        if (abnormal) return 14; // 基数异常，给中位数
    }
    if (yoyGrowth === null || yoyGrowth === undefined) return 0;

    if (yoyGrowth >= 100) return 35;
    if (yoyGrowth >= 50) return 28 + (yoyGrowth - 50) * 0.14;
    if (yoyGrowth >= 20) return 20 + (yoyGrowth - 20) * 0.27;
    if (yoyGrowth >= 0) return 14 + yoyGrowth * 0.30;
    if (yoyGrowth >= -20) return 7 + (yoyGrowth + 20) * 0.35;
    if (yoyGrowth >= -50) return (yoyGrowth + 50) * 0.23;
    return 0;
}

/** 维度二：营收同比增长率（25分） */
function scoreRevenueGrowth(yoyGrowth: number | null): number {
    if (yoyGrowth === null || yoyGrowth === undefined) return 12; // 缺失给中位数

    if (yoyGrowth >= 50) return 25;
    if (yoyGrowth >= 30) return 20 + (yoyGrowth - 30) * 0.25;
    if (yoyGrowth >= 15) return 15 + (yoyGrowth - 15) * 0.33;
    if (yoyGrowth >= 0) return 10 + yoyGrowth * 0.33;
    if (yoyGrowth >= -15) return 5 + (yoyGrowth + 15) * 0.33;
    if (yoyGrowth >= -30) return (yoyGrowth + 30) * 0.33;
    return 0;
}

/** 维度三：盈利质量（20分）——净利率(10) + ROE(10) */
function scoreProfitability(netMargin: number | null, roe: number | null): number {
    let marginScore = 0;
    if (netMargin !== null && netMargin !== undefined) {
        if (netMargin >= 30) marginScore = 10;
        else if (netMargin >= 20) marginScore = 8 + (netMargin - 20) * 0.2;
        else if (netMargin >= 10) marginScore = 5 + (netMargin - 10) * 0.3;
        else if (netMargin >= 0) marginScore = netMargin * 0.5;
        else marginScore = 0;
    }

    let roeScore = 0;
    if (roe !== null && roe !== undefined) {
        if (roe >= 20) roeScore = 10;
        else if (roe >= 15) roeScore = 8 + (roe - 15) * 0.4;
        else if (roe >= 10) roeScore = 5 + (roe - 10) * 0.6;
        else if (roe >= 0) roeScore = roe * 0.5;
        else roeScore = 0;
    }

    if (netMargin !== null && netMargin !== undefined && roe !== null && roe !== undefined) return marginScore + roeScore;
    if (netMargin !== null && netMargin !== undefined) return marginScore + 5;
    if (roe !== null && roe !== undefined) return 5 + roeScore;
    return 10; // 都缺失给中位数
}

/** 维度四：增长加速度（10分）——本期净利同比 - 上期净利同比 */
function scoreGrowthAcceleration(currentGrowth: number | null, previousGrowth: number | null): number {
    if (currentGrowth === null || currentGrowth === undefined || previousGrowth === null || previousGrowth === undefined) return 5;
    const delta = currentGrowth - previousGrowth;
    if (delta >= 30) return 10;
    if (delta >= 15) return 8 + (delta - 15) * 0.13;
    if (delta >= 0) return 6 + delta * 0.13;
    if (delta >= -15) return 4 + (delta + 15) * 0.13;
    if (delta >= -30) return (delta + 30) * 0.13;
    return 0;
}

/** 维度五：报告可靠性（10分） */
function scoreReportReliability(reportType: string): number {
    switch (reportType) {
        case 'formal': return 10;
        case 'express': return 7;
        default: return 4;
    }
}

/** 同比增速计算：上期为 0 → 返回 null 并标记基数异常 */
function calcYoy(current: number | null, previous: number | null): { value: number | null; abnormal: boolean } {
    if (current === null || current === undefined || previous === null || previous === undefined) return { value: null, abnormal: false };
    if (previous === 0) return { value: null, abnormal: true };
    return { value: ((current - previous) / Math.abs(previous)) * 100, abnormal: false };
}

/** 报告期格式化：20260630 → 2026半年报 */
function formatReportPeriod(period: string): string {
    if (!period || period.length < 8) return period || '';
    const y = period.slice(0, 4);
    const m = period.slice(4, 6);
    if (m === '03') return `${y}一季报`;
    if (m === '06') return `${y}半年报`;
    if (m === '09') return `${y}三季报`;
    if (m === '12') return `${y}年报`;
    return period;
}

export class PerformanceReportController {
    private static readonly DEFAULT_PAGE_SIZE = 50;
    private static readonly MAX_PAGE_SIZE = 500;
    private static readonly DEFAULT_SORT_BY: ReportSortBy = 'ann_date';
    private static readonly ALLOWED_SORT_BY = new Set<ReportSortBy>(['symbol', 'ann_date', 'total_revenue', 'n_income_attr_p', 'forecast_eps', 'ai_score']);
    private static readonly ALLOWED_SORT_ORDER = new Set<ReportSortOrder>(['asc', 'desc']);

    private static parseCommonListParams(url: URL): CommonListParams | { error: string } {
        const pageParam = url.searchParams.get('page');
        const pageSizeParam = url.searchParams.get('pageSize');
        const sortByRaw = (url.searchParams.get('sortBy') || PerformanceReportController.DEFAULT_SORT_BY).trim();
        const sortOrderRaw = (url.searchParams.get('sortOrder') || '').trim().toLowerCase();
        const reportType = url.searchParams.get('reportType') || '';

        let page = 1;
        if (pageParam) {
            const parsed = Number(pageParam);
            if (!Number.isInteger(parsed) || parsed < 1) return { error: 'Invalid page - page 必须是大于0的整数' };
            page = parsed;
        }

        let pageSize = PerformanceReportController.DEFAULT_PAGE_SIZE;
        if (pageSizeParam) {
            const parsed = Number(pageSizeParam);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > PerformanceReportController.MAX_PAGE_SIZE) return { error: `Invalid pageSize - pageSize 必须是 1-${PerformanceReportController.MAX_PAGE_SIZE} 的整数` };
            pageSize = parsed;
        }

        if (!PerformanceReportController.ALLOWED_SORT_BY.has(sortByRaw as ReportSortBy)) return { error: 'Invalid sortBy - 仅支持 symbol / ann_date / total_revenue / n_income_attr_p / forecast_eps / ai_score' };
        const sortBy = sortByRaw as ReportSortBy;

        const defaultOrder: ReportSortOrder = sortBy === 'symbol' ? 'asc' : 'desc';
        const finalSortOrder = (sortOrderRaw || defaultOrder) as ReportSortOrder;
        if (!PerformanceReportController.ALLOWED_SORT_ORDER.has(finalSortOrder)) return { error: 'Invalid sortOrder - 仅支持 asc 或 desc' };

        return { page, pageSize, sortBy, sortOrder: finalSortOrder };
    }

    private static buildOrderBy(sortBy: ReportSortBy, sortOrder: ReportSortOrder): string {
        const order = sortOrder.toUpperCase();
        if (sortBy === 'symbol') return `l.symbol ${order}`;
        if (sortBy === 'ann_date') return `l.ann_date ${order} NULLS LAST, l.symbol ASC`;
        if (sortBy === 'total_revenue') return `l.total_revenue IS NULL ASC, l.total_revenue ${order}, l.symbol ASC`;
        if (sortBy === 'forecast_eps') return `l.forecast_eps IS NULL ASC, l.forecast_eps ${order}, l.symbol ASC`;
        if (sortBy === 'ai_score') return `l.ai_score IS NULL ASC, l.ai_score ${order}, l.symbol ASC`;
        // n_income_attr_p 或默认
        return `l.n_income_attr_p IS NULL ASC, l.n_income_attr_p ${order}, l.symbol ASC`;
    }

    /**
     * 构建报告类型筛选条件
     * - formal：仅当前报告期（如 2026半年报）的正式报告
     * - express：仅当前报告期的快报，且排除同报告期已出正式报告的股票
     */
    private static buildReportTypeFilter(reportType: string): string {
        if (reportType === 'formal') {
            const period = currentReportPeriod();
            return ` AND l.report_type = 'formal' AND l.end_date = '${period}'`;
        }
        if (reportType === 'express') {
            const period = currentReportPeriod();
            return ` AND l.report_type = 'express' AND l.end_date = '${period}'
                AND NOT EXISTS (
                    SELECT 1 FROM performance_reports f
                    WHERE f.symbol = l.symbol AND f.report_type = 'formal' AND f.end_date = l.end_date
                )`;
        }
        return ` AND l.report_type IN ('formal', 'express')`;
    }

    private static mapReportRow(row: ReportRow) {
        return {
            '股票代码': row.symbol,
            '股票名称': row.stock_name || '',
            '报告类型': row.report_type === 'express' ? '快报/预告' : row.report_type === 'formal' ? '正式报告' : '研报评级',
            '报告发出时间': row.ann_date,
            '报告期': row.end_date || '',
            '预测EPS': row.forecast_eps,
            '评级': row.rating || '',
            '机构名称': row.org_name || '',
            '摘要': row.summary || '',
            '营业总收入': row.total_revenue,
            '净利润': row.n_income,
            '归母净利润': row.n_income_attr_p,
            '基本每股收益': row.basic_eps,
            'AI研判': row.ai_tag || '',
            'AI评分': row.ai_score,
            '营收同比(%)': row.revenue_yoy != null ? Math.round(Number(row.revenue_yoy) * 100) / 100 : null,
            '净利同比(%)': row.profit_yoy != null ? Math.round(Number(row.profit_yoy) * 100) / 100 : null,
            '更新时间': row.created_at,
        };
    }

    /**
     * 重算并回写四维评分缓存，保证列表卡片分数与详情页 ai-analysis 一致
     * 策略：仅对缓存缺失或非当天刷新的股票实时调用 AiScoreService 重算并回写；
     * partial/insufficient 等无评分状态写入 NULL（卡片不显示分数，与详情页一致）。
     */
    private static async refreshAiScores(rows: ReportRow[], list: Record<string, unknown>[]): Promise<void> {
        const symbols = [...new Set(rows.map(r => r.symbol))];
        if (!symbols.length) return;

        // 1. 缓存当天已刷新的直接使用，其余需要重算
        const cacheRes = await pool.query(
            `SELECT symbol FROM stock_ai_scores
             WHERE symbol = ANY($1) AND updated_at >= date_trunc('day', now())`,
            [symbols]
        );
        const freshSet = new Set<string>(cacheRes.rows.map(r => r.symbol as string));
        const needRefresh = symbols.filter(s => !freshSet.has(s));

        // 2. 并发重算并回写缓存（限制并发避免触发 Tushare 限频）
        const CONCURRENCY = 5;
        for (let i = 0; i < needRefresh.length; i += CONCURRENCY) {
            const chunk = needRefresh.slice(i, i + CONCURRENCY);
            await Promise.all(chunk.map(async (symbol) => {
                try {
                    const result = await AiScoreService.analyze(symbol);
                    await pool.query(
                        `INSERT INTO stock_ai_scores
                           (symbol, total_score, rating, dimensions, strengths, risks, data_period, report_count, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                         ON CONFLICT (symbol) DO UPDATE SET
                           total_score = EXCLUDED.total_score,
                           rating = EXCLUDED.rating,
                           dimensions = EXCLUDED.dimensions,
                           strengths = EXCLUDED.strengths,
                           risks = EXCLUDED.risks,
                           data_period = EXCLUDED.data_period,
                           report_count = EXCLUDED.report_count,
                           updated_at = NOW()`,
                        [symbol, result.score, result.rating,
                         JSON.stringify(result.dimensions),
                         result.strengths, result.risks,
                         result.dataPeriod, result.reportCount]
                    );
                } catch (e: any) {
                    console.warn(`[AiScore] 重算 ${symbol} 失败:`, e.message);
                }
            }));
        }

        // 3. 读取最新缓存分数，覆盖列表的 AI评分（与详情页实时计算保持一致）
        const scoreRes = await pool.query(
            `SELECT symbol, total_score FROM stock_ai_scores WHERE symbol = ANY($1)`,
            [symbols]
        );
        const scoreMap = new Map<string, number | null>();
        for (const row of scoreRes.rows) {
            scoreMap.set(row.symbol as string, row.total_score == null ? null : Number(row.total_score));
        }
        for (const item of list) {
            const symbol = String(item['股票代码'] || '');
            item['AI评分'] = scoreMap.has(symbol) ? scoreMap.get(symbol) : null;
        }
    }

    /**
     * GET /api/cn/stocks/performance-reports
     * 业绩报告列表
     */
    static async getReportList(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const url = new URL(req.originalUrl, `http://${req.get('host')}`);
        const parsed = this.parseCommonListParams(url);
        if ('error' in parsed) {
            createResponse(res, 400, parsed.error);
            return;
        }

        const { page, pageSize, sortBy, sortOrder } = parsed;
        const offset = (page - 1) * pageSize;
        const orderBy = this.buildOrderBy(sortBy, sortOrder);

        // 筛选条件
        const reportType = url.searchParams.get('reportType') || '';
        const reportTypeFilter = this.buildReportTypeFilter(reportType);
        const endYear = url.searchParams.get('endYear') || '';
        const endYearFilter = endYear ? ` AND l.end_date LIKE '${endYear}%'` : '';

        try {
            const countQuery = `${LATEST_REPORT_CTE} SELECT COUNT(*) AS total FROM latest l WHERE 1=1${reportTypeFilter}${endYearFilter}`;
            const countResult = await pool.query(countQuery);
            const total = Number(countResult.rows[0]?.total) || 0;
            const totalPages = Math.ceil(total / pageSize);

            const dataQuery = `${LATEST_REPORT_CTE}
                SELECT l.*
                FROM latest l
                WHERE 1=1${reportTypeFilter}${endYearFilter}
                ORDER BY ${orderBy}
                LIMIT $1 OFFSET $2`;
            const dataResult = await pool.query(dataQuery, [pageSize, offset]);

            const list = dataResult.rows.map(item => this.mapReportRow(item as ReportRow));
            // 重算并回写四维评分缓存，保证卡片分数与详情页一致
            await this.refreshAiScores(dataResult.rows as ReportRow[], list);
            createResponse(res, 200, 'success', {
                '数据源': 'PostgreSQL (Tushare)',
                '排序字段': sortBy,
                '排序方向': sortOrder,
                '当前页': page,
                '每页数量': pageSize,
                '总数量': total,
                '总页数': totalPages,
                '报告列表': list,
            });
        } catch (error: any) {
            createResponse(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
        }
    }

    /**
     * GET /api/cn/stocks/performance-reports/search
     * 搜索业绩报告
     */
    static async searchReportList(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const url = new URL(req.originalUrl, `http://${req.get('host')}`);
        const keyword = (url.searchParams.get('keyword') || url.searchParams.get('q') || '').trim();
        if (!keyword) {
            createResponse(res, 400, '缺少 keyword 参数');
            return;
        }
        if (keyword.length > 30) {
            createResponse(res, 400, 'keyword 长度不能超过30个字符');
            return;
        }

        const parsed = this.parseCommonListParams(url);
        if ('error' in parsed) {
            createResponse(res, 400, parsed.error);
            return;
        }

        const { page, pageSize, sortBy, sortOrder } = parsed;
        const offset = (page - 1) * pageSize;
        const orderBy = this.buildOrderBy(sortBy, sortOrder);
        const keywordPattern = `%${keyword}%`;

        const reportType = url.searchParams.get('reportType') || '';
        const reportTypeFilter = this.buildReportTypeFilter(reportType);
        const endYear = url.searchParams.get('endYear') || '';
        const endYearFilter = endYear ? ` AND l.end_date LIKE '${endYear}%'` : '';

        try {
            const countQuery = `${LATEST_REPORT_CTE}
                SELECT COUNT(*) AS total
                FROM latest l
                WHERE (l.symbol LIKE $1 OR l.stock_name LIKE $1)
                  AND 1=1${reportTypeFilter}${endYearFilter}`;
            const countResult = await pool.query(countQuery, [keywordPattern]);
            const total = Number(countResult.rows[0]?.total) || 0;
            const totalPages = Math.ceil(total / pageSize);

            const dataQuery = `${LATEST_REPORT_CTE}
                SELECT l.*
                FROM latest l
                WHERE (l.symbol LIKE $1 OR l.stock_name LIKE $1)
                  AND 1=1${reportTypeFilter}${endYearFilter}
                ORDER BY ${orderBy}
                LIMIT $2 OFFSET $3`;
            const dataResult = await pool.query(dataQuery, [keywordPattern, pageSize, offset]);

            const list = dataResult.rows.map(item => this.mapReportRow(item as ReportRow));
            // 重算并回写四维评分缓存，保证卡片分数与详情页一致
            await this.refreshAiScores(dataResult.rows as ReportRow[], list);
            createResponse(res, 200, 'success', {
                '数据源': 'PostgreSQL (Tushare)',
                '关键词': keyword,
                '排序字段': sortBy,
                '排序方向': sortOrder,
                '当前页': page,
                '每页数量': pageSize,
                '总数量': total,
                '总页数': totalPages,
                '报告列表': list,
            });
        } catch (error: any) {
            createResponse(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
        }
    }

    /**
     * POST /api/cn/stocks/performance-reports/refresh
     * 手动触发业绩报告更新
     */
    static async manualRefresh(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        if (PerformanceReportAutoUpdateService.isRunning()) {
            createResponse(res, 409, '更新任务正在进行中，请稍后再试');
            return;
        }

        // 后台执行，不阻塞响应
        createResponse(res, 200, '业绩报告更新已触发，将在后台执行');

        PerformanceReportAutoUpdateService.run()
            .then(result => {
                console.log(`[PerformanceReport] 手动更新完成: updated=${result.updated}, skipped=${result.skipped}, errors=${result.errors}`);
            })
            .catch(err => {
                console.error('[PerformanceReport] 手动更新失败:', err?.message || err);
            });
    }

    /**
     * GET /api/cn/stocks/performance-reports/analysis
     * AI 智能研判分析：生成亮点/风险词条 + 综合研判短文 + 多期财务数据
     */
    static async getAnalysis(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const url = new URL(req.originalUrl, `http://${req.get('host')}`);
        const symbol = (url.searchParams.get('symbol') || '').trim();
        if (!symbol || !/^\d{6}$/.test(symbol)) {
            createResponse(res, 400, '缺少或无效的 symbol 参数（需6位数字股票代码）');
            return;
        }
        const endDate = (url.searchParams.get('endDate') || '').trim() || undefined;

        try {
            const result = await AiAnalysisService.analyze(symbol, endDate);
            if (!result) {
                createResponse(res, 404, '未找到该股票的业绩报告数据');
                return;
            }
            createResponse(res, 200, 'success', {
                '股票代码': result.symbol,
                '股票名称': result.stockName,
                '报告期': result.periodLabel,
                '最新报告类型': result.reportType,
                'AI研判': result.aiTag,
                '经营亮点': result.goodTags,
                '潜在风险': result.riskTags,
                '综合研判': result.analysisText,
                '财务数据': {
                    periods: result.periods.map(p => ({
                        key: p.key,
                        label: p.label,
                        revenue: p.revenue,
                        revenueYoy: p.revenueYoy,
                        netProfit: p.netProfit,
                        netProfitYoy: p.netProfitYoy,
                        deductProfit: p.deductProfit,
                        grossMargin: p.grossMargin,
                        netMargin: p.netMargin,
                        roe: p.roe,
                        cashFlow: p.cashFlow,
                        debtRatio: p.debtRatio,
                    })),
                },
            });
        } catch (error: any) {
            createResponse(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
        }
    }

    /**
     * GET /api/cn/stocks/performance-reports/ai-analysis
     * AI 四维评分：获取盈利能力、成长性、财务健康、现金流四维评分
     */
    static async getAiScore(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const url = new URL(req.originalUrl, `http://${req.get('host')}`);
        const symbol = (url.searchParams.get('symbol') || '').trim();
        if (!symbol || !/^\d{6}$/.test(symbol)) {
            createResponse(res, 400, '缺少或无效的 symbol 参数（需6位数字股票代码）');
            return;
        }

        try {
            const result = await AiScoreService.analyze(symbol);
            createResponse(res, 200, 'success', result);
        } catch (error: any) {
            createResponse(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
        }
    }

    /**
     * GET /api/cn/stocks/performance-reports/ranking
     * 业绩排行榜：按多因子评分（净利增速/营收增速/盈利质量/加速度/可靠性）对最新一期报告排序
     */
    static async getPerformanceRanking(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const url = new URL(req.originalUrl, `http://${req.get('host')}`);
        const reportPeriod = (url.searchParams.get('reportPeriod') || '').trim() || currentReportPeriod();
        const sortByRaw = (url.searchParams.get('sortBy') || 'score').trim();
        const sortOrderRaw = (url.searchParams.get('sortOrder') || 'desc').trim().toLowerCase();
        const reportTypeRaw = (url.searchParams.get('reportType') || 'all').trim();
        const pageParam = url.searchParams.get('page') || '1';
        const pageSizeParam = url.searchParams.get('pageSize') || '50';
        const keyword = (url.searchParams.get('keyword') || '').trim();

        const allowedSortBy = new Set(['score', 'profit_growth', 'revenue_growth', 'profitability', 'roe', 'acceleration']);
        if (!allowedSortBy.has(sortByRaw)) {
            createResponse(res, 400, 'Invalid sortBy - 仅支持 score / profit_growth / revenue_growth / profitability / roe / acceleration');
            return;
        }
        if (sortOrderRaw !== 'asc' && sortOrderRaw !== 'desc') {
            createResponse(res, 400, 'Invalid sortOrder - 仅支持 asc 或 desc');
            return;
        }

        let page = 1;
        if (pageParam) {
            const parsed = Number(pageParam);
            if (!Number.isInteger(parsed) || parsed < 1) { createResponse(res, 400, 'Invalid page - page 必须是大于0的整数'); return; }
            page = parsed;
        }
        let pageSize = 50;
        if (pageSizeParam) {
            const parsed = Number(pageSizeParam);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) { createResponse(res, 400, 'Invalid pageSize - pageSize 必须是 1-500 的整数'); return; }
            pageSize = parsed;
        }

        if (!['all', 'formal', 'express'].includes(reportTypeRaw)) {
            createResponse(res, 400, 'Invalid reportType - 仅支持 all / formal / express');
            return;
        }

        try {
            // 取该报告期内每只股票的最新报告 + 去年同期报告（用于同比）+ 上一期报告（用于加速度）
            const query = `
                WITH latest AS (
                    SELECT p.symbol, p.stock_name, p.report_type, p.ann_date, p.end_date,
                           p.total_revenue, p.n_income_attr_p, p.created_at, p.ai_tag,
                           i.grossprofit_margin, i.netprofit_margin, i.roe,
                           ROW_NUMBER() OVER (
                               PARTITION BY p.symbol
                               ORDER BY p.report_type = 'formal' DESC, p.ann_date DESC
                           ) AS rn
                    FROM performance_reports p
                    LEFT JOIN LATERAL (
                        SELECT grossprofit_margin, netprofit_margin, roe
                        FROM performance_reports
                        WHERE symbol = p.symbol AND end_date = p.end_date AND report_type = 'indicator'
                        LIMIT 1
                    ) i ON true
                    WHERE p.end_date = $1
                      AND p.report_type IN ('formal', 'express')
                )
                SELECT l.*,
                       prev_same.total_revenue AS prev_revenue, prev_same.n_income_attr_p AS prev_profit,
                       prev_period.n_income_attr_p AS prev_period_profit,
                       prev_period_same.n_income_attr_p AS prev_period_same_profit
                FROM latest l
                LEFT JOIN LATERAL (
                    SELECT total_revenue, n_income_attr_p
                    FROM performance_reports
                    WHERE symbol = l.symbol
                      AND report_type IN ('formal', 'express')
                      AND end_date IS NOT NULL AND end_date != ''
                      AND end_date = (substr(l.end_date, 1, 4)::int - 1)::text || substr(l.end_date, 5)
                    ORDER BY report_type = 'formal' DESC
                    LIMIT 1
                ) prev_same ON true
                LEFT JOIN LATERAL (
                    SELECT total_revenue, n_income_attr_p, end_date
                    FROM performance_reports
                    WHERE symbol = l.symbol
                      AND report_type IN ('formal', 'express')
                      AND end_date IS NOT NULL AND end_date != ''
                      AND end_date < l.end_date
                    ORDER BY end_date DESC, report_type DESC
                    LIMIT 1
                ) prev_period ON true
                LEFT JOIN LATERAL (
                    SELECT n_income_attr_p
                    FROM performance_reports
                    WHERE symbol = l.symbol
                      AND report_type IN ('formal', 'express')
                      AND end_date IS NOT NULL AND end_date != ''
                      AND end_date = (substr(prev_period.end_date, 1, 4)::int - 1)::text || substr(prev_period.end_date, 5)
                    ORDER BY report_type = 'formal' DESC
                    LIMIT 1
                ) prev_period_same ON true
                WHERE l.rn = 1
                  AND ($2 = 'all' OR l.report_type = $2)
                  AND ($3 = '' OR l.symbol LIKE $3 OR l.stock_name LIKE $3)`;

            const result = await pool.query(query, [reportPeriod, reportTypeRaw, keyword ? `%${keyword}%` : '']);
            const rows = result.rows as any[];

            // 计算每只股票的评分
            const scored = rows.map((row) => {
                // 去年同期数据（同比基准）
                const prevProfit = row.prev_profit != null ? Number(row.prev_profit) : null;
                const curProfit = row.n_income_attr_p != null ? Number(row.n_income_attr_p) : null;
                const prevRevenue = row.prev_revenue != null ? Number(row.prev_revenue) : null;
                const curRevenue = row.total_revenue != null ? Number(row.total_revenue) : null;
                // 上一期及其去年同期（用于加速度）
                const prevPeriodProfit = row.prev_period_profit != null ? Number(row.prev_period_profit) : null;
                const prevPeriodSameProfit = row.prev_period_same_profit != null ? Number(row.prev_period_same_profit) : null;

                // 营收/净利均为空 → 数据不足，不参与评分
                const bothMissing = (curRevenue === null || curRevenue === 0) && (curProfit === null || curProfit === 0);
                if (bothMissing) return null;

                // 同比失真判断：
                // 1. 上期净利基数极小（<1000万元）且当期有明显净利
                // 2. 上期净利 <1亿元 但当期同比极端（|yoy|>1000%），如快报净利为全年预测值导致失真
                const yoyRaw = calcYoy(curProfit, prevProfit);
                const prevTiny = prevProfit !== null && Math.abs(prevProfit) < 1e7 && curProfit !== null && Math.abs(curProfit) > 1e6;
                const extremeYoy = yoyRaw.value !== null && prevProfit !== null && Math.abs(prevProfit) < 1e8 && Math.abs(yoyRaw.value) > 1000;
                const profitYoy = (prevTiny || extremeYoy)
                    ? { value: null, abnormal: true }
                    : yoyRaw;
                const revenueYoy = calcYoy(curRevenue, prevRevenue);
                // 上一期净利同比（本期同比的对照基准）
                const prevPeriodYoy = calcYoy(prevPeriodProfit, prevPeriodSameProfit);

                // 净利率：优先用 indicator 行，缺失时用利润/营收计算
                let netMargin = row.netprofit_margin != null ? Number(row.netprofit_margin) : null;
                if (netMargin === null && curRevenue !== null && curRevenue !== 0 && curProfit !== null) {
                    netMargin = (curProfit / curRevenue) * 100;
                }
                const roe = row.roe != null ? Number(row.roe) : null;

                const s1 = scoreNetProfitGrowth(profitYoy.value, {
                    prevProfit, curProfit, abnormal: profitYoy.abnormal,
                });
                const s2 = scoreRevenueGrowth(revenueYoy.value);
                const s3 = scoreProfitability(netMargin, roe);
                // 加速度：本期净利同比 - 上一期净利同比
                const accelDelta = (profitYoy.value != null && prevPeriodYoy.value != null)
                    ? profitYoy.value - prevPeriodYoy.value
                    : null;
                const s4 = scoreGrowthAcceleration(profitYoy.value, prevPeriodYoy.value);
                const s5 = scoreReportReliability(row.report_type);
                const totalScore = s1 + s2 + s3 + s4 + s5;

                return {
                    symbol: row.symbol,
                    stockName: row.stock_name || '',
                    reportType: row.report_type,
                    reportTypeLabel: row.report_type === 'formal' ? '正式报告' : '快报',
                    end_date: row.end_date || '',
                    ann_date: row.ann_date || '',
                    ai_tag: row.ai_tag || '',
                    revenue: curRevenue !== null && curRevenue !== undefined ? Math.round((curRevenue / 1e8) * 100) / 100 : null,
                    revenueYoY: revenueYoy.value != null ? Math.round(revenueYoy.value * 100) / 100 : null,
                    netProfit: curProfit !== null && curProfit !== undefined ? Math.round((curProfit / 1e8) * 100) / 100 : null,
                    netProfitYoY: profitYoy.value != null ? Math.round(profitYoy.value * 100) / 100 : null,
                    netMargin: netMargin != null ? Math.round(netMargin * 100) / 100 : null,
                    roe: roe != null ? Math.round(roe * 100) / 100 : null,
                    growthAcceleration: accelDelta != null ? Math.round(accelDelta * 100) / 100 : null,
                    score: Math.round(totalScore * 10) / 10,
                    scoreDimensions: {
                        netProfitGrowth: Math.round(s1 * 10) / 10,
                        revenueGrowth: Math.round(s2 * 10) / 10,
                        profitability: Math.round(s3 * 10) / 10,
                        growthAcceleration: Math.round(s4 * 10) / 10,
                        reportReliability: Math.round(s5 * 10) / 10,
                    },
                    growthAbnormal: profitYoy.abnormal,
                    rank: 0,
                };
            }).filter((x): x is NonNullable<typeof x> => x !== null);

            // 排序
            const sortKeyMap: Record<string, (r: any) => number | null> = {
                score: (r) => r.score,
                profit_growth: (r) => r.netProfitYoY,
                revenue_growth: (r) => r.revenueYoY,
                profitability: (r) => r.netMargin,
                roe: (r) => r.roe,
                acceleration: (r) => r.growthAcceleration,
            };
            const keyFn = sortKeyMap[sortByRaw] || sortKeyMap.score;
            // sortDir：升序返回 a-b（小在前），降序返回 b-a（大在前）；null 值始终排最后
            const sortDir = sortOrderRaw === 'asc' ? 1 : -1;
            scored.sort((a, b) => {
                const va = keyFn(a);
                const vb = keyFn(b);
                if (va === null && vb === null) return 0;
                if (va === null) return 1;
                if (vb === null) return -1;
                if (va !== vb) return sortDir * (va - vb);
                // 次级排序：净利同比 > 营收同比 > 报告可靠性 > 股票代码（方向与主排序一致）
                const pa = a.netProfitYoY ?? -Infinity;
                const pb = b.netProfitYoY ?? -Infinity;
                if (pa !== pb) return sortDir * (pa - pb);
                const ra = a.revenueYoY ?? -Infinity;
                const rb = b.revenueYoY ?? -Infinity;
                if (ra !== rb) return sortDir * (ra - rb);
                const relA = scoreReportReliability(a.reportType);
                const relB = scoreReportReliability(b.reportType);
                if (relA !== relB) return sortDir * (relA - relB);
                return a.symbol.localeCompare(b.symbol);
            });

            // 排名 + 分页
            scored.forEach((item, index) => { item.rank = index + 1; });
            const total = scored.length;
            const start = (page - 1) * pageSize;
            const list = scored.slice(start, start + pageSize);

            createResponse(res, 200, 'success', {
                '报告期': reportPeriod,
                '报告期标签': formatReportPeriod(reportPeriod),
                '排序方式': sortByRaw,
                '总数量': total,
                '当前页': page,
                '每页数量': pageSize,
                '排行榜': list,
            });
        } catch (error: any) {
            createResponse(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
        }
    }
}
