-- ============================================================================
-- 修复「个股资讯归属错配」历史脏数据（2026-11-07）
--
-- 现象：自选消息面板按贵州茅台（600519）筛选时，出现「江波龙：资讯异动」
--       「中际旭创：资讯异动」等别的自选股的个股情报消息。
--
-- 根因：stock_info_judgements.dedupe_key 按「文章」去重（source|info_type|source_id），
--       同一篇文章会被多只股票的新闻搜索返回；入库冲突时旧 SQL 执行
--       `DO UPDATE SET stock_name = EXCLUDED.stock_name`（symbol 不在 SET 列表），
--       于是留下「symbol=股票A + stock_name=股票B」的错配行。
--       建 App 通知时用 symbol 决定投递给谁、用 stock_name 拼标题
--       （`${stock_name}：资讯异动`），B 的资讯就挂到了 A 名下。
--
-- 同步代码修复（需部署后生效）：
--   1. StockInfoService.upsertJudgements：冲突更新不再改写 stock_name（身份字段不可改）
--   2. StockInfoPushService.push：建通知前用 stocks 表权威名称校验，名称错配直接跳过
--
-- 执行方式（在数据库所在机器上，使用应用的 DATABASE_URL）：
--   psql "$DATABASE_URL" -f docs/sql/fix_stock_info_attribution.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 第 1 步：诊断（只读，先看清影响面再决定是否清理）
-- ---------------------------------------------------------------------------
-- 1.1 受影响的通知条数 / 股票数
SELECT n.category,
       count(*)                        AS dirty_rows,
       count(DISTINCT n.symbol)        AS dirty_symbols,
       count(DISTINCT n.openid)        AS affected_users
FROM user_notifications n
JOIN stocks s ON s.symbol = n.symbol
WHERE n.stock_name IS NOT NULL
  AND btrim(n.stock_name) <> ''
  AND n.stock_name <> s.name
GROUP BY n.category
ORDER BY dirty_rows DESC;

-- 1.2 明细抽样（确认确实是「别的股票名挂在当前代码下」）
SELECT n.symbol            AS symbol_代码,
       s.name              AS 权威名称,
       n.stock_name        AS 通知里的名称,
       n.title             AS 标题,
       n.created_at
FROM user_notifications n
JOIN stocks s ON s.symbol = n.symbol
WHERE n.stock_name IS NOT NULL
  AND btrim(n.stock_name) <> ''
  AND n.stock_name <> s.name
ORDER BY n.created_at DESC
LIMIT 50;

-- 1.3 研判表同样口径的错配行
SELECT j.symbol AS symbol_代码,
       s.name   AS 权威名称,
       j.stock_name AS 研判名称,
       count(*) AS cnt
FROM stock_info_judgements j
JOIN stocks s ON s.symbol = j.symbol
WHERE j.stock_name IS NOT NULL
  AND btrim(j.stock_name) <> ''
  AND j.stock_name <> s.name
GROUP BY j.symbol, s.name, j.stock_name
ORDER BY cnt DESC
LIMIT 50;

-- ---------------------------------------------------------------------------
-- 第 2 步：清理（写操作；确认第 1 步结果后再执行）
--
-- 删除而不是改名：这些行记录的是「文章属于另一只股票」，改 stock_name 只会让标题
-- 强行对上代码、内容依旧无关。删掉通知 + 研判行后，该文章会被正确股票重新抓到入库
-- （dedupe_key 随之释放，不会被 getExistingJudgements 判为已存在而永久漏抓）。
-- ---------------------------------------------------------------------------
BEGIN;

-- 2.1 删除归属错配的自选消息通知（仅个股情报分类）
DELETE FROM user_notifications n
USING stocks s
WHERE n.symbol = s.symbol
  AND n.category = 'stock_info'
  AND n.stock_name IS NOT NULL
  AND btrim(n.stock_name) <> ''
  AND n.stock_name <> s.name;

-- 2.2 删除归属错配的资讯研判行（释放 dedupe_key，允许按正确股票重新入库）
DELETE FROM stock_info_judgements j
USING stocks s
WHERE j.symbol = s.symbol
  AND j.stock_name IS NOT NULL
  AND btrim(j.stock_name) <> ''
  AND j.stock_name <> s.name;

-- 2.3 复核：两条都应为 0
SELECT
    (SELECT count(*) FROM user_notifications n JOIN stocks s ON s.symbol = n.symbol
      WHERE n.category = 'stock_info' AND n.stock_name IS NOT NULL
        AND btrim(n.stock_name) <> '' AND n.stock_name <> s.name) AS remaining_notifications,
    (SELECT count(*) FROM stock_info_judgements j JOIN stocks s ON s.symbol = j.symbol
      WHERE j.stock_name IS NOT NULL AND btrim(j.stock_name) <> ''
        AND j.stock_name <> s.name)                                AS remaining_judgements;

COMMIT;

-- ============================================================================
-- 第 3 步：清理「相关性噪音」（2026-11-07 新闻相关性门槛上线后）
--
-- 背景：新闻接口是按股票代码全文检索，命中里大量是「百元股数量达153只」
--       「77股获机构买入评级」「主力动向：特大单净流入…」这类只列举代码的市场统计/名单，
--       2026-11-07 起入库前由 AI 判定 ai_relevance，只有 stock_specific / sector 才入库。
--
-- 注意：ai_relevance 是本次新增列，**历史行为 NULL**（无法自动判定）。
--       新抓取的数据才带值，所以本步只能清「已带值且判为噪音」的行。
--       历史 NULL 行需要重抓（推荐）或人工抽查，见 3.3。
-- ============================================================================

-- 3.1 诊断：按相关性分布看清楚噪音占比
SELECT COALESCE(ai_relevance, '(历史未判定)') AS relevance,
       info_type,
       count(*) AS cnt
FROM stock_info_judgements
GROUP BY 1, 2
ORDER BY cnt DESC;

-- 3.2 清理已判定为噪音的研判行与其通知
BEGIN;

-- 先删通知（按 source_key 关联研判 id），避免留下指向已删研判的消息
DELETE FROM user_notifications n
USING stock_info_judgements j
WHERE n.category = 'stock_info'
  AND j.ai_relevance IN ('market', 'mention_only')
  AND n.payload->>'judgementId' = j.id::text;

DELETE FROM stock_info_judgements
WHERE ai_relevance IN ('market', 'mention_only');

COMMIT;

-- 3.3 历史 NULL 行说明（重要）：
--     抓取流程在入库前按 source_key 去重 —— 已存在的文章直接跳过、**不会重新研判**，
--     所以「重抓」无法回填历史行的 ai_relevance。可选处理：
--       a) 保守（推荐先做）：保留历史行。它们不会因本次改动再产生新通知，只是历史通知仍在；
--          配合第 2 步已清掉的错配行，剩下的噪音仅限「名称正确但内容是市场统计」。
--       b) 彻底：删除这些行以释放 dedupe_key，让下次抓取重新研判并写入 ai_relevance。
--          代价：抓取只看每只股票最新 N 条、且限于回溯窗口内，更早的文章不会再被抓回，等于丢弃历史。
--     先看分布再决定：
SELECT symbol, count(*) AS legacy_rows
FROM stock_info_judgements
WHERE ai_relevance IS NULL
GROUP BY symbol
ORDER BY legacy_rows DESC
LIMIT 30;
