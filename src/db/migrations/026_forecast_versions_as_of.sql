-- 026: 盈利预测版本增加 as_of（数据可得时刻），支持 point-in-time 查询
--
-- 背景（2026-11-10 核查）：
--   earnings_forecast_versions.version_date 由 shanghaiDateStr() 生成，是「快照日」，
--   因此 `WHERE version_date <= 查询日` 已能实现日期粒度的 point-in-time，无需改主键。
--
--   但 Tushare report_rc 每日更新两次（21:15 / 次日 9:15），而 ON CONFLICT
--   (symbol, version_date) 会让后一次覆盖前一次，丢失日内版本。对于
--   「事件发生在 10:00，需要 9:00 时刻的市场预期」这类场景，日期粒度不够。
--
-- 本次改动：
--   只加 as_of 精确时刻 + 索引，不改主键、不改已有列，对现有消费方零影响。
--   回填用 created_at（写库时刻）。它晚于数据真实可得时刻，作为 point-in-time
--   基准是保守的——只会更严格，不会泄漏未来信息。

ALTER TABLE earnings_forecast_versions
    ADD COLUMN IF NOT EXISTS as_of TIMESTAMPTZ;

UPDATE earnings_forecast_versions
SET as_of = created_at
WHERE as_of IS NULL;

ALTER TABLE earnings_forecast_versions
    ALTER COLUMN as_of SET DEFAULT NOW();

COMMENT ON COLUMN earnings_forecast_versions.as_of IS
    '数据可得时刻。point-in-time 查询一律按 as_of <= 查询时点 过滤，避免泄漏事后信息。';

CREATE INDEX IF NOT EXISTS idx_earnings_forecast_versions_as_of
    ON earnings_forecast_versions (symbol, as_of DESC);
