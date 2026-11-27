/**
 * 当日现象罕见度（state_rarity_daily）的取数。
 *
 * 【为什么不能按当日精确匹配】
 *   快照在 15:35（quick）/ 收盘后构建，而当日 `state_rarity_daily` 要等日链 18:20 才算出来。
 *   按 `trade_date = 当日` 查永远是 0 行 —— 这就是"闸门上线却从未生效"的根因：
 *   Python 侧注释写的是"15:30 的 state_rarity 是 T-1 收盘算的"，实现却在查当日。
 *
 * 【为什么回退到最近一行，而不是留空】
 *   罕见度是"这个现象在近三年分布里有多罕见"的频率维度。一天之隔的分位几乎不变，
 *   而留空会让闸门每天退回绝对阈值，等于白做。回退时用 `as_of` 把真实日期标出来，
 *   消费方（Python）可以据此判断，不允许它被当成"当日分位"。
 *
 * 【为什么要设过期上限】
 *   日链挂掉一周后还拿旧分位去筛现象，就是拿上上周的分布评今天。超过 7 个自然日
 *   一律按缺失处理并告警 —— 宁可退回绝对阈值，也不要一个看起来正常的陈旧值。
 */

import pool from '../../core/db';

export interface StateRarityFact {
    breadth_rank: number;
    decline_rank: number;
    style_rank: number;
    limit_rank: number;
    /** 窗口内实际交易日数；< 250 表示预热期，Python 侧视为不可用 */
    window_days: number;
    /** 这组分位对应的交易日（YYYY-MM-DD），可能早于请求日 */
    as_of: string;
}

export type SqlQuery = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** 分位最多能比请求日旧几天；超过就按缺失处理 */
export const MAX_RARITY_STALENESS_DAYS = 7;

const RARITY_SQL = `
    SELECT trade_date::text      AS as_of,
           breadth_rank::float8  AS breadth_rank,
           decline_rank::float8  AS decline_rank,
           style_rank::float8    AS style_rank,
           limit_rank::float8    AS limit_rank,
           window_days
      FROM state_rarity_daily
     WHERE trade_date <= $1::date
     ORDER BY trade_date DESC
     LIMIT 1
`;

/** 两个 YYYY-MM-DD 之间相差的自然日数；任一侧不可解析返回 Infinity。 */
export function stalenessDays(asOf: string, date: string): number {
    const a = Date.parse(`${asOf}T00:00:00Z`);
    const b = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
    return Math.round(Math.abs(b - a) / 86400000);
}

/**
 * 读 `date` 当日或之前最近一日的罕见度。
 * 当日没有就用上一交易日，但 `as_of` 会如实返回；超过 `maxStaleDays` 返回 null。
 */
export async function loadStateRarity(
    date: string,
    query: SqlQuery,
    maxStaleDays: number = MAX_RARITY_STALENESS_DAYS,
): Promise<StateRarityFact | null> {
    const { rows } = await query(RARITY_SQL, [date]);
    if (rows.length === 0) return null;

    const r = rows[0];
    const asOf = String(r.as_of);
    const gap = stalenessDays(asOf, date);
    if (gap > maxStaleDays) {
        console.warn(
            `[MarketSnapshot] state_rarity 过期 ${gap} 天（as_of=${asOf}，请求 ${date}），按缺失处理`,
        );
        return null;
    }

    return {
        breadth_rank: Number(r.breadth_rank),
        decline_rank: Number(r.decline_rank),
        style_rank: Number(r.style_rank),
        limit_rank: Number(r.limit_rank),
        window_days: Number(r.window_days),
        as_of: asOf,
    };
}

/**
 * 生产入口：任何异常降级为 null —— 罕见度缺失只意味着 Python 侧退回绝对阈值，
 * 不应该让整份收盘快照失败（那是归因链路的唯一输入）。
 */
export async function getStateRarity(date: string): Promise<StateRarityFact | null> {
    try {
        return await loadStateRarity(date, (sql, params) => pool.query(sql, params));
    } catch (err) {
        console.warn(
            '[MarketSnapshot] state_rarity 查询失败，按缺失处理:',
            err instanceof Error ? err.message : String(err),
        );
        return null;
    }
}
