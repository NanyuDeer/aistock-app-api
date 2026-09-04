-- 018_stock_trace_forecast.sql
-- 阶段 2：自选股洞察定时轻量预判——stock_trace 事件加 forecast（slot 分存）+ is_limit_up（涨停文章命中标记）
-- 幂等：存量表补列；全新库建表已在代码 ensureSchema 内包含（StockTraceService.ts createSchema）

-- stock_trace_events：轻量预判 slot 落库（{midday?: {...}, close?: {...}}），slot 级 upsert 由内部端点保证
ALTER TABLE stock_trace_events ADD COLUMN IF NOT EXISTS is_limit_up BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE stock_trace_events ADD COLUMN IF NOT EXISTS forecast JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_stock_trace_events_trade_date ON stock_trace_events (trading_date, event_status);

-- stock_info_judgements：仅重大资讯（无 stock_trace 事件）股票的轻量预判 slot 落库
ALTER TABLE stock_info_judgements ADD COLUMN IF NOT EXISTS forecast JSONB NOT NULL DEFAULT '{}';
