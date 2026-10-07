-- 024_trading_calendar.sql
-- A 股交易日历（唯一事实源）。数据来源：Tushare trade_cal（exchange=SSE）。
-- 三所（上交所/深交所/北交所）交易日历一致，故只存 SSE 一份，避免三倍存储与不一致。
-- is_open 全量存（不只存交易日）：使"周末/节假日休市"是表内事实而非代码假设，便于核对审计。
-- 执行方式：人工 psql（本仓 migrations 无启动自动执行器）。

CREATE TABLE IF NOT EXISTS trading_calendar (
    exchange       VARCHAR(10)  NOT NULL,
    cal_date       DATE         NOT NULL,
    is_open        BOOLEAN      NOT NULL,
    pretrade_date  DATE,
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (exchange, cal_date)
);

CREATE INDEX IF NOT EXISTS idx_trading_calendar_open
    ON trading_calendar(exchange, is_open, cal_date);

COMMENT ON TABLE  trading_calendar            IS 'A股交易日历（唯一事实源，Tushare trade_cal/SSE 刷新）';
COMMENT ON COLUMN trading_calendar.is_open     IS 'true=交易 false=休市（含周末与法定节假日）';
COMMENT ON COLUMN trading_calendar.pretrade_date IS '上一个交易日（Tushare 提供，避免自行回溯）';