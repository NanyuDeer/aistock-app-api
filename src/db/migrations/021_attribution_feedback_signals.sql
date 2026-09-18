-- 021_attribution_feedback_signals.sql
-- 溯源弱反馈审计表（spec §13.3 溯源自身的反馈回路 / 计划 Phase 7 Task 7.1）。
-- 一行 = 某交易日某「溯源信号单元」的聚合结论；PK=(date, unit_key) 保证同日同单元重复上报
-- 走 upsert 不新增行（幂等）。**本期只落审计、只存建议**：不修改溯源 prompt / 驱动类型判定 /
-- 预判输入，也不真正应用权重（应用层待积累真实样本后单独立项），故表中 mode 字段留痕
-- 当时的运行模式（默认 observe），便于日后区分观测期与（未来的）应用期样本。
-- 执行方式同 016/017/020（该仓无自动迁移器，需人工执行）：
--   psql "$DATABASE_URL" -f src/db/migrations/021_attribution_feedback_signals.sql

CREATE TABLE IF NOT EXISTS attribution_feedback_signals (
    date text NOT NULL,
    unit_key text NOT NULL,
    -- 运行模式留痕：observe（默认，只记录建议）/ off（不运行）；未来 apply 另议
    mode text NOT NULL,
    sample_size integer NOT NULL,
    hit_count integer NOT NULL,
    miss_count integer NOT NULL,
    -- 命中率 = hit/(hit+miss)，保留 4 位；样本为 0 时为 NULL（口径与仓库既有命中率一致）
    hit_rate numeric,
    -- 建议：downgrade | upgrade | hold | insufficient（后两者均为"观望"）
    suggestion text NOT NULL,
    -- 明细留痕：窗口/阈值/样本 source_id 抽样/未匹配计数/条件层统计等（bounded，不塞原始长文）
    detail jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (date, unit_key)
);

-- 按日期读取（GET /api/agent/attribution-feedback/:date）由 PK 前缀 date 覆盖，无需额外索引。
