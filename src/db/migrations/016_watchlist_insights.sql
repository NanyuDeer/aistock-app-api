-- 016_watchlist_insights.sql
-- 来源文章（去重 + 版本化）
CREATE TABLE IF NOT EXISTS watchlist_insight_sources (
    source_id VARCHAR(128) PRIMARY KEY,          -- 文章 ID（c678683171）或 URL
    source_url VARCHAR(512) NOT NULL,
    article_id VARCHAR(64) NOT NULL,             -- 文章 ID
    trade_date DATE NOT NULL,
    title TEXT NOT NULL,
    keywords JSONB NOT NULL DEFAULT '[]',        -- 标题解析关键词 ["半导体靶材","央企"]
    content TEXT NOT NULL,                       -- 异动原因揭秘正文
    mentioned_symbols JSONB NOT NULL DEFAULT '[]', -- 详情页"文章提及标的" [{symbol,name,change_pct}]
    published_at TIMESTAMPTZ NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    content_hash CHAR(64) NOT NULL,
    parser_version VARCHAR(32) NOT NULL DEFAULT 'mrnxgg-v1',
    UNIQUE (article_id)
);
CREATE INDEX IF NOT EXISTS idx_insight_sources_trade_date ON watchlist_insight_sources (trade_date);

-- 洞察事件（业务唯一键：symbol + trade_date + direction + insight_group）
CREATE TABLE IF NOT EXISTS watchlist_insight_events (
    event_id VARCHAR(128) PRIMARY KEY,
    symbol CHAR(6) NOT NULL,
    stock_name VARCHAR(32) NOT NULL,
    trade_date DATE NOT NULL,
    event_type VARCHAR(32) NOT NULL DEFAULT 'limit_up_radar',
    direction VARCHAR(8) NOT NULL DEFAULT 'up' CHECK (direction IN ('up','down')),
    insight_group VARCHAR(32) NOT NULL DEFAULT 'limit_up_radar',
    source_id VARCHAR(128) REFERENCES watchlist_insight_sources(source_id),
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (symbol, trade_date, direction, insight_group)
);

-- 归因任务（outbox → Redis Stream）
CREATE TABLE IF NOT EXISTS watchlist_insight_jobs (
    job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id VARCHAR(128) REFERENCES watchlist_insight_events(event_id),
    analysis_version VARCHAR(32) NOT NULL DEFAULT 'watchlist-insight-v1',
    status VARCHAR(16) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','published','processing','completed','failed','dead_letter')),
    attempt_count INT NOT NULL DEFAULT 0,
    last_error_code VARCHAR(64),
    stream_message_id VARCHAR(64),
    UNIQUE (event_id, analysis_version)
);
CREATE TABLE IF NOT EXISTS watchlist_insight_outbox (
    outbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID UNIQUE REFERENCES watchlist_insight_jobs(job_id),
    topic VARCHAR(64) NOT NULL DEFAULT 'watchlist-insight.jobs',
    payload JSONB NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published')),
    attempt_count INT NOT NULL DEFAULT 0,
    published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_insight_outbox_pending ON watchlist_insight_outbox (status) WHERE status='pending';

-- 归因结果（Python 回写）
CREATE TABLE IF NOT EXISTS watchlist_insight_results (
    result_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id VARCHAR(128) REFERENCES watchlist_insight_events(event_id),
    analysis_version VARCHAR(32) NOT NULL DEFAULT 'watchlist-insight-v1',
    attribution_status VARCHAR(16) NOT NULL
        CHECK (attribution_status IN ('confirmed','unconfirmed')),
    confidence VARCHAR(16) NOT NULL DEFAULT 'low'
        CHECK (confidence IN ('high','medium','low','unconfirmed')),
    primary_driver JSONB NOT NULL DEFAULT '{}',   -- {label,category,confidence,evidence_quote,source_ids}
    secondary_drivers JSONB NOT NULL DEFAULT '[]',
    display_report JSONB NOT NULL DEFAULT '{}',   -- 双层输出（规范14）
    podcast_brief TEXT NOT NULL DEFAULT '',
    validation_status VARCHAR(16) NOT NULL DEFAULT 'llm' CHECK (validation_status IN ('llm','rule_fallback')),
    model_provider VARCHAR(64) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_id, analysis_version)
);

-- 推送去重
CREATE TABLE IF NOT EXISTS watchlist_insight_push_records (
    id BIGSERIAL PRIMARY KEY,
    event_id VARCHAR(128) NOT NULL,
    openid VARCHAR(128) NOT NULL,
    push_kind VARCHAR(32) NOT NULL DEFAULT 'created',
    channel VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_id, openid, push_kind, channel)
);
