-- 024_stock_trace_job_error_detail.sql — 归因 job 失败明细存储（可观测性改造 A 的存储侧）
--
-- 动机（2026-09-30 海正生材 688203 事故）：归因 job 三次尝试后进入 dead_letter，
-- 真实异常未落库（只有笼统错误码 last_error_code），事后完全无法定位根因。
-- 本列承载 Python Agent 上报的异常明细（异常类名 + 消息，最多 500 字符），
-- 与服务端 reportStatus 的 last_error_detail 参数、internalRouter PATCH 截断逻辑配套。
--
-- 执行方式（本仓无自动迁移器，需人工 psql 执行）：
--   psql "$DATABASE_URL" -f src/db/migrations/024_stock_trace_job_error_detail.sql
ALTER TABLE stock_trace_jobs
    ADD COLUMN IF NOT EXISTS last_error_detail TEXT;
