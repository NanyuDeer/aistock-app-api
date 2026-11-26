-- 034: forward_return_dist 补 prob_up 的置信区间
--
-- 背景（2026-11-25）：设计文档 §14.1 定案 —— `subject.type='market'` 的 judgment，
-- 其 confidence 必须落在 S3 的 `prob_up` 95% CI 内；没有 ok 基线时 confidence 上限 0.5。
--
-- 但 032 只存了**中位数**的 CI（ci_low/ci_high）。中位数的区间不能拿来约束
-- "上涨概率"—— 两者是不同的统计量，一个回答"典型的涨幅是多少"，
-- 一个回答"涨的频率有多高"。用错等于锚错。
--
-- 这两列与 ci_low/ci_high 由**同一次** bootstrap 重抽样同时算出，不额外增加计算成本。

ALTER TABLE forward_return_dist ADD COLUMN IF NOT EXISTS prob_up_low  NUMERIC(6,4);
ALTER TABLE forward_return_dist ADD COLUMN IF NOT EXISTS prob_up_high NUMERIC(6,4);

COMMENT ON COLUMN forward_return_dist.prob_up_low IS
    'prob_up 的 block bootstrap 2.5% 分位。judgment.confidence 的下界锚（§14.1）。';
COMMENT ON COLUMN forward_return_dist.prob_up_high IS
    'prob_up 的 block bootstrap 97.5% 分位。judgment.confidence 的上界锚（§14.1）。';
COMMENT ON COLUMN forward_return_dist.ci_low IS
    '中位数的 block bootstrap 2.5% 分位。**不要拿它当 prob_up 的区间**，两者是不同的统计量。';

ALTER TABLE forward_return_dist DROP CONSTRAINT IF EXISTS frd_prob_ci_range;
ALTER TABLE forward_return_dist ADD CONSTRAINT frd_prob_ci_range CHECK (
    (prob_up_low IS NULL OR (prob_up_low >= 0 AND prob_up_low <= 1)) AND
    (prob_up_high IS NULL OR (prob_up_high >= 0 AND prob_up_high <= 1)) AND
    (prob_up_low IS NULL OR prob_up_high IS NULL OR prob_up_low <= prob_up_high)
);
