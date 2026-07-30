CREATE TABLE IF NOT EXISTS stock_trace_jobs (
    job_id UUID PRIMARY KEY,
    event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
    trigger_revision INTEGER NOT NULL,
    analysis_version VARCHAR(32) NOT NULL,
    job_kind VARCHAR(24) NOT NULL DEFAULT 'analyze',
    status VARCHAR(16) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'published', 'processing', 'completed', 'failed', 'dead_letter')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error_code VARCHAR(64),
    stream_message_id VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (event_id, trigger_revision, analysis_version, job_kind)
);

CREATE TABLE IF NOT EXISTS stock_trace_outbox (
    outbox_id UUID PRIMARY KEY,
    job_id UUID NOT NULL UNIQUE REFERENCES stock_trace_jobs(job_id),
    topic VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error_code VARCHAR(64),
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_trace_jobs_status_created
    ON stock_trace_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_trace_outbox_pending
    ON stock_trace_outbox(status, created_at)
    WHERE status = 'pending';
