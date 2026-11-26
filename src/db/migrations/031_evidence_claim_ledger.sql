-- 031: 证据账本与论点账本
--
-- 依据：docs/brain_design/智慧大脑-架构与研判契约.md（v0.6）§3 研判契约
-- 契约稿：docs/superpowers/specs/2026-11-24-evidence-claim-ledger-contract.md
--
-- 范围：只建市场洞见 + 节奏大师两条线共用的"事实层"。
--       结论层（judgment / verification / method_prior）属智慧大脑 P0，不在此建。
--
-- 三层分工：
--   evidence（事实）→ claim（论点）→ judgment（研判，组长建）
--   事实层归我们，结论层归编排，中间用 claim_id / evidence_ids 对接。

-- ---------------------------------------------------------------------------
-- 证据账本
-- ---------------------------------------------------------------------------
-- 设计稿 §4.1「按 evidence_id append，去重，不覆盖」→ 主键 + ON CONFLICT DO NOTHING
--
-- published_at 可为空的原因：
--   设计稿要求「provenance 追溯不到 published_at 的不得进入高置信证据」。
--   允许入库但不得升置信，比拒绝入库更利于暴露数据缺口——
--   拒绝入库会让"今天没有证据"和"今天证据缺时间"混成同一件事。
CREATE TABLE IF NOT EXISTS evidence_ledger (
    evidence_id    VARCHAR(64)   NOT NULL,          -- ev_{date}_{seq}
    kind           VARCHAR(32)   NOT NULL,          -- market/event/entity/fundamental/causal/flow/user_context
    subject_type   VARCHAR(16)   NOT NULL,          -- stock / sector / market / event
    subject_code   VARCHAR(32)   NOT NULL,
    statement      TEXT          NOT NULL,          -- 事实陈述（设计稿原字段名 claim，改名避免与 claim_id 混淆）
    source         VARCHAR(64)   NOT NULL,          -- tushare / cls / 见闻 / graph
    source_type    VARCHAR(16)   NOT NULL,          -- data / news / research / social
    published_at   TIMESTAMPTZ,                     -- 信息可得时间；空表示源无时间，不得进高置信
    fetched_at     TIMESTAMPTZ   NOT NULL,          -- 我们抓到的时刻
    quality        VARCHAR(16)   NOT NULL DEFAULT 'ok',   -- ok / partial / failed
    weight         NUMERIC(4,3),                    -- 0~1；无可靠信号时留空，不编数
    payload        JSONB,                           -- 原始结构，供追溯
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (evidence_id),
    CONSTRAINT ev_published_before_fetched
        CHECK (published_at IS NULL OR published_at <= fetched_at),
    -- 格式约束，非白名单：加新 kind 不用改表，但挡住空串/空格/大写/中文
    CONSTRAINT ev_kind_format
        CHECK (kind ~ '^[a-z][a-z0-9_]{1,31}$')
);

COMMENT ON TABLE evidence_ledger IS
    '证据账本（事实层）。只 append 不覆盖；同一 evidence_id 重复写入忽略。';
COMMENT ON COLUMN evidence_ledger.published_at IS
    '信息可得时间 = 市场什么时候能知道这件事。为空不得进入高置信证据池。';
COMMENT ON COLUMN evidence_ledger.fetched_at IS
    '系统抓到该证据的时刻。与 published_at 一起构成双时间，支撑 point-in-time 查询。';
COMMENT ON COLUMN evidence_ledger.statement IS
    '事实陈述，如「近 5 日北向净流入 12.3 亿」。设计稿中该字段名为 claim，因与 claim_id 语义冲突而改名。';
COMMENT ON CONSTRAINT ev_published_before_fetched ON evidence_ledger IS
    '抓取时间早于发布时间属不可能数据，直接拒绝入库。';

CREATE INDEX IF NOT EXISTS idx_evidence_subject
    ON evidence_ledger (subject_type, subject_code, published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_evidence_kind_time
    ON evidence_ledger (kind, published_at DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- 论点账本
-- ---------------------------------------------------------------------------
-- 设计稿 §4.1「按 claim_id append；invalidated_by 只追加」。
-- statement 不可变：论点被推翻时往 invalidated_by 追加证据，不改原文——
-- 否则历史无法回放，"当时为什么这么判"永远说不清。
CREATE TABLE IF NOT EXISTS claim_ledger (
    claim_id       VARCHAR(80)   NOT NULL,          -- cl_{date}_{subject}_{kind}_{seq}
    subject_type   VARCHAR(16)   NOT NULL,
    subject_code   VARCHAR(32)   NOT NULL,
    -- kind = 判断的性质；capability = 能力线。两者正交，不要混用（2026-11-25 组长裁决）
    kind           VARCHAR(32)   NOT NULL,          -- trend/wind/event/fundamental/causal/risk
    capability     VARCHAR(16)   NOT NULL,          -- insight/rhythm/trend/wind/event/fundamental
    statement      TEXT          NOT NULL,
    evidence_ids   TEXT[]        NOT NULL DEFAULT '{}',
    confidence     NUMERIC(4,3)  NOT NULL,          -- 0~1；须经确定性规则钳制，不是模型自评
    invalidated_by TEXT[]        NOT NULL DEFAULT '{}',
    produced_by    VARCHAR(64)   NOT NULL,          -- insight_research@v1.0
    as_of          TIMESTAMPTZ   NOT NULL,          -- 该论点基于哪个信息截面
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (claim_id),
    CONSTRAINT claim_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
    -- 格式约束，非白名单：加新 kind 不用改表
    CONSTRAINT claim_kind_format       CHECK (kind       ~ '^[a-z][a-z0-9_]{1,31}$'),
    CONSTRAINT claim_capability_format CHECK (capability ~ '^[a-z][a-z0-9_]{1,15}$')
);

COMMENT ON TABLE claim_ledger IS
    '论点账本（事实层之上）。kind=判断性质，capability=能力线，两者正交。';
COMMENT ON COLUMN claim_ledger.kind IS
    '判断的性质：trend/wind/event/fundamental/causal/risk。不放能力线名。';
COMMENT ON COLUMN claim_ledger.capability IS
    '能力线：insight/rhythm/trend/wind/event/fundamental。用于按能力线统计与回测。';
COMMENT ON COLUMN claim_ledger.confidence IS
    '0~1，须经确定性规则（如三族投票）钳制。禁止直接写 LLM 自评原值。';
COMMENT ON COLUMN claim_ledger.as_of IS
    '信息截面时间。回测与反事实的前提：只认该时刻之前可得知的证据。';
COMMENT ON COLUMN claim_ledger.invalidated_by IS
    '使该论点失效的证据 ID，只追加不覆盖。同一逻辑的新版本用新 claim_id，不改旧行。';

CREATE INDEX IF NOT EXISTS idx_claim_subject
    ON claim_ledger (subject_type, subject_code, kind, as_of DESC);
-- 按能力线取论点（"洞见线这个月产了多少条"、"节奏线命中率"）
CREATE INDEX IF NOT EXISTS idx_claim_capability
    ON claim_ledger (capability, as_of DESC);
-- 反查：某条证据支撑了哪些论点
CREATE INDEX IF NOT EXISTS idx_claim_evidence
    ON claim_ledger USING GIN (evidence_ids);
