-- =============================================================================
-- trend_scores 表 — 趋势股评分持久化
--
-- 存储 TrendScoreService 计算的趋势股评分结果，支持按 symbol + score_date 唯一约束，
-- 配合 TrendBatchService 批量写入（ON CONFLICT DO UPDATE 实现 upsert）。
--
-- 在云服务器上执行：
--   docker exec -it pg psql -U root -d aistock -f sql/trend_scores.sql
--
-- 或手动复制粘贴执行
-- =============================================================================

-- Step 1: 创建表
CREATE TABLE IF NOT EXISTS trend_scores (
    symbol VARCHAR(20) NOT NULL,                   -- 股票代码
    score_date DATE NOT NULL,                      -- 评分日期: YYYY-MM-DD
    score NUMERIC(5,1) NOT NULL DEFAULT 0,         -- 综合评分: 0.0 ~ 100.0
    label VARCHAR(4) NOT NULL DEFAULT '',           -- 评级标签: S / A / B / C / D
    expected_multiple VARCHAR(20) NOT NULL DEFAULT '', -- 预期倍数: 如 "5-10倍"
    description TEXT,                              -- 维度摘要描述
    ai_conclusion TEXT,                           -- AI 结论（预留）
    dim_scores JSON NOT NULL,                      -- 各维度分数数组: [tech, track, news, fundamental]
    dimensions JSON NOT NULL,                      -- 完整维度详情（含指标、权重、明细）
    raw_data JSON,                                 -- 原始预取数据（可选，体积较大）
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- 更新时间
    UNIQUE(symbol, score_date)
);

-- Step 2: 创建索引
CREATE INDEX IF NOT EXISTS idx_trend_scores_date ON trend_scores(score_date);
CREATE INDEX IF NOT EXISTS idx_trend_scores_symbol ON trend_scores(symbol);

-- Step 3: 授予 aistock 用户对新表的权限
GRANT SELECT, INSERT, UPDATE, DELETE ON trend_scores TO aistock;

-- Step 4: 确认创建成功
SELECT 'trend_scores 表创建完成' AS message;
