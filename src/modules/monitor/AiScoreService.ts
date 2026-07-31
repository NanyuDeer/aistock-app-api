/**
 * AI 四维评分服务
 *
 * 基于2023-2025三年年报数据，从四个维度对股票进行量化评分（100分制）：
 *   1. 盈利能力（30分）：ROE + 毛利率 + 净利率 + 稳定性
 *   2. 成长性（25分）：营收CAGR + 净利CAGR + 增速一致性
 *   3. 财务健康（20分）：资产负债率 + 异常排查
 *   4. 现金流（25分）：经营现金流/净利润 + 收现比 + 现金流趋势
 */

import pool from '../../core/db';
import http from 'http';
import { AiTagService } from './AiTagService';

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

export interface DimensionScore {
    name: string;
    score: number;
    maxScore: number;
    scoreRate: number;
    color: string;
    keyMetrics: Record<string, string>;
    highlight: string | null;
    riskPoint: string | null;
}

export interface AvailableHighlight {
    type: string;
    label: string;
    detail: string;
    icon: string;
    color: string;
}

export interface AiScoreResult {
    symbol: string;
    stockName: string;
    score: number | null;
    rating: string | null;
    ratingLevel: number | null;
    ratingColor: string | null;
    conclusion: string | null;
    conclusionSub: string | null;
    advice: string | null;
    dataPeriod: string;
    reportCount: number;
    dataStatus: 'complete' | 'partial' | 'insufficient' | 'empty';
    message: string | null;
    dimensions: DimensionScore[];
    strengths: string[];
    risks: string[];

    // partial 状态专属字段
    originalTag?: string;
    originalTagColor?: string;
    missingFields?: string[];
    missingFieldLabels?: string[];
    availableHighlights?: AvailableHighlight[];
    latestReportType?: string;
    prompt?: string;
}

// ================================================================
//  Tushare 工具函数（避免依赖 TushareService 的 token 获取方式）
// ================================================================

function toTsCode(symbol: string): string {
    const padded = symbol.padStart(6, '0');
    const suffix = ['6', '9'].includes(padded[0]) ? '.SH' : '.SZ';
    return padded + suffix;
}

