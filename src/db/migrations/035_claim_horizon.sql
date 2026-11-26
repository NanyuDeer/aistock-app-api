-- 035: claim_ledger 补 horizon / horizon_days
--
-- 背景（2026-11-25，S5 spec §3）：
--   031 的 claim_ledger 没有 horizon。后果三条：
--     1. 无法按窗口分组统计命中率 —— short 与 mid 的 claim 混在一起算准确率是错的
--     2. 无法从 claim 推导验证到期日，研判层只能去解析 statement 文本
--     3. 消费方想"只看 20 日的结论"只能 LIKE '%20 日%'
--
--   两列均为可空，存量行不受影响。取值复用 PredictionHorizonType
--   （agent-py `schemas/prediction.py`：short / mid / long），
--   5 交易日 = short，20 交易日 = mid。
--
-- 【为什么这里用白名单 CHECK，而 kind / capability 只用格式 CHECK】
--   kind 是开放的领域枚举（加 causal / flow 是常态），锁死代价刚尝过。
--   horizon 是**闭合代码枚举**：值由 PredictionHorizonType 定死，代码不产出新值，
--   库里也就不该出现新值。白名单能挡住 'medium' / '1m' 这类手写错误。
--   将来若要扩枚举，必须同时改代码和这张表 —— 这正是我们想要的强耦合。

ALTER TABLE claim_ledger ADD COLUMN IF NOT EXISTS horizon      VARCHAR(8);
ALTER TABLE claim_ledger ADD COLUMN IF NOT EXISTS horizon_days SMALLINT;

COMMENT ON COLUMN claim_ledger.horizon IS
    '判断的时间尺度，取值同 PredictionHorizonType（short/mid/long）。5交易日=short，20交易日=mid。';
COMMENT ON COLUMN claim_ledger.horizon_days IS
    '窗口的交易日数。写死数字，不靠"周"反推 —— 4 周遇到节假日就不是 20 个交易日。';

ALTER TABLE claim_ledger DROP CONSTRAINT IF EXISTS claim_horizon_valid;
ALTER TABLE claim_ledger ADD CONSTRAINT claim_horizon_valid CHECK (
    horizon IS NULL OR horizon IN ('short', 'mid', 'long')
);

ALTER TABLE claim_ledger DROP CONSTRAINT IF EXISTS claim_horizon_days_valid;
ALTER TABLE claim_ledger ADD CONSTRAINT claim_horizon_days_valid CHECK (
    horizon_days IS NULL OR (horizon_days > 0 AND horizon_days <= 250)
);

-- 按窗口取结论（"这周所有 20 日的 trend claim"）
CREATE INDEX IF NOT EXISTS idx_claim_horizon
    ON claim_ledger (horizon, horizon_days, as_of DESC);
