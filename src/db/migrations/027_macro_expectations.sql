-- 027: 宏观预期快照表
--
-- 背景（2026-11-12 实测）：
--   华尔街见闻 macrodatas 的 forecast 字段会过期清空。
--   11-10 查 11-09 的「10月CPI」有 forecast=0.8；
--   11-12 查 09-09 的「8月CPI」forecast 已为空，只剩前值与实际值。
--
--   因此实时拉历史不可行，必须每日落库，且要在公布前抓。
--   漏跑一天的预期永久丢失——这是本表存在的全部理由。
--
-- 主键含 as_of 的原因：
--   每日抓「今日 + 未来 7 天」，同一指标会被抓 7 次。
--   保留每次快照可以：
--     1) point-in-time 查询（as_of <= 事件时刻 ORDER BY as_of DESC）
--     2) 检测预期修订（相邻快照 forecast 不同 = 上修/下修）
--   表规模：约 70 条/日 × 365 ≈ 年增 2.5 万行，不构成负担。

CREATE TABLE IF NOT EXISTS macro_expectations (
    indicator   VARCHAR(64)  NOT NULL,
    period      VARCHAR(16)  NOT NULL,
    country     VARCHAR(16)  NOT NULL,
    title_raw   TEXT         NOT NULL,
    unit        VARCHAR(16),
    previous    NUMERIC(18,4),
    forecast    NUMERIC(18,4),
    actual      NUMERIC(18,4),
    importance  SMALLINT,
    publish_at  TIMESTAMPTZ,
    as_of       TIMESTAMPTZ  NOT NULL,
    PRIMARY KEY (indicator, period, as_of)
);

COMMENT ON COLUMN macro_expectations.indicator IS
    '归一化指标键，如 CN_CPI_YOY。归一化失败的条目不落库，宁可缺不造错键。';
COMMENT ON COLUMN macro_expectations.as_of IS
    '本条快照的抓取时刻。point-in-time 查询一律按 as_of <= 查询时点 过滤。';
COMMENT ON COLUMN macro_expectations.forecast IS
    '市场预期。可能为空（该指标无一致预期）；为空时不得计算预期差。';

CREATE INDEX IF NOT EXISTS idx_macro_exp_point_in_time
    ON macro_expectations (indicator, as_of DESC);

CREATE INDEX IF NOT EXISTS idx_macro_exp_country_period
    ON macro_expectations (country, period);
