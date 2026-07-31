/**
 * AI 业绩研判标签服务
 *
 * 根据财务指标（营收、净利）同比变化，自动判定 8 种业绩标签：
 *   红色底（好）：向好、高增、修复、扭盈
 *   绿色底（差）：承压、走弱、疲弱、转亏
 *
 * 判定逻辑（按优先级从高到低）：
 *   1. 净利润由正转负 → 转亏
 *   2. 净利润由负转正 → 扭盈
 *   3. 营收同比 >= 20% 且 净利同比 >= 20% → 高增
 *   4. 上期净利同比 < 0 且 本期净利同比 > 0 → 修复（从下滑中恢复）
 *   5. 营收同比 < 0   且 净利同比 < -30% → 疲弱
 *   6. 营收同比 >= 0  且 净利同比 < 0   → 承压
 *   7. 营收同比 < 0   且 净利同比 >= 0  → 走弱
 *   8. 营收同比 >= 0  且 净利同比 >= 0  → 向好（兜底）
 */

import pool from '../../core/db';

/** 财务数据对比结果 */
interface FinancialComparison {
    /** 当前期营收（亿元） */
    currentRevenue: number | null;
    /** 上一期营收（亿元） */
    prevRevenue: number | null;
    /** 当前期归母净利（亿元） */
    currentProfit: number | null;
    /** 上一期归母净利（亿元） */
    prevProfit: number | null;
}

/** 8 种业绩标签 */
export type AiTag = '向好' | '高增' | '修复' | '扭盈' | '承压' | '走弱' | '疲弱' | '转亏' | '';

export class AiTagService {
    /**
     * 为指定股票的某一期正式报告计算 AI 标签
     * @param symbol 股票代码
     * @param endDate 当前报告期（如 20241231）
     * @param currentRevenue 当前营收
     * @param currentProfit 当前归母净利
     */
    static async computeForFormal(
        symbol: string,
        endDate: string,
        currentRevenue: number | null,
        currentProfit: number | null,
    ): Promise<AiTag> {
        // 无利润数据 → 无法判定
        if (currentProfit == null) return '';

        const prev = await this.getPreviousFormal(symbol, endDate, 0);
        const prevProfit = prev?.n_income_attr_p ?? null;
        const prevRevenue = prev?.total_revenue ?? null;

        // 获取上上期利润数据，用于计算"上期净利同比"（修复判定需要）
        const prevPrev = await this.getPreviousFormal(symbol, endDate, 1);
        const prevPrevProfit = prevPrev?.n_income_attr_p ?? null;

        return this.judgeFormal(currentRevenue, currentProfit, prevRevenue, prevProfit, prevPrevProfit);
    }

    /**
     * 为快报/预告计算 AI 标签（仅利润数据）
     */
    static async computeForExpress(
        symbol: string,
        endDate: string,
        currentProfit: number | null,
    ): Promise<AiTag> {
        if (currentProfit == null) return '';

        const prev = await this.getPreviousFormal(symbol, endDate);
        const prevProfit = prev?.n_income_attr_p ?? null;

        return this.judgeProfitOnly(currentProfit, prevProfit);
    }

    /**
     * 为研报评级计算 AI 标签（基于评级文字）
     */
    static computeForRating(rating: string): AiTag {
        const r = (rating || '').trim();
        if (/买入|增持|强烈推荐|推荐|优于大市|跑赢行业/.test(r)) return '向好';
        if (/中性|持有|同步大市/.test(r)) return '修复';
        if (/减持|卖出|弱于大市/.test(r)) return '走弱';
        return '';
    }

    // ================================================================
    //  正式报告判定核心逻辑
    // ================================================================

