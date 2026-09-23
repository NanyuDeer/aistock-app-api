-- 022_drop_forecast.sql
-- 2026-09-13：轻量预判（forecast）功能彻底下线——删除 slot 分存列（历史数据一并丢弃）
-- 编号说明：原拟用 019，合并主干时发现 019/020/021 已被占用（019_event_entities / 020_attribution_chains /
-- 021_attribution_feedback_signals），故顺延为 022；语句幂等，任何编号未占用的环境重跑均安全。
-- 注意：保留 is_limit_up（涨停文章命中标记，前端涨停文案仍依赖）
ALTER TABLE stock_trace_events DROP COLUMN IF EXISTS forecast;
ALTER TABLE stock_info_judgements DROP COLUMN IF EXISTS forecast;