function tushareRequest(apiName: string, params: Record<string, string | number | null>, fields: string): Promise<FinancialMetric[]> {
    return new Promise((resolve, reject) => {
        const token = process.env.TUSHARE_TOKEN || '';
        if (!token) { reject(new Error('TUSHARE_TOKEN not set')); return; }

        const data = JSON.stringify({
            api_name: apiName,
            token,
            params,
            fields,
        });

        const req = http.request({
            hostname: 'api.tushare.pro',
            path: '/',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            let body = '';
            res.on('data', (chunk: string) => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (json.code !== 0) {
                        reject(new Error(`Tushare error: ${json.msg || json.code}`));
                        return;
                    }
                    const items: FinancialMetric[] = (json.data?.items || []).map((item: (string | number | null)[]) => {
                        const obj: FinancialMetric = {};
                        (json.data.fields || []).forEach((f: string, i: number) => { obj[f] = item[i]; });
                        return obj;
                    });
                    resolve(items);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function fetchFinaIndicators(symbol: string, startDate: string): Promise<FinancialMetric[]> {
    try {
        return await tushareRequest('fina_indicator', { ts_code: toTsCode(symbol), start_date: startDate },
            'ts_code,ann_date,end_date,roe,grossprofit_margin,netprofit_margin,debt_to_assets,accounts_receiv,inventories,goodwill,debt_to_assets,cip,fix_assets,ocfps'
        );
    } catch { return []; }
}

async function fetchBalanceSheet(symbol: string, startDate: string): Promise<FinancialMetric[]> {
    try {
        return await tushareRequest('balancesheet', { ts_code: toTsCode(symbol), start_date: startDate },
            'ts_code,ann_date,end_date,total_assets,total_liab,total_hldr_eqy_exc_min_int,goodwill,accounts_receiv,inventory,cip,fixed_assets'
        );
    } catch { return []; }
}

async function fetchCashflow(symbol: string, startDate: string): Promise<FinancialMetric[]> {
    try {
        return await tushareRequest('cashflow', { ts_code: toTsCode(symbol), start_date: startDate },
            'ts_code,ann_date,end_date,n_cashflow_act,cash_rec_share_s,n_income_attr_p'
        );
    } catch { return []; }
}

// ================================================================
//  评分服务
// ================================================================

export class AiScoreService {

    /** 主入口 */
    static async analyze(symbol: string): Promise<AiScoreResult> {
        // 1. 获取基本数据
        const stockName = await this.getStockName(symbol);

        // 2. 获取年报数据
        const annualRows = await this.fetchAnnualReports(symbol);
        const annualData = annualRows.map(r => ({
            endDate: r.end_date || '',
            year: (r.end_date || '').slice(0, 4),
            revenue: r.total_revenue != null ? Number(r.total_revenue) : null,
            netProfit: r.n_income_attr_p != null ? Number(r.n_income_attr_p) : null,
        }));

        // 3. 获取财务指标和现金流（优先 DB，fallback Tushare）
        const indicators = await this.fetchFinaIndicatorsFromDB(symbol);
        const cashflows = await this.fetchCashflowsFromDB(symbol);
        const balSheet = await this.fetchBalanceSheetData(symbol);

        // 4. 获取2026最新报告用于趋势验证
        const latest2026 = await this.fetchLatestReport2026(symbol);

        // 5. 判断数据是否足够
        const annual2023 = annualData.find(d => d.year === '2023');
        const annual2024 = annualData.find(d => d.year === '2024');
        const availableYears = annualData.filter(d => d.year >= '2023' && d.year <= '2025').length;

        if (availableYears < 2) {
            return this.buildInsufficientResult(symbol, stockName, availableYears);
        }

        // 定义年份列表（用于 partial 检测和后续评分）
        const yrList = ['2023', '2024', '2025'];

        // 6. 检查是否为 partial（数据不完整）状态
        const partialCheck = this.checkPartial(annualData, indicators, cashflows);
        if (partialCheck.isPartial) {
            return await this.buildPartialResult(
                symbol, stockName, annualData, indicators, cashflows,
                availableYears, partialCheck.missingFields, partialCheck.missingFieldLabels,
                latest2026, yrList
            );
        }

        // 7. 提取3年数据
        const revList = yrList.map(y => annualData.find(d => d.year === y)?.revenue ?? null).filter(x => x != null) as number[];
        const profitList = yrList.map(y => annualData.find(d => d.year === y)?.netProfit ?? null).filter(x => x != null) as number[];

        // 指标数据
        const roeList = yrList.map(y => this.getIndicator(indicators, y, 'roe'));
        const gmList = yrList.map(y => this.getIndicator(indicators, y, 'grossprofit_margin'));
        const nmList = yrList.map(y => this.getIndicator(indicators, y, 'netprofit_margin'));
        const drList = yrList.map(y => this.getIndicator(indicators, y, 'debt_to_assets'));

        const cfList = yrList.map(y => this.getCashflowValue(cashflows, y, 'n_cashflow_act'));
        const profitForRatio = yrList.map(y => annualData.find(d => d.year === y)?.netProfit ?? null) as (number | null)[];

        // 现金流收现比用 cash_rec_share_s / total_revenue
        const cashRecList = yrList.map(y => this.getCashflowValue(cashflows, y, 'cash_rec_share_s'));
        const revForRatio = yrList.map(y => annualData.find(d => d.year === y)?.revenue ?? null) as (number | null)[];

        // 资产负债表数据
        const goodwillList = yrList.map(y => this.getBalValue(balSheet, y, 'goodwill'));
        const totalEquityList = yrList.map(y => this.getBalValue(balSheet, y, 'total_hldr_eqy_exc_min_int'));
        const arList = yrList.map(y => this.getBalValue(balSheet, y, 'accounts_receiv') ?? annualData.find(d => d.year === y)?.revenue ?? null);
        const invList = yrList.map(y => this.getBalValue(balSheet, y, 'inventory'));
        const cipList = yrList.map(y => this.getBalValue(balSheet, y, 'cip'));
        const fixAssetList = yrList.map(y => this.getBalValue(balSheet, y, 'fixed_assets'));

        // 7. 计算各维度
        const profitDim = this.scoreProfitability(roeList, gmList, nmList);
        const growthDim = this.scoreGrowth(revList, profitList, yrList, latest2026);
        const healthDim = this.scoreFinancialHealth(drList, arList, invList, revList, goodwillList, totalEquityList, cipList, fixAssetList);
        const cashDim = this.scoreCashflowDimension(cfList, profitForRatio, cashRecList, revForRatio);

        const dimensions = [profitDim, growthDim, healthDim, cashDim];
        const totalScore = dimensions.reduce((s, d) => s + d.score, 0);

        // 8. 生成评级
        const rating = this.generateRating(totalScore);
        const conclusion = this.generateConclusion(totalScore, dimensions);
        const sr = this.generateStrengthsAndRisks(dimensions);

        return {
            symbol,
            stockName,
            score: totalScore,
            rating: rating.rating,
            ratingLevel: rating.level,
            ratingColor: rating.color,
            conclusion: conclusion.conclusion,
            conclusionSub: conclusion.conclusionSub,
            advice: conclusion.advice,
            dataPeriod: '基于2023-2025三年年报数据',
            reportCount: availableYears,
            dataStatus: 'complete',
            message: null,
            dimensions,
            strengths: sr.strengths,
            risks: sr.risks,
        };
    }

    // ================================================================
    //  数据获取
    // ================================================================

    /** 获取股票名称 */
    private static async getStockName(symbol: string): Promise<string> {
        try {
            const r = await pool.query('SELECT name FROM stocks WHERE symbol = $1 LIMIT 1', [symbol]);
            return r.rows[0]?.name || '';
        } catch { return ''; }
    }

    /** 获取正式年报 (2023-2025) */
    private static async fetchAnnualReports(symbol: string): Promise<FinancialMetric[]> {
        const r = await pool.query(
            `SELECT end_date, total_revenue, n_income_attr_p
             FROM performance_reports
             WHERE symbol = $1 AND report_type = 'formal'
               AND end_date IN ('20231231', '20241231', '20251231')
             ORDER BY end_date ASC`,
            [symbol]
        );
        return r.rows;
    }

    /** 从 DB 获取财务指标数据 */
    private static async fetchFinaIndicatorsFromDB(symbol: string): Promise<FinancialMetric[]> {
        const r = await pool.query(
            `SELECT end_date, roe, grossprofit_margin, netprofit_margin, debt_to_assets
             FROM performance_reports
             WHERE symbol = $1 AND report_type = 'indicator'
               AND end_date IN ('20231231', '20241231', '20251231')
             ORDER BY end_date ASC`,
            [symbol]
        );
        if (r.rows.length >= 2) return r.rows;

        // fallback: 从 Tushare 获取
        const indicators = await fetchFinaIndicators(symbol, '20230101');
        // 保留年报数据
        return indicators.filter((i: FinancialMetric) => {
            const ed = (i.end_date || '').replace(/-/g, '');
            return ed === '20231231' || ed === '20241231' || ed === '20251231';
        }).sort((a: FinancialMetric, b: FinancialMetric) => (a.end_date || '').localeCompare(b.end_date || ''));
    }

    /** 从 DB 获取现金流数据 */
    private static async fetchCashflowsFromDB(symbol: string): Promise<FinancialMetric[]> {
        const r = await pool.query(
            `SELECT end_date, n_cashflow_act
             FROM performance_reports
             WHERE symbol = $1 AND report_type = 'cashflow'
               AND end_date IN ('20231231', '20241231', '20251231')
             ORDER BY end_date ASC`,
            [symbol]
        );
        if (r.rows.length >= 2) return r.rows;

        const cfs = await fetchCashflow(symbol, '20230101');
        return cfs.filter((c: FinancialMetric) => {
            const ed = (c.end_date || '').replace(/-/g, '');
            return ed === '20231231' || ed === '20241231' || ed === '20251231';
        }).sort((a: FinancialMetric, b: FinancialMetric) => (a.end_date || '').localeCompare(b.end_date || ''));
    }

    /** 从 Tushare 获取资产负债表数据（用于异常排查） */
    private static async fetchBalanceSheetData(symbol: string): Promise<FinancialMetric[]> {
        const bs = await fetchBalanceSheet(symbol, '20230101');
        return bs.filter((b: FinancialMetric) => {
            const ed = (b.end_date || '').replace(/-/g, '');
            return ed === '20231231' || ed === '20241231' || ed === '20251231';
        }).sort((a: FinancialMetric, b: FinancialMetric) => (a.end_date || '').localeCompare(b.end_date || ''));
    }

    /** 获取2026最新报告（用于趋势验证） */
    private static async fetchLatestReport2026(symbol: string): Promise<{ revenueYOY: number | null; profitYOY: number | null } | null> {
        try {
            // 找2026年最新报告：优先半年报，次季报
            const r = await pool.query(
                `SELECT end_date, total_revenue, n_income_attr_p
                 FROM performance_reports
                 WHERE symbol = $1 AND report_type = 'formal'
                   AND end_date LIKE '2026%'
                 ORDER BY end_date DESC
                 LIMIT 1`,
                [symbol]
            );
            if (r.rows.length === 0) return null;

            const cur = r.rows[0];
            // 找去年同期
            const endDate = cur.end_date;
            const prevYear = String(Number(endDate.slice(0, 4)) - 1);
            const prevEndDate = prevYear + endDate.slice(4);

            const prev = await pool.query(
                `SELECT total_revenue, n_income_attr_p
                 FROM performance_reports
                 WHERE symbol = $1 AND report_type = 'formal' AND end_date = $2
                 LIMIT 1`,
                [symbol, prevEndDate]
            );

            if (prev.rows.length === 0) return null;

            const revYoy = this.calcYoy(
                cur.total_revenue != null ? Number(cur.total_revenue) : null,
                prev.rows[0].total_revenue != null ? Number(prev.rows[0].total_revenue) : null
            );
            const profitYoy = this.calcYoy(
                cur.n_income_attr_p != null ? Number(cur.n_income_attr_p) : null,
                prev.rows[0].n_income_attr_p != null ? Number(prev.rows[0].n_income_attr_p) : null
            );
            return { revenueYOY: revYoy, profitYOY: profitYoy };
        } catch { return null; }
    }

    /** 从指标列表中获取某年份的值 */
    private static getIndicator(list: FinancialMetric[], year: string, field: string): number | null {
        const item = list.find((i: FinancialMetric) => {
            const ed = (i.end_date || '').replace(/-/g, '');
            return ed.startsWith(year);
        });
        if (!item) return null;
        const v = item[field];
        return v != null ? Number(v) : null;
    }

    /** 从现金流列表中获取某年份的值 */
    private static getCashflowValue(list: FinancialMetric[], year: string, field: string): number | null {
        const item = list.find((i: FinancialMetric) => {
            const ed = (i.end_date || '').replace(/-/g, '');
            return ed.startsWith(year);
        });
        if (!item) return null;
        const v = item[field];
        return v != null ? Number(v) : null;
    }

    /** 从资产负债表中获取某年份的值 */
    private static getBalValue(list: FinancialMetric[], year: string, field: string): number | null {
        const item = list.find((i: FinancialMetric) => {
            const ed = (i.end_date || '').replace(/-/g, '');
            return ed.startsWith(year);
        });
        if (!item) return null;
        const v = item[field];
        return v != null ? Number(v) : null;
    }

    // ================================================================
    //  盈利能力评分（30分）
    // ================================================================

    private static scoreProfitability(
        roeList: (number | null)[],
        gmList: (number | null)[],
        nmList: (number | null)[],
    ): DimensionScore {
        const validRoe = roeList.filter((x): x is number => x != null);
        const validGm = gmList.filter((x): x is number => x != null);
        const validNm = nmList.filter((x): x is number => x != null);

        const roeScore = this.scoreROE(validRoe);
        const gmScore = this.scoreGrossMargin(validGm);
        const nmScore = this.scoreNetMargin(validNm);
        const stabilityScore = this.scoreProfitStability(validRoe, validNm);

        const total = roeScore + gmScore + nmScore + stabilityScore;

        const keyMetrics: Record<string, string> = {};
        if (validRoe.length > 0) keyMetrics.roe = this.avg(validRoe).toFixed(1) + '%';
        if (validGm.length > 0) keyMetrics.grossMargin = this.avg(validGm).toFixed(1) + '%';
        if (validNm.length > 0) keyMetrics.netMargin = this.avg(validNm).toFixed(1) + '%';
        keyMetrics.stability = stabilityScore >= 3 ? '波动小' : stabilityScore >= 2 ? '波动中等' : '波动较大';

        const rate = total / 30;
        const color = rate >= 0.8 ? '#1D9E75' : rate >= 0.6 ? '#378ADD' : '#EF9F27';

        let highlight: string | null = null;
        if (roeScore >= 9) highlight = `ROE连续3年${validRoe.length > 0 ? '>=' + Math.min(...validRoe).toFixed(0) + '%' : ''}`;
        else if (gmScore >= 6) highlight = `毛利率稳定在${this.avg(validGm).toFixed(0)}%以上`;
        if (rate < 0.6) {
            highlight = null;
        }

        let riskPoint: string | null = null;
        if (rate < 0.6) {
            const weakest = roeScore < 3 ? 'ROE偏低' : gmScore < 4 ? '毛利率偏低' : '净利率偏低';
            riskPoint = `盈利能力偏弱（${weakest}）`;
        }

        return {
            name: '盈利能力',
            score: total,
            maxScore: 30,
            scoreRate: rate,
            color,
            keyMetrics,
            highlight,
            riskPoint,
        };
    }

    private static scoreROE(roeList: number[]): number {
        if (roeList.length === 0) return 0;
        const avg = this.avg(roeList);
        const min = Math.min(...roeList);

        if (avg >= 20 && min >= 15) return 12;
        if (avg >= 15 && min >= 10) return 9;
        if (avg >= 10 && min >= 5) return 6;
        if (avg >= 5) return 3;
        return 0;
    }

    private static scoreGrossMargin(gmList: number[]): number {
        if (gmList.length === 0) return 2;
        const avg = this.avg(gmList);
        const trend = gmList.length >= 2 ? gmList[gmList.length - 1] - gmList[0] : 0;

        if (avg >= 60) return trend >= 0 ? 8 : 6;
        if (avg >= 40) return trend >= 0 ? 6 : 4;
        if (avg >= 20) return 4;
        return 2;
    }

    private static scoreNetMargin(nmList: number[]): number {
        if (nmList.length === 0) return 0;
        const avg = this.avg(nmList);
        if (avg >= 25) return 6;
        if (avg >= 15) return 4;
        if (avg >= 8) return 3;
        if (avg >= 0) return 1;
        return 0;
    }

    private static scoreProfitStability(roeList: number[], nmList: number[]): number {
        if (roeList.length < 2) return 1;
        const roeStd = this.stdDev(roeList);
        const nmStd = nmList.length >= 2 ? this.stdDev(nmList) : 999;

        if (roeStd < 3 && nmStd < 5) return 4;
        if (roeStd < 5 && nmStd < 8) return 3;
        if (roeStd < 10) return 2;
        return 1;
    }

    // ================================================================
    //  成长性评分（25分）
    // ================================================================

    private static scoreGrowth(
        revList: number[],
        profitList: number[],
        yrList: string[],
        latest2026: { revenueYOY: number | null; profitYOY: number | null } | null,
    ): DimensionScore {
        const revCAGRScore = this.scoreRevenueCAGR(
            revList.length >= 1 ? revList[0] : null,
            revList.length >= 3 ? revList[2] : revList.length >= 2 ? revList[1] : null,
        );
        const profitCAGRScore = this.scoreProfitCAGR(
            profitList.length >= 1 ? profitList[0] : null,
            profitList.length >= 3 ? profitList[2] : profitList.length >= 2 ? profitList[1] : null,
        );
        const consistencyScore = this.scoreGrowthConsistency(revList, profitList, latest2026);

        const total = revCAGRScore + profitCAGRScore + consistencyScore;

        // CAGR 计算
        let revCAGR: string | null = null;
        let profitCAGR: string | null = null;
        if (revList.length >= 3 && revList[0] != null && revList[0] > 0 && revList[2] != null) {
            const cagr = (Math.pow(revList[2] / revList[0], 1 / 2) - 1) * 100;
            revCAGR = cagr.toFixed(1) + '%';
        }
        if (profitList.length >= 3 && profitList[0] != null && profitList[0] > 0 && profitList[2] != null) {
            const cagr = (Math.pow(profitList[2] / profitList[0], 1 / 2) - 1) * 100;
            profitCAGR = cagr.toFixed(1) + '%';
        }

        const keyMetrics: Record<string, string> = {};
        if (revCAGR) keyMetrics.revenueCAGR = revCAGR;
        if (profitCAGR) keyMetrics.profitCAGR = profitCAGR;
        keyMetrics.latestTrend = latest2026
            ? `26最新营收同比${latest2026.revenueYOY != null ? (latest2026.revenueYOY >= 0 ? '+' : '') + latest2026.revenueYOY.toFixed(1) + '%' : 'N/A'}`
            : '暂无2026数据';

        const rate = total / 25;
        const color = rate >= 0.8 ? '#1D9E75' : rate >= 0.6 ? '#378ADD' : '#EF9F27';

        let highlight: string | null = null;
        if (revCAGRScore >= 8 && profitCAGRScore >= 6) highlight = '营收净利双增，26年趋势延续';
        else if (revCAGRScore >= 5) highlight = '营收稳定增长';

        let riskPoint: string | null = null;
        if (rate < 0.6) {
            const weakPart = revCAGRScore <= 2 && profitCAGRScore <= 2 ? '营收净利增长乏力' : '增长动力不足';
            riskPoint = `成长性偏弱（${weakPart}）`;
        }

        return {
            name: '成长性',
            score: total,
            maxScore: 25,
            scoreRate: rate,
            color,
            keyMetrics,
            highlight,
            riskPoint,
        };
    }

    private static scoreRevenueCAGR(revenueStart: number | null, revenueEnd: number | null): number {
        if (!revenueStart || revenueStart <= 0 || !revenueEnd) return 0;
        const cagr = Math.pow(revenueEnd / revenueStart, 1 / 2) - 1;
        const pct = cagr * 100;
        if (pct >= 15) return 10;
        if (pct >= 10) return 8;
        if (pct >= 5) return 5;
        if (pct >= 0) return 2;
        return 0;
    }

    private static scoreProfitCAGR(profitStart: number | null, profitEnd: number | null): number {
        if (!profitStart || profitStart <= 0 || !profitEnd) return 0;
        const cagr = Math.pow(profitEnd / profitStart, 1 / 2) - 1;
        const pct = cagr * 100;
        if (pct >= 20) return 10;
        if (pct >= 15) return 8;
        if (pct >= 10) return 6;
        if (pct >= 5) return 4;
        if (pct >= 0) return 2;
        return 0;
    }

    private static scoreGrowthConsistency(
        revList: number[],
        profitList: number[],
        latest2026: { revenueYOY: number | null; profitYOY: number | null } | null,
    ): number {
        let score = 0;

        // 计算营收同比值
        const revYOYs: number[] = [];
        for (let i = 1; i < revList.length; i++) {
            const yoy = this.calcYoy(revList[i], revList[i - 1]);
            if (yoy != null) revYOYs.push(yoy);
        }
        const profitYOYs: number[] = [];
        for (let i = 1; i < profitList.length; i++) {
            const yoy = this.calcYoy(profitList[i], profitList[i - 1]);
            if (yoy != null) profitYOYs.push(yoy);
        }

        if (revYOYs.length > 0 && revYOYs.every(y => y > 0)) score += 1;
        if (profitYOYs.length > 0 && profitYOYs.every(y => y > 0)) score += 1;

        if (latest2026) {
            if (latest2026.revenueYOY != null && latest2026.revenueYOY > 0) score += 1;
            if (latest2026.profitYOY != null && latest2026.profitYOY > 0) score += 1;
        }

        if (revYOYs.length >= 2 && revYOYs[1] > revYOYs[0]) score += 1;

        return Math.min(score, 5);
    }

    // ================================================================
    //  财务健康评分（20分）
    // ================================================================

    private static scoreFinancialHealth(
        drList: (number | null)[],
        arList: (number | null)[],
        invList: (number | null)[],
        revList: number[],
        goodwillList: (number | null)[],
        equityList: (number | null)[],
        cipList: (number | null)[],
        fixAssetList: (number | null)[],
    ): DimensionScore {
        const validDr = drList.filter((x): x is number => x != null);

        const debtScore = this.scoreDebtRatio(validDr);
        const anomalyScore = this.scoreAnomalyCheck(
            arList, invList, revList,
            goodwillList, equityList,
            cipList, fixAssetList,
        );

        const total = debtScore + anomalyScore;

        const keyMetrics: Record<string, string> = {};
        if (validDr.length > 0) {
            keyMetrics.debtRatio = validDr[validDr.length - 1].toFixed(1) + '%';
            keyMetrics.debtTrend = validDr.length >= 2
                ? (validDr[validDr.length - 1] <= validDr[0] ? '持续下降' : '有所上升')
                : '—';
        }
        keyMetrics.anomalies = anomalyScore >= 10 ? '无异常' : '存在异常项';

        const rate = total / 20;
        const color = rate >= 0.8 ? '#1D9E75' : rate >= 0.6 ? '#378ADD' : '#EF9F27';

        let highlight: string | null = null;
        if (debtScore >= 6 && anomalyScore >= 10) highlight = '负债率合理，财务结构健康';
        else if (debtScore >= 6) highlight = '负债率控制在合理范围';

        let riskPoint: string | null = null;
        if (rate < 0.6) {
            if (debtScore <= 3) riskPoint = '负债率偏高';
            else if (anomalyScore < 8) riskPoint = '存在财务异常项';
            else riskPoint = '财务健康存疑';
        }

        return {
            name: '财务健康',
            score: total,
            maxScore: 20,
            scoreRate: rate,
            color,
            keyMetrics,
            highlight,
            riskPoint,
        };
    }

    private static scoreDebtRatio(drList: number[]): number {
        if (drList.length === 0) return 4;
        const latest = drList[drList.length - 1];
        const avg = this.avg(drList);
        const trend = drList.length >= 2 ? latest - drList[0] : 0;

        if (latest < 40) return trend <= 0 ? 8 : 6;
        if (latest < 60) return trend <= 0 ? 6 : 4;
        if (latest < 70) return 3;
        if (latest < 80) return 1;
        return 0;
    }

    private static scoreAnomalyCheck(
        arList: (number | null)[],
        invList: (number | null)[],
        revList: number[],
        goodwillList: (number | null)[],
        equityList: (number | null)[],
        cipList: (number | null)[],
        fixAssetList: (number | null)[],
    ): number {
        let score = 12;

        // 1. 应收账款增速 > 营收增速 * 1.2
        if (arList.length >= 2 && revList.length >= 2 && arList[0] != null && arList[arList.length - 1] != null && revList[0] > 0 && revList[revList.length - 1] > 0) {
            const arGrowth = (arList[arList.length - 1]! - arList[0]!) / Math.abs(arList[0]!);
            const revGrowth = revList.length >= 2 ? (revList[revList.length - 1] - revList[0]) / Math.abs(revList[0]) : 0;
            if (arGrowth > revGrowth * 1.2) score -= 4;
        }

        // 2. 存货增速 > 营收增速 * 1.2
        if (invList.length >= 2 && revList.length >= 2 && invList[0] != null && invList[invList.length - 1] != null && revList[0] > 0) {
            const invGrowth = (invList[invList.length - 1]! - invList[0]!) / Math.abs(invList[0]!);
            const revGrowth = revList.length >= 2 ? (revList[revList.length - 1] - revList[0]) / Math.abs(revList[0]) : 0;
            if (invGrowth > revGrowth * 1.2) score -= 3;
        }

        // 3. 商誉 / 净资产 > 30%
        if (goodwillList.length > 0 && equityList.length > 0) {
            const latestGw = goodwillList[goodwillList.length - 1];
            const latestEq = equityList[equityList.length - 1];
            if (latestGw != null && latestEq != null && latestEq > 0 && latestGw / latestEq > 0.3) {
                score -= 3;
            }
        }

        // 4. 在建工程长期不转固定资产
        if (cipList.length >= 3 && fixAssetList.length >= 3) {
            const cipIncreasing = cipList.every((v, i) => i === 0 || (v ?? 0) >= (cipList[i - 1] ?? 0));
            const cipToFixed = (fixAssetList[fixAssetList.length - 1] ?? 0) > (fixAssetList[0] ?? 0) * 1.1;
            if (cipIncreasing && !cipToFixed) score -= 2;
        }

        return Math.max(score, 0);
    }

    // ================================================================
    //  现金流评分（25分）
    // ================================================================

    private static scoreCashflowDimension(
        cfList: (number | null)[],
        profitList: (number | null)[],
        cashRecList: (number | null)[],
        revList: (number | null)[],
    ): DimensionScore {
        const validCf = cfList.filter((x): x is number => x != null);
        const validProfit = profitList.filter((x): x is number => x != null);

        const qualityScore = this.scoreCashFlowQuality(validCf, validProfit);
        const receiptScore = this.scoreCashReceiptRatio(cashRecList, revList);
        const trendScore = this.scoreCashFlowTrend(cfList);

        const total = qualityScore + receiptScore + trendScore;

        // key metrics
        let cfToProfit: string = '—';
        if (validCf.length > 0 && validProfit.length > 0) {
            const ratios = validCf.map((cf, i) => validProfit[i] > 0 ? cf / validProfit[i] : null).filter((x): x is number => x != null);
            if (ratios.length > 0) cfToProfit = this.avg(ratios).toFixed(2);
        }

        let cashReceiptRatio: string = '—';
        const validCashRec = cashRecList.filter((x): x is number => x != null);
        const validRev = revList.filter((x): x is number => x != null);
        if (validCashRec.length > 0 && validRev.length > 0) {
            const ratios = validCashRec.map((cr, i) => validRev[i] > 0 ? cr / validRev[i] : null).filter((x): x is number => x != null);
            if (ratios.length > 0) cashReceiptRatio = this.avg(ratios).toFixed(2);
        }

        const allPositive = validCf.every(cf => cf > 0);
        const positive = validCf.length > 0 && validCf[validCf.length - 1] > (validCf[0] ?? 0) ? '持续为正且增长' : allPositive ? '持续为正' : '有负值';

        const keyMetrics: Record<string, string> = {};
        keyMetrics.cfToProfit = cfToProfit;
        keyMetrics.cashReceiptRatio = cashReceiptRatio;
        keyMetrics.trend = positive;

        const rate = total / 25;
        const color = rate >= 0.8 ? '#1D9E75' : rate >= 0.6 ? '#378ADD' : '#EF9F27';

        let highlight: string | null = null;
        if (qualityScore >= 8) highlight = '经营现金流持续覆盖净利润';
        else if (allPositive) highlight = '经营现金流持续为正';

        let riskPoint: string | null = null;
        if (rate < 0.6) {
            if (qualityScore === 0) riskPoint = '经营现金流无法覆盖净利润';
            else riskPoint = '现金流质量偏低';
        }

        return {
            name: '现金流',
            score: total,
            maxScore: 25,
            scoreRate: rate,
            color,
            keyMetrics,
            highlight,
            riskPoint,
        };
    }

    private static scoreCashFlowQuality(cfList: number[], profitList: number[]): number {
        if (cfList.length === 0 || profitList.length === 0) return 0;
        const ratios = cfList.map((cf, i) => profitList[i] > 0 ? cf / profitList[i] : null).filter((x): x is number => x != null);
        if (ratios.length === 0) return 0;

        const avgRatio = this.avg(ratios);
        const allPositive = cfList.every(cf => cf > 0);

        if (avgRatio >= 1.0 && allPositive) return 10;
        if (avgRatio >= 0.8 && allPositive) return 8;
        if (avgRatio >= 0.5) return 5;
        if (allPositive) return 3;
        return 0;
    }

    private static scoreCashReceiptRatio(cashRecList: (number | null)[], revList: (number | null)[]): number {
        const ratios: number[] = [];
        for (let i = 0; i < cashRecList.length && i < revList.length; i++) {
            if (cashRecList[i] != null && revList[i] != null && revList[i]! > 0) {
                ratios.push(cashRecList[i]! / revList[i]!);
            }
        }
        if (ratios.length === 0) return 0;

        const avg = this.avg(ratios);
        if (avg >= 1.1) return 8;
        if (avg >= 1.0) return 6;
        if (avg >= 0.8) return 4;
        if (avg >= 0.5) return 2;
        return 0;
    }

    private static scoreCashFlowTrend(cfList: (number | null)[]): number {
        const valid = cfList.filter((x): x is number => x != null);
        if (valid.length < 2) return valid.length === 1 && valid[0] > 0 ? 3 : 0;

        const trend = valid[valid.length - 1] - valid[0];
        const allPositive = valid.every(cf => cf > 0);

        if (allPositive && trend > 0) return 7;
        if (allPositive && trend >= 0) return 5;
        if (allPositive) return 3;
        return 0;
    }

    // ================================================================
    //  评级生成
    // ================================================================

    private static generateRating(totalScore: number): { rating: string; level: number; color: string } {
        if (totalScore >= 85) return { rating: '优秀', level: 5, color: '#1D9E75' };
        if (totalScore >= 70) return { rating: '良好', level: 4, color: '#378ADD' };
        if (totalScore >= 55) return { rating: '一般', level: 3, color: '#EF9F27' };
        if (totalScore >= 40) return { rating: '偏弱', level: 2, color: '#E24B4A' };
        return { rating: '较差', level: 1, color: '#888780' };
    }

    // ================================================================
    //  结论生成
    // ================================================================

    private static generateConclusion(
        totalScore: number,
        dimensions: DimensionScore[],
    ): { conclusion: string; conclusionSub: string; advice: string } {
        const weakest = [...dimensions].sort((a, b) => a.scoreRate - b.scoreRate)[0];
        const riskPoint = weakest.riskPoint || `${weakest.name}维度需关注`;

        if (totalScore >= 85) {
            return {
                conclusion: '适合长线持有',
                conclusionSub: `四维均衡，${weakest.name}为相对短板但仍在合理范围`,
                advice: `四维评分均衡，适合作为长线核心配置标的。建议关注${weakest.name}变化趋势。`,
            };
        }
        if (totalScore >= 70) {
            return {
                conclusion: '可关注长线机会',
                conclusionSub: `整体良好，${weakest.name}需持续跟踪`,
                advice: `基本面整体不错，但${weakest.name}维度存在不确定性。建议分批建仓、持续跟踪。`,
            };
        }
        if (totalScore >= 55) {
            return {
                conclusion: '中性观望',
                conclusionSub: `${weakest.name}偏弱，需更多数据验证`,
                advice: `当前财务表现一般，${riskPoint}。不建议重仓，可观察后续财报改善情况。`,
            };
        }
        return {
            conclusion: '不适合长线持有',
            conclusionSub: `${weakest.name}存在明显风险`,
            advice: `财务指标存在明显风险点，不建议作为长线标的。${riskPoint}`,
        };
    }

    // ================================================================
    //  优势/风险生成
    // ================================================================

    private static generateStrengthsAndRisks(dimensions: DimensionScore[]): { strengths: string[]; risks: string[] } {
        const strengths: string[] = [];
        const risks: string[] = [];

        for (const dim of dimensions) {
            const rate = dim.score / dim.maxScore;
            if (rate >= 0.8 && dim.highlight) {
                strengths.push(`${dim.name}维度表现优秀，${dim.highlight}`);
            }
            if (rate < 0.6 && dim.riskPoint) {
                risks.push(dim.riskPoint);
            }
        }

        // 如果没有任何维度突出，用得分最高的维度
        if (strengths.length === 0) {
            const best = [...dimensions].sort((a, b) => b.scoreRate - a.scoreRate)[0];
            if (best && best.highlight) {
                strengths.push(`${best.name}：${best.highlight}`);
            }
        }

        return {
            strengths: strengths.slice(0, 4),
            risks: risks.slice(0, 3),
        };
    }

    // ================================================================
    //  数据不足结果
    // ================================================================

    private static buildInsufficientResult(symbol: string, stockName: string, count: number): AiScoreResult {
        return {
            symbol,
            stockName,
            score: null,
            rating: null,
            ratingLevel: null,
            ratingColor: null,
            conclusion: null,
            conclusionSub: null,
            advice: null,
            dataPeriod: `基于近${count}期年报数据`,
            reportCount: count,
            dataStatus: 'insufficient',
            message: `年报数据不足2期（当前${count}期），暂无法进行AI研判`,
            dimensions: [],
            strengths: [],
            risks: [],
        };
    }

    // ================================================================
    //  partial（数据不完整）状态
    // ================================================================

    /**
     * 检查核心字段是否缺失（用于判定 partial 状态）
     * 条件：最新年报的 revenue/netProfit 为 NULL/0，或 3年中有≥1期指标缺失
     */
    private static checkPartial(
        annualData: { year: string; revenue: number | null; netProfit: number | null }[],
        indicators: FinancialMetric[],
        cashflows: FinancialMetric[],
    ): { isPartial: boolean; missingFields: string[]; missingFieldLabels: string[] } {
        const missingFields: string[] = [];
        const missingFieldLabels: string[] = [];
        const yrList = ['2023', '2024', '2025'];

        // 最新年报数据
        const latestAnnual = [...annualData].sort((a, b) => b.year.localeCompare(a.year))[0];

        // 营收缺失
        if (latestAnnual && (latestAnnual.revenue == null || latestAnnual.revenue === 0)) {
            missingFields.push('revenue');
            missingFieldLabels.push('营业收入');
        }

        // 净利缺失
        if (latestAnnual && (latestAnnual.netProfit == null || latestAnnual.netProfit === 0)) {
            missingFields.push('net_profit');
            missingFieldLabels.push('归母净利润');
        }

        // 毛利率缺失（3年中有≥1期）
        const gmNullCount = yrList.filter(y => this.getIndicator(indicators, y, 'grossprofit_margin') == null).length;
        if (gmNullCount > 0) {
            missingFields.push('gross_profit_margin');
            missingFieldLabels.push('毛利率');
        }

        // ROE缺失
        const roeNullCount = yrList.filter(y => this.getIndicator(indicators, y, 'roe') == null).length;
        if (roeNullCount > 0) {
            missingFields.push('roe');
            missingFieldLabels.push('ROE');
        }

        // 经营现金流缺失
        const cfNullCount = yrList.filter(y => this.getCashflowValue(cashflows, y, 'n_cashflow_act') == null).length;
        if (cfNullCount > 0) {
            missingFields.push('operating_cash_flow');
            missingFieldLabels.push('经营现金流');
        }

        return { isPartial: missingFields.length > 0, missingFields, missingFieldLabels };
    }

    /**
     * 构建 partial 状态的返回结果
     */
    private static async buildPartialResult(
        symbol: string,
        stockName: string,
        annualData: { endDate: string; year: string; revenue: number | null; netProfit: number | null }[],
        indicators: FinancialMetric[],
        cashflows: FinancialMetric[],
        availableYears: number,
        missingFields: string[],
        missingFieldLabels: string[],
        latest2026: { revenueYOY: number | null; profitYOY: number | null } | null,
        yrList: string[],
    ): Promise<AiScoreResult> {
        // 获取原始研判标签
        const latestAnnual = [...annualData].sort((a, b) => b.year.localeCompare(a.year))[0];
        let originalTag = '';
        let originalTagColor = '#378ADD';
        if (latestAnnual) {
            // 查找对应的 endDate 用于 AiTagService
            const latestRow = await pool.query(
                `SELECT end_date FROM performance_reports
                 WHERE symbol = $1 AND report_type = 'formal'
                 ORDER BY end_date DESC LIMIT 1`,
                [symbol]
            );
            if (latestRow.rows.length > 0) {
                const endDate = latestRow.rows[0].end_date;
                const tag = await AiTagService.computeForFormal(
                    symbol, endDate,
                    latestAnnual.revenue, latestAnnual.netProfit
                );
                if (tag) {
                    originalTag = tag;
                    originalTagColor = AiTagService.isGoodTag(tag) ? '#1D9E75'
                        : AiTagService.isBadTag(tag) ? '#E24B4A'
                        : '#378ADD';
                }
            }
        }

        // 生成已确认亮点
        const highlights = this.generateAvailableHighlights(
            annualData, indicators, cashflows, latest2026, yrList
        );

        // 确定数据周期描述
        let dataPeriod = `基于${availableYears}期年报数据`;
        if (latest2026) {
            // 判断是半年报还是一季报
            const yr = ['2023', '2024', '2025'];
            const hasAllThree = yr.every(y => annualData.find(d => d.year === y));
            dataPeriod = hasAllThree
                ? '基于2023-2025三年年报数据'
                : `基于${availableYears}期年报数据`;
        }

        // 确定最新报告期标签
        let latestReportType = '';
        if (latest2026) {
            // 取2026报告期的标签
            const labelRow = await pool.query(
                `SELECT end_date FROM performance_reports
                 WHERE symbol = $1 AND end_date LIKE '2026%' AND report_type = 'formal'
                 ORDER BY end_date DESC LIMIT 1`,
                [symbol]
            );
            if (labelRow.rows.length > 0) {
                const ed = labelRow.rows[0].end_date;
                if (ed.endsWith('0630')) latestReportType = '2026半年报';
                else if (ed.endsWith('0331')) latestReportType = '2026一季报';
                else latestReportType = ed;
            }
        }

        // 生成缺失字段提示
        const prompt = missingFieldLabels.length > 0
            ? `${missingFieldLabels[0]}数据披露后可生成完整AI研判`
            : '待更多数据披露后可生成完整AI研判';

        return {
            symbol,
            stockName,
            score: null,
            rating: null,
            ratingLevel: null,
            ratingColor: null,
            conclusion: null,
            conclusionSub: null,
            advice: null,
            dataPeriod,
            reportCount: availableYears,
            dataStatus: 'partial',
            message: null,
            dimensions: [],
            strengths: [],
            risks: [],
            originalTag: originalTag || undefined,
            originalTagColor: originalTagColor || undefined,
            missingFields,
            missingFieldLabels,
            availableHighlights: highlights,
            latestReportType: latestReportType || undefined,
            prompt,
        };
    }

    /**
     * 根据已有的数据字段自动生成亮点
     */
    private static generateAvailableHighlights(
        annualData: { year: string; revenue: number | null; netProfit: number | null }[],
        indicators: FinancialMetric[],
        cashflows: FinancialMetric[],
        latest2026: { revenueYOY: number | null; profitYOY: number | null } | null,
        yrList: string[],
    ): AvailableHighlight[] {
        const highlights: AvailableHighlight[] = [];

        // 净利润同比亮点/风险
        if (latest2026?.profitYOY != null) {
            if (latest2026.profitYOY > 0) {
                const prevProfit = annualData.find(d => d.year === '2025')?.netProfit;
                const prevPrevProfit = annualData.find(d => d.year === '2024')?.netProfit;
                const consecutiveText = (prevProfit != null && prevPrevProfit != null && prevProfit > prevPrevProfit)
                    ? '，连续2期正增长' : '';
                highlights.push({
                    type: 'profit_growth',
                    label: '净利大幅提升',
                    detail: `最新净利润同比+${latest2026.profitYOY.toFixed(1)}%${consecutiveText}`,
                    icon: 'trend_up',
                    color: '#1D9E75',
                });
            } else {
                highlights.push({
                    type: 'profit_decline',
                    label: '净利下滑',
                    detail: `最新净利润同比${latest2026.profitYOY.toFixed(1)}%，需关注`,
                    icon: 'trend_down',
                    color: '#E24B4A',
                });
            }
        }

        // 现金流质量
        const latestCf = this.getCashflowValue(cashflows, '2025', 'n_cashflow_act');
        const latestProfit = annualData.find(d => d.year === '2025')?.netProfit;
        if (latestCf != null && latestProfit != null && latestProfit !== 0) {
            const ratio = latestCf / latestProfit;
            if (ratio > 1) {
                highlights.push({
                    type: 'cashflow_good',
                    label: '现金流充裕',
                    detail: `经营现金流/净利润=${ratio.toFixed(2)}，利润含金量高`,
                    icon: 'cash',
                    color: '#378ADD',
                });
            } else if (ratio < 0.5) {
                highlights.push({
                    type: 'cashflow_weak',
                    label: '现金流偏弱',
                    detail: `经营现金流/净利润=${ratio.toFixed(2)}，利润含金量偏低`,
                    icon: 'warning',
                    color: '#EF9F27',
                });
            }
        }

        // 负债率
        const latestDr = this.getIndicator(indicators, '2025', 'debt_to_assets');
        if (latestDr != null) {
            if (latestDr < 40) {
                highlights.push({
                    type: 'low_debt',
                    label: '负债率低',
                    detail: `资产负债率${latestDr.toFixed(1)}%，远低于行业均值`,
                    icon: 'shield',
                    color: '#1D9E75',
                });
            } else if (latestDr > 70) {
                highlights.push({
                    type: 'high_debt',
                    label: '负债率偏高',
                    detail: `资产负债率${latestDr.toFixed(1)}%，杠杆偏高需关注`,
                    icon: 'warning',
                    color: '#EF9F27',
                });
            }
        }

        // ROE稳定性
        const roeList = yrList.map(y => this.getIndicator(indicators, y, 'roe'));
        const validRoe = roeList.filter((x): x is number => x != null);
        if (validRoe.length >= 2 && validRoe.every(r => r > 15)) {
            highlights.push({
                type: 'roe_stable',
                label: 'ROE持续优秀',
                detail: `ROE连续${validRoe.length}年>15%，盈利能力稳定`,
                icon: 'shield',
                color: '#1D9E75',
            });
        }

        return highlights;
    }

    // ================================================================
    //  工具方法
    // ================================================================

    private static avg(list: number[]): number {
        return list.length === 0 ? 0 : list.reduce((a, b) => a + b, 0) / list.length;
    }

    private static stdDev(list: number[]): number {
        if (list.length < 2) return 0;
        const m = this.avg(list);
        return Math.sqrt(list.reduce((s, v) => s + (v - m) ** 2, 0) / (list.length - 1));
    }

    private static calcYoy(current: number | null, previous: number | null): number | null {
        if (current == null || previous == null || previous === 0) return null;
        return (current - previous) / Math.abs(previous) * 100;
    }
}

export const aiScoreService = new AiScoreService();
