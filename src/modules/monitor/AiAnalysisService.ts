/**
 * AI 智能研判服务
 *
 * 根据财务指标自动生成经营亮点/潜在风险词条和综合研判短文。
 *
 * 数据来源：
 *   - performance_reports 表（营收、净利等基础指标）
 *   - fina_indicator 接口（毛利率、ROE、净利率、资产负债率等）
 *   - cashflow 接口（经营现金流）
 *
 * 输出：
 *   经营亮点词条（绿色标签）
 *   潜在风险词条（红色标签）
 *   综合研判短文（三段式：规模→盈利→结论）
 */

import pool from '../../core/db';
import { getFinaIndicator, getCashflow } from '../quote/TushareService';

// ================================================================
//  类型定义
// ================================================================

/** 通用金融指标记录（tushare 返回 / DB 查询的统一行类型） */
interface FinancialMetric {
    ts_code?: string;
    end_date?: string;
    ann_date?: string;
    [key: string]: string | number | null | undefined;
}

/** 单期财务数据（供前端表格/图表使用） */
export interface PeriodFinanceData {
    key: string;
    label: string;
    revenue: number | null;
    revenueYoy: number | null;
    netProfit: number | null;
    netProfitYoy: number | null;
    deductProfit: number | null;
    grossMargin: number | null;
    netMargin: number | null;
    roe: number | null;
    cashFlow: number | null;
    debtRatio: number | null;
}

/** AI 分析结果 */
export interface AiAnalysisResult {
    symbol: string;
    stockName: string;
    endDate: string;
    reportType: string; // 'formal' | 'express'
    periodLabel: string;
    aiTag: string;
    goodTags: string[];
    riskTags: string[];
    analysisText: string;
    periods: PeriodFinanceData[];
}

// ================================================================
//  报告期 => 显示标签
// ================================================================

function endDateToLabel(endDate: string): string {
    const y = endDate.slice(0, 4);
    const m = endDate.slice(4, 6);
    if (m === '03') return `${y}一季报`;
    if (m === '06') return `${y}半年报`;
    if (m === '09') return `${y}三季报`;
    if (m === '12') return `${y}年报`;
    return `${y}年季报`;
}

function endDateToKey(endDate: string): string {
    const y = endDate.slice(0, 4);
    const m = endDate.slice(4, 6);
    if (m === '06') return `${y}h1`;
    if (m === '12') return `${y}fy`;
    return endDate;
}

// ================================================================
//  原始表行类型
// ================================================================

interface ReportRow {
    end_date: string;
    total_revenue: number | null;
    n_income_attr_p: number | null;
    stock_name: string;
    ai_tag: string | null;
    report_type: string;
    // LEFT JOIN 指标字段
    grossprofit_margin?: number | null;
    netprofit_margin?: number | null;
    roe?: number | null;
    debt_to_assets?: number | null;
    n_cashflow_act?: number | null;
}

// ================================================================
//  AI 分析服务
// ================================================================

export class AiAnalysisService {

