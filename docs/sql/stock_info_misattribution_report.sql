-- ============================================================================
-- 个股资讯研判「归属错配」历史脏行清单（2026-11-08）
--
-- 用途：**只读清单**，不做任何写操作。供人工核对哪些历史行需要清理。
--
-- 背景：stock_info_judgements 原去重键按「文章」（source|info_type|source_id），
--       同一篇文章被多只股票抓到时共用一行：symbol 是首只股票，ai_summary 却被后一只
--       股票的研判覆盖 → 该行 code 与内容不一致，前端「个股异动」里 A 名下出现讲 B 的摘要
--       （例：贵州茅台 600519 名下出现「只把中际旭创列入…」「仅将江波龙列入…」）。
--
-- 判断口径（启发式，仅用于圈定可疑行，**不能自动删**）：
--   ai_summary 中出现的、长度 ≥3 的 A 股名称里**不含本行股票自己的权威名**
--   → 内容大概率属于别的股票。
--   反之：摘要不含任何股票名（行业/大盘类表述）时**保守保留**，不纳入清单。
--
-- 配套代码修复：dedupe_key 已改为「股票 + 文章」（迁移
--   src/db/migrations/024_stock_info_judgements_per_stock_dedupe.sql），此后新数据不再错配。
--
-- 执行方式（在数据库所在机器上，使用应用的 DATABASE_URL）：
--   psql "$DATABASE_URL" -f docs/sql/stock_info_misattribution_report.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 概况：按股票统计可疑行数量
-- ---------------------------------------------------------------------------
WITH matched AS (
    SELECT j.id,
           j.symbol,
           s.name AS authoritative_name,
           j.ai_summary,
           ARRAY(
               SELECT st.name
               FROM stocks st
               WHERE char_length(st.name) >= 3
                 AND position(st.name in j.ai_summary) > 0
               ORDER BY st.name
           ) AS mentioned_names
    FROM stock_info_judgements j
    LEFT JOIN stocks s ON s.symbol = j.symbol
    WHERE j.ai_summary IS NOT NULL
      AND btrim(j.ai_summary) <> ''
)
SELECT symbol                               AS 代码,
       authoritative_name                   AS 权威名称,
       count(*)                             AS 可疑行数,
       min(id)                              AS 最小id,
       max(id)                              AS 最大id
FROM matched
WHERE cardinality(mentioned_names) > 0
  AND (authoritative_name IS NULL OR NOT (authoritative_name = ANY(mentioned_names)))
GROUP BY symbol, authoritative_name
ORDER BY 可疑行数 DESC
LIMIT 50;

-- ---------------------------------------------------------------------------
-- 2. 明细：可疑行逐条列出（人工核对用）
-- ---------------------------------------------------------------------------
WITH matched AS (
    SELECT j.id,
           j.symbol,
           s.name AS authoritative_name,
           j.stock_name,
           j.info_type,
           j.title,
           j.url,
           j.ai_summary,
           j.ai_relevance,
           j.published_at,
           ARRAY(
               SELECT st.name
               FROM stocks st
               WHERE char_length(st.name) >= 3
                 AND position(st.name in j.ai_summary) > 0
               ORDER BY st.name
           ) AS mentioned_names
    FROM stock_info_judgements j
    LEFT JOIN stocks s ON s.symbol = j.symbol
    WHERE j.ai_summary IS NOT NULL
      AND btrim(j.ai_summary) <> ''
)
SELECT id,
       symbol                                              AS 代码,
       authoritative_name                                  AS 权威名称,
       stock_name                                          AS 研判名称,
       mentioned_names                                     AS 摘要提到的股票,
       info_type,
       title                                               AS 标题,
       left(ai_summary, 120)                               AS 摘要前120字,
       ai_relevance,
       published_at,
       url
FROM matched
WHERE cardinality(mentioned_names) > 0
  AND (authoritative_name IS NULL OR NOT (authoritative_name = ANY(mentioned_names)))
ORDER BY published_at DESC
LIMIT 300;

-- ---------------------------------------------------------------------------
-- 3. 参照：仍存在的「研判名称 ≠ 权威名称」行（旧口径脏行，另一类问题）
--    上一轮修复（见 fix_stock_info_attribution.sql）已止住新增，此处仅复核历史残留。
-- ---------------------------------------------------------------------------
SELECT j.symbol AS 代码,
       s.name   AS 权威名称,
       j.stock_name AS 研判名称,
       count(*) AS 行数
FROM stock_info_judgements j
JOIN stocks s ON s.symbol = j.symbol
WHERE j.stock_name IS NOT NULL
  AND btrim(j.stock_name) <> ''
  AND j.stock_name <> s.name
GROUP BY 1, 2, 3
ORDER BY 行数 DESC
LIMIT 50;

-- ---------------------------------------------------------------------------
-- 4. 清理建议（**确认后手动执行**，勿整段直接跑）
--
--    1) 先核对第 2 步明细：确认这些摘要确实在讲别的股票；
--    2) 删除对应行（会同时释放去重键，允许正确股票重新抓取入库）：
--         DELETE FROM stock_info_judgements WHERE id IN ( ... 第 2 步确认的 id ... );
--    3) 若这些行已生成过 App 通知，按 payload->>'judgementId' 一并删除：
--         DELETE FROM user_notifications
--         WHERE category = 'stock_info'
--           AND payload->>'judgementId' IN ( ... 同一批 id ... );
--    4) 复核：重新执行第 1、2 步，可疑行数应下降。
-- ---------------------------------------------------------------------------
