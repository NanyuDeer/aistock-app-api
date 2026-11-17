-- 029: 行业嵌入向量表（不用 pgvector）
--
-- 为什么不用 pgvector（2026-11-17 实测）：
--   pg 镜像是 postgres:17（官方版，不含 pgvector），
--   pg_available_extensions 里连 vector 都没有 → CREATE EXTENSION 会失败。
--   装它要换镜像（重建生产库容器）或进容器编译（容器重启即丢）。
--
-- 而我们的量根本不需要：
--   110 个行业 × 1024 维 × 4 bytes ≈ 450KB
--   每次匹配 = 110 次余弦，应用层微秒级完成
--   pgvector 的价值在百万级向量的 ANN 索引，我们连千分之一都用不到。
--
-- 所以存普通 DOUBLE PRECISION[]，余弦在 Node 里算。
--
-- 为什么要 model 字段：
--   不同模型的向量空间完全不通用。换模型必须全量重灌，否则相似度是垃圾。
--   记下生成时的模型名，灌数脚本可据此判断是否需要重灌。

-- 防御：旧版表是 pgvector 结构（embedding 为 vector 类型），与本表不兼容。
-- 生产库没有这张表，不会触发；本地/开发环境若是旧表，这里明确报错而不是静默跳过，
-- 避免「迁移跑过了但字段对不上」这类难查问题。
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'industry_embeddings'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'industry_embeddings' AND column_name = 'model'
    ) THEN
        RAISE EXCEPTION 'industry_embeddings 已存在但结构不符（缺 model 列，疑似旧版 pgvector 表），需人工确认后 DROP 重建';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS industry_embeddings (
    industry_name  VARCHAR(64) PRIMARY KEY,
    embedding      DOUBLE PRECISION[] NOT NULL,
    model          VARCHAR(64)  NOT NULL,
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN industry_embeddings.embedding IS
    '1024 维向量（bge-large-zh-v1.5）。换模型必须全量重灌，详见 model 字段。';
COMMENT ON COLUMN industry_embeddings.model IS
    '生成该向量的模型名。与当前配置不一致说明需要重灌。';
