-- 024_stock_info_judgements_per_stock_dedupe.sql
-- 2026-11-08：个股资讯研判去重粒度由「文章」改为「股票 + 文章」
--
-- 背景：同一篇文章会被多只股票的新闻搜索返回，而 AI 研判是针对「这只股票」出的
--       （ai_summary 讲的就是该股）。文章级 dedupe_key 会把它们压成一行：
--       symbol 是首只股票、ai_summary 被后一只股票的研判覆盖 →
--       A 的「个股异动」里出现讲 B 的摘要（如茅台名下出现中际旭创/江波龙）。
--       同步代码修复：StockInfoService.buildStockInfoDedupeRawKey 计入 symbol。
--
-- 键格式（必须与 StockInfoService.buildStockInfoDedupeRawKey 完全一致）：
--   有 source_id：source|info_type|source_id|symbol
--   无 source_id：symbol|info_type|title|url
-- 哈希：md5 十六进制小写（Node crypto.createHash('md5') 与 PostgreSQL 内置 md5() 结果一致，
--       故用 md5 便于直接在库里复算，无需 pgcrypto 扩展）。
--
-- 执行时机：必须与新版代码同批上线。若先上新代码而不迁移，旧键（sha1 + 文章级）与新键
--           不匹配，getExistingJudgements 会判为「未抓过」→ 同一篇文章被重新研判入库，
--           同一股票会出现「旧脏行 + 新正确行」两条。
-- 幂等：重复执行结果一致（纯函数式重算）。
--
-- 执行方式（在数据库所在机器上，使用应用的 DATABASE_URL）：
--   psql "$DATABASE_URL" -f src/db/migrations/024_stock_info_judgements_per_stock_dedupe.sql

-- ---------------------------------------------------------------------------
-- 第 0 步：诊断（只读）——迁移前后各跑一次
-- ---------------------------------------------------------------------------
-- 0.1 总行数、带 source_id 的行数
SELECT count(*)                                                   AS total_rows,
       count(*) FILTER (WHERE source_id IS NOT NULL AND btrim(source_id) <> '') AS with_source_id
FROM stock_info_judgements;

-- 0.2 同一篇文章（source|info_type|source_id）当前被几只股票共用（>1 说明文章级去重仍在生效）
SELECT source, info_type, source_id, count(*) AS rows_per_article
FROM stock_info_judgements
WHERE source_id IS NOT NULL AND btrim(source_id) <> ''
GROUP BY 1, 2, 3
HAVING count(*) > 1
ORDER BY rows_per_article DESC
LIMIT 20;

-- ---------------------------------------------------------------------------
-- 第 1 步：按「股票 + 文章」重算去重键
-- ---------------------------------------------------------------------------
BEGIN;

UPDATE stock_info_judgements
SET dedupe_key = md5(
        CASE
            WHEN source_id IS NOT NULL AND btrim(source_id) <> ''
                THEN source || '|' || info_type || '|' || source_id || '|' || symbol
            ELSE symbol || '|' || info_type || '|' || title || '|' || url
        END
    );

-- ---------------------------------------------------------------------------
-- 第 2 步：复核（只读）
-- ---------------------------------------------------------------------------
-- 2.1 仍存在共用同一去重键的行 → 应为 0 行
SELECT dedupe_key, count(*) AS cnt
FROM stock_info_judgements
GROUP BY dedupe_key
HAVING count(*) > 1;

COMMIT;

-- 注意：本次迁移只改「去重键」，**不修复已错配的历史行**（其 ai_summary 已被别家股票覆盖、
--       原始内容不可还原）。错配行清单见 docs/sql/stock_info_misattribution_report.sql。
--       清理后这些行会被正确股票重新抓到入库（去重键已按股票隔离，不会再互相干扰）。
