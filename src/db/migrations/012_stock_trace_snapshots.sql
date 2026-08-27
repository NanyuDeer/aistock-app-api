CREATE TABLE IF NOT EXISTS stock_trace_snapshots (
    snapshot_id UUID PRIMARY KEY,
    event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
    trigger_revision INTEGER NOT NULL,
    snapshot_stage VARCHAR(12) NOT NULL CHECK (snapshot_stage IN ('initial', 'enriched', 'corrected')),
    source_revision_hash CHAR(64) NOT NULL,
    trigger_event_json JSONB NOT NULL,
    missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
    data_readiness JSONB NOT NULL,
    collector_versions JSONB NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    supersedes_snapshot_id UUID,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (event_id, trigger_revision, snapshot_stage, source_revision_hash)
);

CREATE INDEX IF NOT EXISTS idx_stock_trace_snapshots_event
    ON stock_trace_snapshots(event_id, trigger_revision, captured_at DESC);

CREATE TABLE IF NOT EXISTS stock_trace_source_records (
    source_pk UUID PRIMARY KEY,
    snapshot_id UUID NOT NULL REFERENCES stock_trace_snapshots(snapshot_id),
    source_id VARCHAR(128) NOT NULL,
    kind VARCHAR(24) NOT NULL,
    provider VARCHAR(64) NOT NULL,
    source_level VARCHAR(16) NOT NULL CHECK (source_level IN ('A', 'B', 'C', 'D')),
    title VARCHAR(512) NOT NULL,
    content_excerpt TEXT NOT NULL,
    canonical_url TEXT,
    source_ref VARCHAR(256),
    symbol CHAR(6),
    window_start TIMESTAMPTZ,
    window_end TIMESTAMPTZ,
    occurred_at TIMESTAMPTZ,
    captured_at TIMESTAMPTZ NOT NULL,
    freshness_seconds INTEGER CHECK (freshness_seconds IS NULL OR freshness_seconds >= 0),
    payload JSONB NOT NULL,
    content_hash CHAR(64) NOT NULL,
    object_key VARCHAR(512),
    object_etag VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (snapshot_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_trace_sources_snapshot_level
    ON stock_trace_source_records(snapshot_id, source_level);
CREATE INDEX IF NOT EXISTS idx_stock_trace_sources_hash
    ON stock_trace_source_records(content_hash);
