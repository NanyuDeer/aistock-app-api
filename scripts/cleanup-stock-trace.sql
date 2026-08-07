-- scripts/cleanup-stock-trace.sql
-- 用途：清理旧 stock_trace 因果链数据（保留表结构）
-- 执行时机：切换窗口人工执行 —— 先 pg_dump 备份，再执行本脚本。
--
-- 注意事项：
--   1. 本脚本仅 TRUNCATE 清空数据，不删除任何表结构；
--   2. 执行前请确认旧 stock_trace 已停写：Node 侧 STOCK_TRACE_TRIGGER_ENABLED 未开启
--      （默认停用）、Python 侧 stock_trace_consumer_enabled=false，否则清理后数据会再次写入；
--   3. 各表之间存在外键引用（见 011-015 迁移），全部表放入同一条 TRUNCATE 语句
--      （按先子表后父表排列），避免 FK 阻塞；
--   4. 若某张表在目标环境不存在（未执行过对应迁移），TRUNCATE 会报错，请先核对迁移版本。
--
-- 依赖迁移：011_stock_trace_events.sql、012_stock_trace_snapshots.sql、
--           013_stock_trace_results.sql、014_stock_trace_artifacts.sql、
--           015_stock_trace_jobs.sql

TRUNCATE stock_trace_chain_nodes,
         stock_trace_chains,
         stock_trace_candidates,
         stock_trace_results,
         stock_trace_artifacts,
         stock_trace_outbox,
         stock_trace_jobs,
         stock_trace_source_records,
         stock_trace_snapshots,
         stock_trace_push_records,
         stock_trace_user_events,
         stock_trace_signals,
         stock_trace_event_revisions,
         stock_trace_events;