    /**
     * 对指定股票执行 AI 研判
     * 数据来源优先级：formal（正式报告）> express（快报/预告）> rating（研报评级）
     */
    static async analyze(symbol: string, _endDate?: string): Promise<AiAnalysisResult | null> {
        // 1. 获取多期数据（formal → express → rating 逐级降级）
        const rows = await this.fetchReportRows(symbol);
        if (rows.length === 0) return null;

        const current = rows[0];

        // 2. 计算 YoY（前一期）
        const prev = rows.length > 1 ? rows[1] : null;
        const revenueYoy = prev ? this.calcYoy(current.total_revenue, prev.total_revenue) : null;
        const profitYoy = prev ? this.calcYoy(current.n_income_attr_p, prev.n_income_attr_p) : null;

        // 3. 获取 fina_indicator / cashflow — 优先从 DB（已由 AutoUpdateService 预存），在线 API 作 fallback
        // 当前行可能已有 LEFT JOIN 进来的指标数据
        let indicator: FinancialMetric | null = null;
        let cashflow: FinancialMetric | null = null;
        if (current.grossprofit_margin != null || current.roe != null) {
            // DB 已有数据
            indicator = {
                grossprofit_margin: current.grossprofit_margin,
                netprofit_margin: current.netprofit_margin,
                roe: current.roe,
                debt_to_assets: current.debt_to_assets,
            };
        } else {
            // fallback：调用在线 API
            const apiIndicators = await this.fetchFinaIndicators(symbol);
            indicator = apiIndicators[0] ?? null;
        }
        if (current.n_cashflow_act != null) {
            cashflow = { n_cashflow_act: current.n_cashflow_act };
        } else {
            const apiCashflows = await this.fetchCashflows(symbol);
            cashflow = apiCashflows[0] ?? null;
        }

        // 4. 计算标签
        const goodTags = this.generateGoodTags(current, revenueYoy, profitYoy, indicator, cashflow);
        const riskTags = this.generateRiskTags(current, revenueYoy, profitYoy, indicator, cashflow, current.ai_tag ?? '');

        // 5. 生成综合研判
        const analysisText = this.generateAnalysisText(
            current.stock_name || symbol,
            current.end_date,
            current.total_revenue,
            current.n_income_attr_p,
            revenueYoy,
            profitYoy,
            goodTags,
            riskTags,
            current.ai_tag ?? '',
        );

        // 6. 组装多期 PeriodFinanceData（单位统一为 亿元 / %）
        // Tushare fina_indicator 返回的毛利率/净利率/ROE/负债率已经是百分比值
        const periods: PeriodFinanceData[] = rows.map((r, i) => {
            const prevR = i < rows.length - 1 ? rows[i + 1] : null;
            const revenueYi = r.total_revenue != null ? Number(r.total_revenue) / 100000000 : null;
            const profitYi = r.n_income_attr_p != null ? Number(r.n_income_attr_p) / 100000000 : null;
            const prevRevYi = prevR?.total_revenue != null ? Number(prevR.total_revenue) / 100000000 : null;
            const prevProfitYi = prevR?.n_income_attr_p != null ? Number(prevR.n_income_attr_p) / 100000000 : null;
            return {
                key: endDateToKey(r.end_date),
                label: endDateToLabel(r.end_date),
                revenue: revenueYi,
                revenueYoy: prevR ? this.calcYoy(revenueYi, prevRevYi) : null,
                netProfit: profitYi,
                netProfitYoy: prevR ? this.calcYoy(profitYi, prevProfitYi) : null,
                deductProfit: null,
                grossMargin: r.grossprofit_margin != null ? Number(r.grossprofit_margin) : null,
                netMargin: r.netprofit_margin != null ? Number(r.netprofit_margin) : null,
                roe: r.roe != null ? Number(r.roe) : null,
                cashFlow: r.n_cashflow_act != null ? Number(r.n_cashflow_act) / 100000000 : null,
                debtRatio: r.debt_to_assets != null ? Number(r.debt_to_assets) : null,
            };
        });

        // 首次运行还没有 indicator/cashflow 数据时，用在线 API 补充第一期
        if (periods.length > 0 && (periods[0].grossMargin == null || periods[0].cashFlow == null)) {
            const apiIndicators = await this.fetchFinaIndicators(symbol);
            const apiCashflows = await this.fetchCashflows(symbol);
            const apiIndicator = apiIndicators[0] ?? null;
            const apiCashflow = apiCashflows[0] ?? null;
            if (apiIndicator && periods[0].grossMargin == null) {
                periods[0].grossMargin = apiIndicator.grossprofit_margin != null ? Number(apiIndicator.grossprofit_margin) : null;
                periods[0].netMargin = apiIndicator.netprofit_margin != null ? Number(apiIndicator.netprofit_margin) : null;
                periods[0].roe = apiIndicator.roe != null ? Number(apiIndicator.roe) : null;
                periods[0].debtRatio = apiIndicator.debt_to_assets != null ? Number(apiIndicator.debt_to_assets) : null;
            }
            if (apiCashflow && periods[0].cashFlow == null) {
                periods[0].cashFlow = apiCashflow.n_cashflow_act != null ? Number(apiCashflow.n_cashflow_act) / 100000000 : null;
            }
        }

        return {
            symbol,
            stockName: current.stock_name || '',
            endDate: current.end_date,
            reportType: current.report_type || 'formal',
            periodLabel: endDateToLabel(current.end_date),
            aiTag: current.ai_tag ?? '',
            goodTags,
            riskTags,
            analysisText,
            periods,
        };
    }

    // ================================================================
    //  数据获取
    // ================================================================

