ALTER TABLE stocks ADD COLUMN IF NOT EXISTS list_date VARCHAR(8) DEFAULT '';

CREATE TABLE IF NOT EXISTS stock_trace_events (
    event_id VARCHAR(128) PRIMARY KEY,
    symbol VARCHAR(6) NOT NULL,
    stock_name VARCHAR(80) NOT NULL,
    trading_date DATE NOT NULL,
    direction VARCHAR(8) NOT NULL CHECK (direction IN ('up', 'down')),
    first_triggered_at TIMESTAMPTZ NOT NULL,
    window_start_at TIMESTAMPTZ NOT NULL,
    window_end_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    recovery_started_at TIMESTAMPTZ,
    event_status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (event_status IN ('active', 'closed', 'superseded')),
    current_trigger_revision INTEGER NOT NULL DEFAULT 1,
    current_severity VARCHAR(16) NOT NULL,
    related_event_id VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_trace_events_symbol_status ON stock_trace_events(symbol, event_status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS stock_trace_event_revisions (
    event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
    trigger_revision INTEGER NOT NULL,
    triggered_at TIMESTAMPTZ NOT NULL,
    rule_version VARCHAR(32) NOT NULL,
    trigger_type VARCHAR(32) NOT NULL,
    threshold_value NUMERIC(10,4) NOT NULL,
    actual_value NUMERIC(10,4) NOT NULL,
    latest_price NUMERIC(16,4) NOT NULL,
    previous_close NUMERIC(16,4) NOT NULL,
    severity VARCHAR(16) NOT NULL,
    revision_reason VARCHAR(32) NOT NULL,
    data_quality VARCHAR(16) NOT NULL DEFAULT 'valid',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, trigger_revision)
);

CREATE TABLE IF NOT EXISTS stock_trace_signals (
    id UUID PRIMARY KEY,
    event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
    trigger_revision INTEGER NOT NULL,
    signal_type VARCHAR(32) NOT NULL,
    direction VARCHAR(8) NOT NULL,
    threshold_value NUMERIC(10,4) NOT NULL,
    actual_value NUMERIC(10,4) NOT NULL,
    source VARCHAR(32) NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    raw_fact JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_trace_user_events (
    id UUID PRIMARY KEY,
    event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
    openid VARCHAR(128) NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (event_id, openid)
);

CREATE TABLE IF NOT EXISTS stock_trace_push_records (
    id UUID PRIMARY KEY,
    event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
    openid VARCHAR(128) NOT NULL,
    push_kind VARCHAR(32) NOT NULL,
    status VARCHAR(16) NOT NULL,
    payload JSONB NOT NULL,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (event_id, openid, push_kind)
);
