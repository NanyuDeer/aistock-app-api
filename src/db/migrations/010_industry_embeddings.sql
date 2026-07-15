-- 010_industry_embeddings.sql
-- Event Agent 升级：启用 pgvector 扩展 + 创建行业嵌入向量表
-- 用于事件传导分析 Step 3（首层行业定位）的语义匹配
-- 向量维度 1536（OpenAI text-embedding-3-small）

-- 启用 pgvector 扩展（幂等）
CREATE EXTENSION IF NOT EXISTS vector;

-- 行业嵌入向量表
CREATE TABLE IF NOT EXISTS industry_embeddings (
    id SERIAL PRIMARY KEY,
    industry_code VARCHAR(50) NOT NULL UNIQUE,
    industry_name VARCHAR(200) NOT NULL,
    keywords TEXT[],
    description TEXT,
    embedding vector(1536),
    model_version VARCHAR(30) DEFAULT 'text-embedding-3-small',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- IVFFlat 索引（适合 10 万级以下数据）
-- 注意：IVFFlat 索引需要在表中有数据后才能创建。
-- 初始化脚本（scripts/init_industry_embeddings.py）填充数据后，手动执行以下 SQL：
--   CREATE INDEX ON industry_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
-- 数据量增长到 10 万+ 时，可替换为 HNSW 索引：
--   CREATE INDEX ON industry_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200);
