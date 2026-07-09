-- =============================================================================
-- agent_analysis_reports 表 — Agent 分析报告持久化
--
-- 在云服务器上执行：
--   docker exec -it pg psql -U root -d aistock -f docs/sql/agent_analysis_reports.sql
--
-- 或手动复制粘贴执行
-- =============================================================================

-- Step 1: 创建表（aistock 用户已存在，密码: aistock2026）
CREATE TABLE IF NOT EXISTS agent_analysis_reports (
    id SERIAL PRIMARY KEY,
    report_type VARCHAR(50) NOT NULL,              -- 报告类型: morning, wind_leader, stock, alert, hot_burst, review, iterate
    report_date DATE NOT NULL,                     -- 报告日期: YYYY-MM-DD
    user_id VARCHAR(50),                           -- 用户ID: 公共报告为NULL, 个性化报告必填

    content JSONB NOT NULL,                        -- 完整的分析报告内容（JSONB 支持内部字段查询）

    data_source VARCHAR(100),                      -- 数据源: Tushare, Eastmoney, Tencent 等
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 状态: pending, completed, failed
    generation_time_ms INTEGER,                    -- 生成耗时(毫秒)
    model_version VARCHAR(50),                     -- 模型版本: gpt-4o-mini, gpt-4o 等
    error_message TEXT,                            -- 错误信息: 当 status='failed' 时记录

    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '7 days',

    -- 同一类型+日期+用户只保留最新版本
    UNIQUE(report_type, report_date, user_id)
);

-- Step 2: 创建索引
CREATE INDEX IF NOT EXISTS idx_report_date ON agent_analysis_reports(report_date);
CREATE INDEX IF NOT EXISTS idx_report_type_date ON agent_analysis_reports(report_type, report_date);
CREATE INDEX IF NOT EXISTS idx_user_report ON agent_analysis_reports(user_id, report_date) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_status ON agent_analysis_reports(status);
CREATE INDEX IF NOT EXISTS idx_expires_at ON agent_analysis_reports(expires_at);

-- COALESCE 唯一索引：支持 ON CONFLICT (report_type, report_date, COALESCE(user_id, ''))
-- 解决 PostgreSQL NULL 在 UNIQUE 约束中视为 distinct 的问题
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_report_coalesce
ON agent_analysis_reports (report_type, report_date, COALESCE(user_id, ''));

-- Step 3: 授予 aistock 用户对新表的权限
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_analysis_reports TO aistock;
GRANT USAGE, SELECT ON agent_analysis_reports_id_seq TO aistock;

-- Step 4: 确认创建成功
SELECT 'agent_analysis_reports 表创建完成' AS message;
