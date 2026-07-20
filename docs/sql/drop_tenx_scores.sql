-- 十倍股模块下线：删除 tenx_scores 表
--
-- 前置条件：已删除 tenxScoreController.ts、TenxBatchService.ts、tenx_tools.py，
--          并移除 internal.ts / index.ts 中的 tenx 路由。
-- 执行前请确认前端已无页面调用 /api/cn/stocks/*/tenx-score/* 接口。
--
-- 在云服务器上执行：
--   docker exec -it pg psql -U root -d aistock -f docs/sql/drop_tenx_scores.sql

DROP TABLE IF EXISTS tenx_scores CASCADE;

COMMENT ON DROP TABLE tenx_scores IS '十倍股独立评分模块已下线，趋势股评分（trend_scores）已合并相关逻辑';
