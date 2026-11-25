-- 033: 现象罕见度（S2 的第一个消费者）
--
-- 背景（2026-11-25）：市场洞见的"现象发现"用 5 条绝对阈值规则判定今天是否值得解释。
-- 实测 2,646 个交易日：4 条可回放的规则里至少一条成立的有 2,047 天（77.4%），
-- 其中 `limit_up >= 50` 单条就在 1,582 天（59.8%）成立 —— 一个六成交易日都成立的条件，
-- 被命名为 `sentiment_extreme`。
--
-- 根因不是阈值调错，是**缺"频率"维度**：绝对阈值无法区分"常见"和"极端"。
--
-- 本表提供分位：当日幅度在**近 750 自然日（不含当日）**中的位置。
-- PIT：窗口严格截止到 T-1，绝不包含当日。
--
-- 【为什么分位按"幅度"算，而不是按"规则是否触发"算】
--   实测：2024-09-24（政策底暴涨）与任意一个四项指数涨 0.8% 的普通普涨日，
--   规则的近 3 年触发频率都是 15%，无法区分。
--   改看幅度后：2024-09-24 的广度分位 0.998，2024-10-09 的跌幅分位 0.992，
--   2024-02-05 的跌停分位 1.000 —— 标注用例全在 0.986 以上，而常态日落在 0.5 附近。
--
-- 【三个幅度指标】
--   breadth_rank  广度（breadth_up_ratio）分位
--   decline_rank  跌幅（1 - breadth_up_ratio）分位，独立计算而非 1-breadth_rank（并列值下不等价）
--   style_rank    风格落差（|沪深300 - 中证1000| 百分点）分位
--   limit_rank    涨跌停压力（max(涨停占比, 跌停占比)）分位
--
-- 【分档效果（实测，阈值 0.90）】
--   77.4% → 23.1%；逐年 10%~44%，与"那年是否真的多事"同向（2024 最高、2025 最低）。

CREATE TABLE IF NOT EXISTS state_rarity_daily (
    trade_date     DATE          NOT NULL,
    breadth_rank   NUMERIC(6,4)  NOT NULL,
    decline_rank   NUMERIC(6,4)  NOT NULL,
    style_rank     NUMERIC(6,4)  NOT NULL,
    limit_rank     NUMERIC(6,4)  NOT NULL,
    -- 窗口内实际样本天数。预热期不足 250 天时 ranks 仍给出，但调用方应视为不可用
    window_days    INTEGER       NOT NULL,
    spec_version   VARCHAR(16)   NOT NULL,
    computed_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (trade_date),
    CONSTRAINT rarity_rank_range CHECK (
        breadth_rank BETWEEN 0 AND 1 AND decline_rank BETWEEN 0 AND 1
        AND style_rank BETWEEN 0 AND 1 AND limit_rank BETWEEN 0 AND 1
    ),
    CONSTRAINT rarity_window_positive CHECK (window_days >= 0)
);

COMMENT ON TABLE state_rarity_daily IS
    '现象罕见度：当日幅度在近 750 自然日（不含当日）中的分位。供市场洞见的"现象闸门"使用。';
COMMENT ON COLUMN state_rarity_daily.breadth_rank IS
    '广度分位。0.90 表示当日上涨家数占比高于过去 3 年 90% 的交易日。';
COMMENT ON COLUMN state_rarity_daily.decline_rank IS
    '跌幅分位，独立计算。1-breadth_rank 在并列值时不等价，不要互相替代。';
COMMENT ON COLUMN state_rarity_daily.limit_rank IS
    '涨跌停压力分位，口径 max(涨停占比, 跌停占比)。涨停潮与跌停潮都算极端。';
COMMENT ON COLUMN state_rarity_daily.window_days IS
    '窗口内实际交易日数。为 0 表示当日之前无可用样本（2016 年初），调用方应视为不可用。';

CREATE INDEX IF NOT EXISTS idx_state_rarity_rank
    ON state_rarity_daily (breadth_rank, limit_rank);
