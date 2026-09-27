-- 023_event_entities_impact_sectors.sql — 重大事件时间线影响板块列（时间线影响板块改造方案）
--
-- impact_sectors：时间线展示层面的「事件关联/预期影响板块」（JSONB 字符串数组）。
-- - 语义：与 Event Conduction 的 impact_industries/impact_chain **不同**，不替代传导结果。
-- - 写入方：agent-py 独立 cron 作业（impact_sectors_precompute）对 calendar 未来事件做
--   行业向量（KG）语义匹配 Top3 写回；已有事件传导结果的事件由时间线读取 chain 优先展示，
--   本列仅兜底（优先级：conduction chain Top3 > impact_sectors 列 > 空）。
-- - 允许为空（[]）：宏观/利率类未来事件（如美联储议息会议）匹配不到可靠行业 → 空不展示，
--   绝不强行生成。不新增第二张"事件板块表"。
-- - 历史 Event Entity 无该字段时通过本迁移默认 '[]' 兼容。

ALTER TABLE event_entities
    ADD COLUMN IF NOT EXISTS impact_sectors JSONB NOT NULL DEFAULT '[]'::jsonb;
