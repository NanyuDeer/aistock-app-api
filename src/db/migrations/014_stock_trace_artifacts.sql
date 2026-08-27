CREATE TABLE IF NOT EXISTS stock_trace_artifacts (
    artifact_id UUID PRIMARY KEY,
    event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
    snapshot_id UUID NOT NULL REFERENCES stock_trace_snapshots(snapshot_id),
    result_id UUID NOT NULL REFERENCES stock_trace_results(result_id),
    artifact_version INTEGER NOT NULL,
    analysis_version VARCHAR(32) NOT NULL,
    artifact_json JSONB NOT NULL,
    movement_view_json JSONB NOT NULL,
    validation_report_json JSONB NOT NULL,
    is_effective BOOLEAN NOT NULL DEFAULT TRUE,
    supersedes_artifact_id UUID REFERENCES stock_trace_artifacts(artifact_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE(event_id, snapshot_id, analysis_version),
    UNIQUE(event_id, artifact_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_trace_artifacts_effective
    ON stock_trace_artifacts(event_id) WHERE is_effective;
CREATE INDEX IF NOT EXISTS idx_stock_trace_artifacts_expiry ON stock_trace_artifacts(expires_at);

ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS trigger_reason VARCHAR(64);
ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS artifact_id UUID;
ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS channel VARCHAR(24) NOT NULL DEFAULT 'websocket';
