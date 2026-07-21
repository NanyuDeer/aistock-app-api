-- 60日均线剔除规则：给 trend_scores 表增加 ma60_excluded 列
-- 规则：连续两日收盘价在60日均线下方 → ma60_excluded=true（从趋势股Top列表剔除）
--       重新站上60日线 → ma60_excluded=false（搂回）
--
-- 在云服务器上执行：
--   docker exec -it pg psql -U root -d aistock -f sql/trend_scores_ma60.sql

-- 新增 ma60_excluded 列（幂等，可重复执行）
ALTER TABLE trend_scores
    ADD COLUMN IF NOT EXISTS ma60_excluded BOOLEAN DEFAULT FALSE;

-- 为查询性能创建部分索引（仅索引 ma60_excluded=false 的行，即未被剔除的行）
CREATE INDEX IF NOT EXISTS idx_trend_scores_ma60_excluded
    ON trend_scores (score_date, score DESC)
    WHERE ma60_excluded IS NULL OR ma60_excluded = false;

COMMENT ON COLUMN trend_scores.ma60_excluded IS '60日均线剔除标记：连续两日收盘价在60日均线下方时为true，从Top列表剔除';
