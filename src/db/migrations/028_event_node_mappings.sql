-- 028: 事件 → 机制图节点映射缓存
--
-- 为什么需要这张表（不只是性能）：
--   向量召回不可复现。同一个事件今天匹配「半导体」，三个月后回放可能匹配
--   「消费电子」——embedding 服务可能失败、模型可能换、结果会漂移。
--   2026-08-14 曾因此被迫「回放模式短路 embedding」，代价是回放拿不到映射。
--
--   落库后：向量只算一次，回放读缓存，既保留召回广度又可事后复现。
--
-- confirmed 的含义：
--   向量召回是宽松的（阈值 0.6、top5），必然有假阳性。confirmed=true 表示
--   该候选通过了图谱路径校验。未确认的候选**保留但不参与结论**，
--   只在研究员版证据矩阵展示——冗余不丢，噪音不污染。

CREATE TABLE IF NOT EXISTS event_node_mappings (
    event_id    VARCHAR(64)  NOT NULL,
    node_id     VARCHAR(32)  NOT NULL,
    similarity  NUMERIC(5,4) NOT NULL,
    confirmed   BOOLEAN      NOT NULL DEFAULT FALSE,
    reason      TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, node_id)
);

COMMENT ON COLUMN event_node_mappings.confirmed IS
    '是否通过图谱路径确认。false 的候选保留但不参与结论，仅用于证据矩阵。';
COMMENT ON COLUMN event_node_mappings.similarity IS
    '向量余弦相似度，范围 [0,1]。写入前已夹取，越界直接报错。';

CREATE INDEX IF NOT EXISTS idx_event_node_mappings_event
    ON event_node_mappings (event_id);
