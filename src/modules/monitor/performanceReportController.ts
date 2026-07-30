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
}

type ReportSortBy = 'symbol' | 'ann_date' | 'total_revenue' | 'n_income_attr_p' | 'forecast_eps' | 'ai_score';
type ReportSortOrder = 'asc' | 'desc';

interface CommonListParams {
    page: number;
    pageSize: number;
    sortBy: ReportSortBy;
    sortOrder: ReportSortOrder;
}

const LATEST_REPORT_CTE = `
    WITH latest AS (
        SELECT p.symbol, p.stock_name, p.report_type, p.ann_date, p.end_date,
               p.forecast_eps, p.rating, p.org_name, p.summary,
               p.total_revenue, p.n_income, p.n_income_attr_p, p.basic_eps, p.created_at, p.ai_tag,
               s.total_score AS ai_score
        FROM performance_reports p
        LEFT JOIN stock_ai_scores s ON p.symbol = s.symbol
        INNER JOIN (
            SELECT symbol, report_type, MAX(ann_date) AS latest_ann_date
            FROM performance_reports
            GROUP BY symbol, report_type
        ) m ON p.symbol = m.symbol AND p.report_type = m.report_type AND p.ann_date = m.latest_ann_date
    )
`;

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
            '更新时间': row.created_at,
        };
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
        const reportTypeFilter = reportType
            ? ` AND l.report_type = '${reportType}'`
            : ` AND l.report_type IN ('formal', 'express')`;
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
        const reportTypeFilter = reportType
            ? ` AND l.report_type = '${reportType}'`
            : ` AND l.report_type IN ('formal', 'express')`;
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
}