    /**
     * 获取指定股票的多期报告数据（合并 formal + express + indicator + cashflow，按 end_date 降序）
     * 同一报告期优先取 formal（更完整）
     * 指标数据（毛利率/ROE/现金流）已存入 performance_reports 表，通过 LEFT JOIN 关联
     */
    private static async fetchReportRows(symbol: string): Promise<ReportRow[]> {
        const result = await pool.query(
            `SELECT r.end_date, r.total_revenue, r.n_income_attr_p, r.stock_name, r.ai_tag, r.report_type,
                    i.grossprofit_margin, i.netprofit_margin, i.roe, i.debt_to_assets,
                    c.n_cashflow_act
             FROM performance_reports r
             LEFT JOIN LATERAL (
                 SELECT grossprofit_margin, netprofit_margin, roe, debt_to_assets
                 FROM performance_reports
                 WHERE symbol = r.symbol AND end_date = r.end_date AND report_type = 'indicator'
                 LIMIT 1
             ) i ON true
             LEFT JOIN LATERAL (
                 SELECT n_cashflow_act
                 FROM performance_reports
                 WHERE symbol = r.symbol AND end_date = r.end_date AND report_type = 'cashflow'
                 LIMIT 1
             ) c ON true
             WHERE r.symbol = $1
               AND r.end_date IS NOT NULL AND r.end_date != ''
               AND r.report_type IN ('formal', 'express')
             ORDER BY r.end_date DESC, r.report_type DESC`,
            [symbol],
        );
        // 去重：同一 end_date 只保留第一条（formal 优先）
        const seen = new Set<string>();
        const deduped: ReportRow[] = [];
        for (const row of result.rows) {
            if (!seen.has(row.end_date)) {
                seen.add(row.end_date);
                deduped.push(row);
            }
        }
        // 保留足够多的期数给 displayPeriods 筛选（近3年最多需要当年 + 3年年报，但中间可能夹季报/半年报）
        return deduped.slice(0, 12);
    }

    /** 查询 fina_indicator 数据（在线 API 作为 fallback） */
    private static async fetchFinaIndicators(symbol: string): Promise<FinancialMetric[]> {
        try {
            return await getFinaIndicator(symbol) as unknown as FinancialMetric[];
        } catch {
            return [];
        }
    }

    /** 查询 cashflow 数据（在线 API 作为 fallback） */
    private static async fetchCashflows(symbol: string): Promise<FinancialMetric[]> {
        try {
            return await getCashflow(symbol) as unknown as FinancialMetric[];
        } catch {
            return [];
        }
    }

    // ================================================================
    //  词条生成
    // ================================================================

    private static generateGoodTags(
        current: ReportRow,
        revYoy: number | null,
        profitYoy: number | null,
        indicator: FinancialMetric | null,
        cashflow: FinancialMetric | null,
    ): string[] {
        const tags: string[] = [];

        // 营收维度
        if (current.total_revenue != null) {
            if (revYoy != null) {
                if (revYoy >= 50) tags.push('营收高速增长');
                else if (revYoy >= 20) tags.push('营收快速增长');
                else if (revYoy > 0) tags.push('营收稳步增长');
            } else {
                // 无同比时按绝对值判断
                const rev = Number(current.total_revenue);
                if (rev > 100000000000) tags.push('营收规模庞大');   // >1000亿
                else if (rev > 10000000000) tags.push('营收规模较大'); // >100亿
            }
        }

        // 净利维度
        if (current.n_income_attr_p != null) {
            if (profitYoy != null) {
                if (profitYoy >= 50) tags.push('净利大幅提升');
                else if (profitYoy >= 20) tags.push('净利快速增长');
                else if (profitYoy > 0) tags.push('净利稳步增长');
            } else {
                const profit = Number(current.n_income_attr_p);
                if (profit > 10000000000) tags.push('盈利规模庞大');   // >100亿
                else if (profit > 1000000000) tags.push('盈利规模较大'); // >10亿
                else if (profit > 0) tags.push('持续盈利');
            }
        }

        // 毛利率（Tushare 返回已是百分比）
        const grossMargin = indicator?.grossprofit_margin != null ? Number(indicator.grossprofit_margin) : null;
        if (grossMargin != null) {
            if (grossMargin >= 30) tags.push('毛利率优秀');
            else if (grossMargin >= 15) tags.push('毛利率稳定');
        }

        // ROE（Tushare 返回已是百分比）
        const roe = indicator?.roe != null ? Number(indicator.roe) : null;
        if (roe != null && roe >= 15) tags.push('资本回报率高');

        // 经营现金流
        const nCashflow = cashflow?.n_cashflow_act ?? null;
        if (nCashflow != null && Number(nCashflow) > 0) tags.push('现金流充裕');

        if (tags.length === 0 && current.n_income_attr_p != null && Number(current.n_income_attr_p) > 0) {
            tags.push('持续盈利');
        }

        return tags.slice(0, 5);
    }

