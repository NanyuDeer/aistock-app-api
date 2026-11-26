/**
 * 现象罕见度（state_rarity_daily）
 *
 * 用途：给市场洞见的"现象发现"提供频率维度。
 *   现状是 5 条绝对阈值规则，实测 77.4% 的交易日至少一条成立 —— 等于没有闸门。
 *   本脚本产出"当日幅度在过去 3 年的分位"，让 discovery 只有在**够罕见**时才认这条现象。
 *
 * 【口径】
 *   - 窗口：当日之前 750 个自然日（约 500 个交易日），**严格不含当日**（PIT）。
 *   - 分位定义：窗口内严格小于当日值的天数 / 窗口天数。当日是窗口内最大值时 = 1.0。
 *   - 四个幅度：广度 / 跌幅（= 1-广度，独立算） / 风格落差 / 涨跌停压力。
 *
 * 【为什么独立算 decline_rank 而不是 1-breadth_rank】
 *   并列值时 rank(1-x) ≠ 1-rank(x)。差得很小但会在阈值边界上产生不可解释的翻转，
 *   而"同一输入同一结论"是硬约束，所以两边各算一次。
 *
 * 用法：
 *   node --import tsx scripts/build-state-rarity.ts
 *   node --import tsx scripts/build-state-rarity.ts --check
 *
 * 前置：030（index_daily）+ 032（state_daily）已建并有数。
 */

import pool from '../src/core/db';

const SPEC_VERSION = 'v1';
/** 观察窗口（自然日）。750 ≈ 3 年，与 S2 的 PIT 分位窗口保持一致。 */
const WINDOW_DAYS = 750;
/** 窗口内最少样本天数；不足则 window_days 如实记录，调用方自行判断可用性。 */
const MIN_USABLE_DAYS = 250;

function hasFlag(n: string): boolean {
    return process.argv.includes(`--${n}`);
}

const SQL = `
WITH idx AS (
    SELECT trade_date,
           max(pct_chg) FILTER (WHERE ts_code = '000300.SH') AS c300,
           max(pct_chg) FILTER (WHERE ts_code = '000852.SH') AS c1000
      FROM index_daily
     WHERE ts_code IN ('000300.SH', '000852.SH')
     GROUP BY 1
), m AS (
    -- 四个幅度指标。只用 state_daily 与指数日线，不引入任何规则阈值
    -- （阈值留在 agent-py 的 settings，避免两处各写一套）
    SELECT s.trade_date,
           s.breadth_up_ratio                              AS r_sc,
           1 - s.breadth_up_ratio                          AS d_sc,
           abs(i.c300 - i.c1000)                           AS st_sc,
           greatest(s.limit_up_pct, s.limit_down_pct)      AS se_sc
      FROM state_daily s
      -- LEFT JOIN：指数日线若比个股晚一天更新，INNER JOIN 会把最新那天整行丢掉
      LEFT JOIN idx i ON i.trade_date = s.trade_date
), ranked AS (
    -- LEFT JOIN LATERAL：第一个交易日没有历史窗口，必须保留成 n=0 的行，
    -- 用 CROSS JOIN 会把它整行丢掉（然后表里就没有那天，查询会以为是数据缺失）
    SELECT t.trade_date, w.n,
           w.p_breadth, w.p_decline, w.p_style, w.p_limit
      FROM m t
      LEFT JOIN LATERAL (
           SELECT count(*)                                                        AS n,
                  count(*) FILTER (WHERE m2.r_sc  < t.r_sc)::float
                      / NULLIF(count(*), 0)                                       AS p_breadth,
                  count(*) FILTER (WHERE m2.d_sc  < t.d_sc)::float
                      / NULLIF(count(*), 0)                                       AS p_decline,
                  count(*) FILTER (WHERE m2.st_sc < t.st_sc)::float
                      / NULLIF(count(*), 0)                                       AS p_style,
                  count(*) FILTER (WHERE m2.se_sc < t.se_sc)::float
                      / NULLIF(count(*), 0)                                       AS p_limit
             FROM m m2
            WHERE m2.trade_date >= t.trade_date - $1::int
              AND m2.trade_date <  t.trade_date
      ) w ON true
)
INSERT INTO state_rarity_daily
    (trade_date, breadth_rank, decline_rank, style_rank, limit_rank, window_days, spec_version)
SELECT trade_date,
       COALESCE(p_breadth, 0), COALESCE(p_decline, 0),
       COALESCE(p_style, 0),   COALESCE(p_limit, 0),
       n, $2
  FROM ranked
ON CONFLICT (trade_date) DO UPDATE SET
    breadth_rank = EXCLUDED.breadth_rank,
    decline_rank = EXCLUDED.decline_rank,
    style_rank   = EXCLUDED.style_rank,
    limit_rank   = EXCLUDED.limit_rank,
    window_days  = EXCLUDED.window_days,
    spec_version = EXCLUDED.spec_version,
    computed_at  = now()
`;

