-- 025_event_impact_vitality.sql — 事件影响存活度（Impact Vitality）
--
-- 目的：判断已推送重大消息的影响是否仍在传递（如 10/1 摩根新闻影响至今仍在）。
-- 一期口径：**只算不干扰** —— 只落表 + 内部只读接口，不接前端、不 gate 推送。
--
-- 为什么必须自持久化 chain 快照：
--   event_conduction 报告的 TTL 为 7 天（internal.ts getReportTtlDays），每日 03:00
--   ReportCleanupCron 执行 DELETE FROM agent_analysis_reports WHERE expires_at < NOW()，
--   chain 随报告被物理删除 → 7 天后再算存活度就没有行业可观测。故 D 日首次计算时
--   把 chain Top3 行业落库（event_impact_vitality_baseline），此后只读快照。
--
-- 表 1 baseline：长期事件池 + chain 快照（event_id 首次落库后不再覆盖）
-- 表 2 daily  ：每事件每日存活度评分（兼作长期事件池查询源）
--
-- 执行方式（本仓无自动迁移器，需人工 psql 执行）：
--   psql "$DATABASE_URL" -f src/db/migrations/025_event_impact_vitality.sql
-- 另：服务启动时 ensureVitalitySchema() 幂等建表（本地/无迁移器环境兜底）。

CREATE TABLE IF NOT EXISTS event_impact_vitality_baseline (
    event_id    VARCHAR(64) PRIMARY KEY,
    event_type  VARCHAR(40) NOT NULL DEFAULT 'unknown',
    event_date  DATE NOT NULL,
    -- chain Top3 行业节点快照（[{industry, direction, impactStrength, reason}]），
    -- 一次写入不再更新：chain 是 D 日首次计算的权威观测口径
    chain       JSONB NOT NULL,
    snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vitality_baseline_event_date
    ON event_impact_vitality_baseline (event_date);

CREATE TABLE IF NOT EXISTS event_impact_vitality_daily (
    event_id            VARCHAR(64) NOT NULL,
    stat_date           DATE NOT NULL,
    -- 0.000~1.000 的存活度；no_observation（行业映射不到板块）为 NULL
    vitality            NUMERIC(4, 3),
    impact_status       VARCHAR(20) NOT NULL,  -- alive / fading / expired / no_observation
    -- 观测明细：[{industry, board_code, obs_days, aligned_days, weak_days, avg_excess}]
    observed_industries JSONB NOT NULL DEFAULT '[]'::jsonb,
    reinforce_count     INTEGER NOT NULL DEFAULT 0,
    benchmark           VARCHAR(40),
    window_start        DATE,
    window_end          DATE,
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_vitality_daily_stat_date
    ON event_impact_vitality_daily (stat_date);
