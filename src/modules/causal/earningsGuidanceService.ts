/**
 * 业绩预告的行业聚合。
 *
 * ⚠ 语义红线：这是**公司自己披露的业绩预告中位数**，不是卖方一致预期。
 *   业绩预告发布时市场往往已定价，因此它反映「景气方向」，不反映「预期差」。
 *   代码、注释、报告文案中不得用「一致预期」「超预期」来指代它。
 *   真正的预期差走 macroExpectations（宏观）或 M4 的 report_rc（个股）。
 *
 * 为什么不进图谱节点：
 *   stocks 表没有市值字段，只能等权。等权中位数的精度不足以支撑图谱结构改动
 *   （加 5 个子节点 + 多条边，而那些边又没有数据能验证）。作为证据交给 L2 消费
 *   更诚实。
 *
 * 为什么用中位数而非均值：
 *   个别公司动辄几百个点的预告会让均值完全失真。中位数对极端值免疫。
 */

import pool from '../../core/db';

/** 低于此样本量的行业不出结果——中位数没有统计意义。 */
const MIN_SAMPLE = 5;

export interface IndustryGuidance {
    /** 该行业已披露业绩预告公司的净利润同比中位数（%） */
    medianYoy: number;
    /** 参与计算的样本数 */
    sample: number;
}

export interface IndustryGuidanceDeps {
    query: (
        sql: string,
        params: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[] }>;
}

const defaultDeps: IndustryGuidanceDeps = {
    query: (sql, params) => pool.query(sql, params),
};

/** 按行业聚合业绩预告的净利润同比中位数。 */
export async function queryIndustryGuidance(
    deps: IndustryGuidanceDeps = defaultDeps,
): Promise<Record<string, IndustryGuidance>> {
    const result = await deps.query(
        `SELECT s.industry,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY f.forecast_netprofit_yoy) AS median_yoy,
                count(*) AS sample
           FROM earnings_forecast f
           JOIN stocks s ON s.symbol = f.symbol
          WHERE f.forecast_netprofit_yoy IS NOT NULL
            AND s.industry IS NOT NULL
            AND s.industry <> ''
       GROUP BY s.industry
         HAVING count(*) >= $1`,
        [MIN_SAMPLE],
    );

    const output: Record<string, IndustryGuidance> = {};
    for (const row of result.rows) {
        const medianYoy = Number(row.median_yoy);
        const sample = Number(row.sample);
        if (!Number.isFinite(medianYoy) || !Number.isFinite(sample)) continue;
        output[String(row.industry)] = {
            medianYoy: Math.round(medianYoy * 100) / 100,
            sample,
        };
    }
    return output;
}
