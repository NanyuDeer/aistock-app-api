-- 可提前执行；应用启动也会幂等补列。旧数据保持NULL，读时返回unknown。
BEGIN;
ALTER TABLE institution_research_history ADD COLUMN IF NOT EXISTS source_details JSONB;
ALTER TABLE stock_concept_mapping ADD COLUMN IF NOT EXISTS sector_code TEXT;
COMMIT;
