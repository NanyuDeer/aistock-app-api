-- 036: claim 验证闭环
--
-- 背景（2026-11-26）：账本里的 claim 只写不查。本表记录每条 claim 到期后的实际结果。
--
-- 【为什么验证结果不写回 claim_ledger】
--   账本 append-only 是它的立身之本 —— 一条判断写下之后就不能改，
--   否则"当时说了什么"再也无法复原。验证结果是**另一个事实**，放独立表。
--
-- 【为什么要把声称的 p25/p50/p75 抄一份】
--   forward_return_dist 会随 spec_version 重算而变。半年后回头算命中率时，
--   如果现取 P25/P75，等于拿新版本的结论去评旧版本的判断 —— 那不是验证，是改题。

ALTER TABLE claim_ledger ADD COLUMN IF NOT EXISTS source_ref VARCHAR(80);

COMMENT ON COLUMN claim_ledger.source_ref IS
    '该 claim 的出处，格式 frd:{dim}|{bucket}|{horizon}|{segment}|{caliber}|{spec_version}。'
    'null 表示来源不可追溯（本闭环跳过）。';

CREATE TABLE IF NOT EXISTS claim_verification (
    claim_id        VARCHAR(80)   PRIMARY KEY,
    due_date        DATE          NOT NULL,
    actual_ret      NUMERIC(10,6) NOT NULL,
    is_up           BOOLEAN       NOT NULL,
    in_iqr          BOOLEAN       NOT NULL,
    claimed_p25     NUMERIC(10,6) NOT NULL,
    claimed_p50     NUMERIC(10,6) NOT NULL,
    claimed_p75     NUMERIC(10,6) NOT NULL,
    claimed_prob_up NUMERIC(6,4)  NOT NULL,
    horizon_days    SMALLINT      NOT NULL,
    spec_version    VARCHAR(16)   NOT NULL,
    verified_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT cv_p25_le_p75 CHECK (claimed_p25 <= claimed_p75),
    CONSTRAINT cv_horizon_positive CHECK (horizon_days > 0),
    CONSTRAINT cv_prob_range CHECK (claimed_prob_up >= 0 AND claimed_prob_up <= 1)
);

COMMENT ON TABLE claim_verification IS
    'claim 到期后的实际结果。一条 claim 只了结一次（PK 保证幂等）。';

CREATE INDEX IF NOT EXISTS idx_cv_due ON claim_verification (due_date DESC, claim_id);