    private static generateRiskTags(
        current: ReportRow,
        revYoy: number | null,
        profitYoy: number | null,
        indicator: FinancialMetric | null,
        cashflow: FinancialMetric | null,
        aiTag: string,
    ): string[] {
        const tags: string[] = [];

        if (aiTag === '转亏') tags.push('利润转亏');

        // 营收相关
        if (revYoy != null) {
            if (revYoy < -30) tags.push('营收大幅萎缩');
            else if (revYoy < 0) tags.push('营收萎缩');
        }

        // 净利相关
        if (profitYoy != null) {
            if (profitYoy < -40) tags.push('净利大幅下滑');
            else if (profitYoy < 0) tags.push('净利下滑');
        } else if (current.n_income_attr_p != null && Number(current.n_income_attr_p) < 0) {
            tags.push('当期亏损');
        }

        // 增收不增利
        if (revYoy != null && revYoy >= 0 && profitYoy != null && profitYoy < 0) {
            if (!tags.includes('成本承压')) tags.push('成本承压');
        }

        // 毛利率偏低（Tushare 返回已是百分比）
        const grossMargin = indicator?.grossprofit_margin != null ? Number(indicator.grossprofit_margin) : null;
        if (grossMargin != null && grossMargin < 10) tags.push('毛利率偏低');

        // 现金流为负
        const nCashflow = cashflow?.n_cashflow_act ?? null;
        if (nCashflow != null && Number(nCashflow) < 0) tags.push('现金流紧张');

        // 负债率高（Tushare 返回已是百分比）
        const debtRatio = indicator?.debt_to_assets != null ? Number(indicator.debt_to_assets) : null;
        if (debtRatio != null && debtRatio > 70) tags.push('负债率偏高');

        // 承压标签
        if (aiTag === '承压' && !tags.includes('成本承压')) {
            tags.push('成本承压');
        }

        return tags.slice(0, 4);
    }

    // ================================================================
    //  综合研判短文
    // ================================================================

    private static generateAnalysisText(
        stockName: string,
        endDate: string,
        revenue: number | null,
        profit: number | null,
        revYoy: number | null,
        profitYoy: number | null,
        goodTags: string[],
        riskTags: string[],
        aiTag: string,
    ): string {
        const label = endDateToLabel(endDate);

        // 格式化金额（亿元）
        const formatRev = (v: number | null): string =>
            v != null ? `${(Number(v) / 100000000).toFixed(2)}亿元` : '暂无数据';
        const formatProfit = (v: number | null): string =>
            v != null ? `${(Number(v) / 100000000).toFixed(2)}亿元` : '暂无数据';
        const formatYoy = (v: number | null): string =>
            v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '暂无数据';

        const revStr = formatRev(revenue);
        const profitStr = formatProfit(profit);
        const revYoyStr = formatYoy(revYoy);
        const profitYoyStr = formatYoy(profitYoy);

        // 规模层面
        const scalePart = `${stockName}${label}实现营收${revStr}，同比${revYoyStr}`;

        // 盈利层面
        const profitPart = `归母净利润${profitStr}，同比${profitYoyStr}`;

        // 综合结论
        let conclusion = `本期业绩判定为「${aiTag || '待定'}」。`;
        if (goodTags.length > 0) conclusion += `主要亮点：${goodTags.slice(0, 2).join('、')}。`;
        if (riskTags.length > 0) conclusion += `主要风险：${riskTags.slice(0, 2).join('、')}。`;

        return `${scalePart}；${profitPart}。${conclusion}`;
    }

    // ================================================================
    //  工具方法
    // ================================================================

    private static calcYoy(current: number | null, previous: number | null): number | null {
        if (current == null || previous == null || Number(previous) === 0) return null;
        return ((Number(current) - Number(previous)) / Math.abs(Number(previous))) * 100;
    }
}