    private static judgeFormal(
        currRev: number | null,
        currProfit: number | null,
        prevRev: number | null,
        prevProfit: number | null,
        prevPrevProfit: number | null,
    ): AiTag {
        // 1. 转亏：上期净利>0 且 本期净利<0
        if (prevProfit != null && currProfit != null) {
            if (prevProfit > 0 && currProfit < 0) return '转亏';
        }

        // 2. 扭盈：上期净利<0 且 本期净利>0
        if (prevProfit != null && currProfit != null) {
            if (prevProfit < 0 && currProfit > 0) return '扭盈';
        }

        // 计算同比
        const revYoy = this.calcYoy(currRev, prevRev);
        const profitYoy = this.calcYoy(currProfit, prevProfit);
        const prevProfitYoy = this.calcYoy(prevProfit, prevPrevProfit);

        // 3. 高增：营收同比>=20% 且 净利同比>=20%
        if (revYoy != null && profitYoy != null) {
            if (revYoy >= 20 && profitYoy >= 20) return '高增';
        }

        // 4. 修复：上期净利同比<0 且 本期净利同比>0（从下滑中恢复）
        if (prevProfitYoy != null && profitYoy != null) {
            if (prevProfitYoy < 0 && profitYoy > 0) return '修复';
        }

        // 5. 疲弱：营收同比<0 且 净利同比<-30%
        if (revYoy != null && profitYoy != null) {
            if (revYoy < 0 && profitYoy < -30) return '疲弱';
        }

        // 6. 承压：营收同比>=0 且 净利同比<0
        if (revYoy != null && profitYoy != null) {
            if (revYoy >= 0 && profitYoy < 0) return '承压';
        }

        // 7. 走弱：营收同比<0 且 净利同比>=0
        if (revYoy != null && profitYoy != null) {
            if (revYoy < 0 && profitYoy >= 0) return '走弱';
        }

        // 8. 向好：营收同比>=0 且 净利同比>=0 且 非高增（兜底）
        if (revYoy != null && profitYoy != null) {
            if (revYoy >= 0 && profitYoy >= 0) return '向好';
        }

        // 极少数情况（营收或净利数据缺失），兜底返回修复
        return '修复';
    }

    /**
     * 仅净利数据的判定（快报/预告）
     */
    private static judgeProfitOnly(
        currProfit: number,
        prevProfit: number | null,
    ): AiTag {
        // 1. 转亏：上期净利>0 且 本期净利<0
        if (prevProfit != null) {
            if (prevProfit > 0 && currProfit < 0) return '转亏';
        }

        // 2. 扭盈：上期净利<0 且 本期净利>0
        if (prevProfit != null) {
            if (prevProfit < 0 && currProfit > 0) return '扭盈';
        }

        const yoy = this.calcYoy(currProfit, prevProfit);

        if (yoy != null) {
            // 3. 高增：净利同比 >= 20%
            if (yoy >= 20) return '高增';
            // 4. 向好：净利同比 >= 0%
            if (yoy >= 0) return '向好';
            // 5. 疲弱：净利同比 < -40%
            if (yoy < -40) return '疲弱';
        }

        // 6. 走弱：兜底（-40%到0%之间）
        return '走弱';
    }

    // ================================================================
    //  工具方法
    // ================================================================

    /**
     * 计算同比变化百分比
     */
    private static calcYoy(current: number | null, previous: number | null): number | null {
        if (current == null || previous == null || previous === 0) return null;
        return ((current - previous) / Math.abs(previous)) * 100;
    }

    /**
     * 获取同一股票往前第 N 期的正式报告数据
     * @param symbol 股票代码
     * @param currentEndDate 当前报告期
     * @param offset 偏移量：0=上一期，1=上两期，依此类推
     */
    private static async getPreviousFormal(
        symbol: string,
        currentEndDate: string,
        offset: number = 0,
    ): Promise<{ total_revenue: number | null; n_income_attr_p: number | null } | null> {
        try {
            const result = await pool.query(
                `SELECT total_revenue, n_income_attr_p
                 FROM performance_reports
                 WHERE symbol = $1
                   AND report_type = 'formal'
                   AND end_date < $2
                 ORDER BY end_date DESC
                 LIMIT 1 OFFSET $3`,
                [symbol, currentEndDate, offset],
            );
            if (result.rows.length === 0) return null;
            return result.rows[0];
        } catch {
            return null;
        }
    }

    /** 标签是否属于"好"（红色底） */
    static isGoodTag(tag: string): boolean {
        return ['向好', '高增', '修复', '扭盈'].includes(tag);
    }

    /** 标签是否属于"差"（绿色底） */
    static isBadTag(tag: string): boolean {
        return ['承压', '走弱', '疲弱', '转亏'].includes(tag);
    }
}
