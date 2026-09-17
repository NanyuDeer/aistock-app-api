-- 019_drop_forecast.sql
-- 2026-09-13：轻量预判（forecast）功能彻底下线——删除 slot 分存列（历史数据一并丢弃）
-- 注意：保留 is_limit_up（涨停文章命中标记，前端涨停文案仍依赖）
ALTER TABLE stock_trace_events DROP COLUMN IF EXISTS forecast;
ALTER TABLE stock_info_judgements DROP COLUMN IF EXISTS forecast;