async function check(): Promise<void> {
    const base = await pool.query(
        `SELECT count(*) AS rows,
                min(trade_date)::text AS d0,
                max(trade_date)::text AS d1,
                min(window_days) AS min_win,
                count(*) FILTER (WHERE window_days < $1) AS short_window
           FROM state_rarity_daily WHERE spec_version = $2`,
        [MIN_USABLE_DAYS, SPEC_VERSION],
    );
    console.table(base.rows[0]);

    const dist = await pool.query(
        `SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY breadth_rank)::numeric,3) AS breadth_p50,
                round(percentile_cont(0.9) WITHIN GROUP (ORDER BY breadth_rank)::numeric,3) AS breadth_p90,
                round(percentile_cont(0.5) WITHIN GROUP (ORDER BY style_rank)::numeric,3)   AS style_p50,
                round(percentile_cont(0.9) WITHIN GROUP (ORDER BY style_rank)::numeric,3)   AS style_p90,
                round(percentile_cont(0.5) WITHIN GROUP (ORDER BY limit_rank)::numeric,3)   AS limit_p50,
                round(percentile_cont(0.9) WITHIN GROUP (ORDER BY limit_rank)::numeric,3)   AS limit_p90
           FROM state_rarity_daily WHERE spec_version = $1`,
        [SPEC_VERSION],
    );
    console.table(dist.rows[0]);

    // 标注用例核对：这 5 天是 historical_snapshots/cases.json 里人工标的事件日
    const probes = await pool.query(
        `SELECT trade_date::text AS d, round(breadth_rank::numeric,3) AS breadth,
                round(decline_rank::numeric,3) AS decline, round(style_rank::numeric,3) AS style,
                round(limit_rank::numeric,3) AS lim, window_days
           FROM state_rarity_daily
          WHERE trade_date IN ('2024-09-24','2024-09-30','2024-10-08','2024-10-09','2025-04-07','2024-02-05','2026-11-20')
          ORDER BY 1`,
    );
    console.log('\n标注用例核对（目标规则的分位应 >= 0.986）：');
    console.table(probes.rows);
}

async function main(): Promise<void> {
    const checkOnly = hasFlag('check');

    if (!checkOnly) {
        const pre = await pool.query(
            `SELECT (SELECT count(*) FROM state_daily) AS st,
                    (SELECT count(*) FROM index_daily WHERE ts_code = '000852.SH') AS idx`,
        );
        if (Number(pre.rows[0].st) === 0 || Number(pre.rows[0].idx) === 0) {
            throw new Error('state_daily 或 index_daily 为空，先跑 S2 构建。');
        }

        // 不同 spec_version 不可混存：重算即整表替换当前版本
        const stale = await pool.query(
            `DELETE FROM state_rarity_daily WHERE spec_version <> $1 RETURNING 1`,
            [SPEC_VERSION],
        );
        if ((stale.rowCount ?? 0) > 0) {
            console.log(`清理旧版本行 ${stale.rowCount} 条`);
        }

        console.log(`计算 ${WINDOW_DAYS} 日窗口分位…`);
        const t0 = Date.now();
        const res = await pool.query(SQL, [WINDOW_DAYS, SPEC_VERSION]);
        console.log(`写入 ${res.rowCount} 行，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    await check();
    await pool.end();
}

main().catch(async (e) => {
    console.error('\n失败：', e instanceof Error ? e.message : e);
    await pool.end().catch(() => undefined);
    process.exit(1);
});
