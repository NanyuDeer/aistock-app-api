-- 019_event_entities.sql — 重大事件时间线 Event Entity 权威表（spec §10.1）
-- event_id 仅 app-api 生成（首写生成、ON CONFLICT 不更新）；canonical_event_key
-- 只做确定性幂等（event_start_date|canonical_title，spec §3.1），不做语义 Merge。

CREATE TABLE IF NOT EXISTS event_entities (
    event_id VARCHAR(64) PRIMARY KEY,
    canonical_event_key VARCHAR(255) NOT NULL UNIQUE,
    title VARCHAR(255) NOT NULL,
    summary TEXT,
    scrape_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    publish_time TIMESTAMPTZ,
    event_start_time TIMESTAMPTZ NOT NULL,
    event_end_time TIMESTAMPTZ,
    time_source VARCHAR(40) NOT NULL DEFAULT 'publish_time_fallback',
    time_confidence NUMERIC(3,2),
    -- event_status 为 display-only 快照（design-debate 定稿）：读时按 now 重算为权威
    event_status VARCHAR(20) NOT NULL,
    source_type VARCHAR(30) NOT NULL,
    -- 承接 agent event_store 旧 id（spec §3.2）：保留来源身份，避免并发双实体
    source_event_id VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Timeline 查询：event_start_date（上海时区表达列）+ status
CREATE INDEX IF NOT EXISTS idx_event_entities_start_status
    ON event_entities ((event_start_time AT TIME ZONE 'Asia/Shanghai')::date, event_status);