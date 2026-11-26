-- 031: 智慧大脑 V4 影子归档与只读对比（Task 7）
--
-- 设计约束：
--   * 影子数据进独立新表，绝不复用或写入已删除的 `brain_run_archives`；
--   * 全部行 `is_shadow = TRUE`，并由 CHECK 约束禁止非影子写入；
--   * 读取端只查本表且只查影子行，任一查询不得触达生产表；
--   * `as_of` 为精确时刻（TIMESTAMPTZ），禁止用日期粒度替代。
--
-- 幂等：使用 IF NOT EXISTS，可在部署时重复执行。

CREATE TABLE IF NOT EXISTS brain_v4_runs (
    id BIGSERIAL PRIMARY KEY,
    v4_run_id TEXT NOT NULL UNIQUE,
    legacy_run_id TEXT,
    feature_id TEXT NOT NULL,
    profile TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_code TEXT NOT NULL,
    as_of TIMESTAMPTZ NOT NULL,
    data_cutoff TIMESTAMPTZ NOT NULL,
    snapshot_id TEXT NOT NULL,
    snapshot_sha TEXT NOT NULL,
    parent_run_id TEXT,
    relation TEXT,
    config_version TEXT NOT NULL,
    method_version TEXT NOT NULL,
    model_version TEXT NOT NULL,
    prompt_version TEXT,
    is_shadow BOOLEAN NOT NULL DEFAULT TRUE,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT brain_v4_runs_shadow_only CHECK (is_shadow = TRUE)
);

CREATE INDEX IF NOT EXISTS idx_brain_v4_runs_feature_id
    ON brain_v4_runs (feature_id);
CREATE INDEX IF NOT EXISTS idx_brain_v4_runs_profile
    ON brain_v4_runs (profile);
CREATE INDEX IF NOT EXISTS idx_brain_v4_runs_subject_as_of
    ON brain_v4_runs (subject_type, subject_code, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_brain_v4_runs_snapshot_sha
    ON brain_v4_runs (snapshot_sha);
CREATE INDEX IF NOT EXISTS idx_brain_v4_runs_legacy_run_id
    ON brain_v4_runs (legacy_run_id);

CREATE TABLE IF NOT EXISTS brain_v4_comparisons (
    comparison_id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    profile TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_code TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    snapshot_sha TEXT NOT NULL,
    data_cutoff TIMESTAMPTZ NOT NULL,
    legacy_run_id TEXT NOT NULL,
    v4_run_id TEXT NOT NULL,
    blind_label TEXT,
    reviewer_score DOUBLE PRECISION,
    is_shadow BOOLEAN NOT NULL DEFAULT TRUE,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT brain_v4_comparisons_shadow_only CHECK (is_shadow = TRUE),
    CONSTRAINT brain_v4_comparisons_distinct_runs CHECK (legacy_run_id <> v4_run_id)
);

CREATE INDEX IF NOT EXISTS idx_brain_v4_comparisons_feature_id
    ON brain_v4_comparisons (feature_id);
CREATE INDEX IF NOT EXISTS idx_brain_v4_comparisons_snapshot_sha
    ON brain_v4_comparisons (snapshot_sha);
CREATE INDEX IF NOT EXISTS idx_brain_v4_comparisons_runs
    ON brain_v4_comparisons (legacy_run_id, v4_run_id);

COMMENT ON TABLE brain_v4_runs IS
    '智慧大脑 V4 影子运行归档；is_shadow 恒为 TRUE，读取端只允许查询本表影子行。';
COMMENT ON TABLE brain_v4_comparisons IS
    '旧链 / V4 同快照配对对比（只读）；快照 SHA 一致性由应用层校验。';
