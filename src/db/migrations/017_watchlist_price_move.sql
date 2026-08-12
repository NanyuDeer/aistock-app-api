-- 017_watchlist_price_move.sql
-- 午盘/尾盘价格打点快照（业务唯一键：symbol + trade_date + snapshot_type）
CREATE TABLE IF NOT EXISTS watchlist_price_snapshots (
    id BIGSERIAL PRIMARY KEY,
    symbol CHAR(6) NOT NULL,
    trade_date DATE NOT NULL,
    snapshot_type VARCHAR(16) NOT NULL CHECK (snapshot_type IN ('midday','close')),
    snapshot_time TIMESTAMPTZ NOT NULL,
    open_price NUMERIC(10,2) NOT NULL,
    latest_price NUMERIC(10,2) NOT NULL,
    move_bps INT NOT NULL,
    direction VARCHAR(8) NOT NULL CHECK (direction IN ('up','down')),
    price_source VARCHAR(32) NOT NULL DEFAULT 'realtime_snapshot'
        CHECK (price_source IN ('realtime_snapshot','kline_backfill')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (symbol, trade_date, snapshot_type)
);
CREATE INDEX IF NOT EXISTS idx_price_snapshots_trade_date ON watchlist_price_snapshots (trade_date);

-- 证据包（冻结 + 补抓版本化：frozen_seq 递增，同一事件多次冻结）
CREATE TABLE IF NOT EXISTS watchlist_evidence_packages (
    id BIGSERIAL PRIMARY KEY,
    event_id VARCHAR(128) REFERENCES watchlist_insight_events(event_id),
    frozen_seq INT NOT NULL DEFAULT 1,
    trigger_at TIMESTAMPTZ NOT NULL,
    evidence JSONB NOT NULL DEFAULT '[]',
    coverage JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_id, frozen_seq)
);
CREATE INDEX IF NOT EXISTS idx_evidence_packages_event ON watchlist_evidence_packages (event_id);