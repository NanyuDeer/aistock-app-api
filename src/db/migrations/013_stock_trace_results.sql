CREATE TABLE IF NOT EXISTS stock_trace_results (
    result_id UUID PRIMARY KEY,
    event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
    snapshot_id UUID NOT NULL REFERENCES stock_trace_snapshots(snapshot_id),
    analysis_version VARCHAR(32) NOT NULL,
    model_provider VARCHAR(32) NOT NULL,
    model_version VARCHAR(128) NOT NULL,
    processing_status VARCHAR(16) NOT NULL,
    attribution_status VARCHAR(16) NOT NULL,
    primary_chain_id UUID,
    alternative_chain_id UUID,
    confidence_score NUMERIC(4,3),
    confidence_level VARCHAR(8),
    confidence_config_version VARCHAR(32) NOT NULL,
    contradictions JSONB NOT NULL DEFAULT '[]'::jsonb,
    unresolved_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
    missing_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
    suggested_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    validation_status VARCHAR(16) NOT NULL,
    validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, snapshot_id, analysis_version)
);

CREATE TABLE IF NOT EXISTS stock_trace_candidates (
    candidate_id UUID PRIMARY KEY,
    result_id UUID NOT NULL REFERENCES stock_trace_results(result_id),
    layer VARCHAR(12) NOT NULL,
    rank SMALLINT NOT NULL,
    status VARCHAR(16) NOT NULL,
    verdict TEXT NOT NULL,
    supporting_evidence_ids JSONB NOT NULL,
    counter_evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(result_id, layer, rank)
);

CREATE TABLE IF NOT EXISTS stock_trace_chains (
    chain_id UUID PRIMARY KEY,
    result_id UUID NOT NULL REFERENCES stock_trace_results(result_id),
    candidate_id UUID NOT NULL REFERENCES stock_trace_candidates(candidate_id),
    chain_role VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_trace_chain_nodes (
    node_id UUID PRIMARY KEY,
    chain_id UUID NOT NULL REFERENCES stock_trace_chains(chain_id),
    stage VARCHAR(24) NOT NULL,
    stage_order SMALLINT NOT NULL,
    epistemic_type VARCHAR(12) NOT NULL,
    status VARCHAR(20) NOT NULL,
    claim TEXT NOT NULL,
    evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    counter_evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chain_id, stage),
    UNIQUE(chain_id, stage_order)
);

CREATE INDEX IF NOT EXISTS idx_stock_trace_results_event ON stock_trace_results(event_id, created_at DESC);
