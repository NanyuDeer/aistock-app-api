-- =============================================================================
-- podcast_cache 表 — 播报文本/音频缓存（通用播报 generate-podcast 专用）
--
-- 需求背景（8.1会议）：语音播报文本先生成存库，避免实时分析；音频按 key 幂等缓存
-- 表设计：cache_key 唯一（如 alert_603601_2026-08-01），text 为播报稿，audio_path 为音频
-- 过期策略：expires_at 默认 7 天，随 03:00 清理任务删除过期行及对应音频文件
--
-- 在云服务器上执行：
--   docker exec -it pg psql -U root -d aistock -f docs/sql/podcast_cache.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS podcast_cache (
    id SERIAL PRIMARY KEY,
    cache_key VARCHAR(100) NOT NULL UNIQUE,      -- 缓存键：key sanitize 后（仅字母数字下划线连字符）
    text TEXT NOT NULL,                          -- 播报文本（≤250字，约1分钟）
    audio_path VARCHAR(255) NOT NULL DEFAULT '', -- 音频 URL 路径（/api/agent/audio/podcast-{key}.mp3），生成后回填
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending / completed / failed
    error_message TEXT,                          -- 生成失败时的错误信息
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '7 days'
);

CREATE INDEX IF NOT EXISTS idx_podcast_cache_expires_at ON podcast_cache(expires_at);

-- 授予 aistock 用户权限
GRANT SELECT, INSERT, UPDATE, DELETE ON podcast_cache TO aistock;
GRANT USAGE, SELECT ON podcast_cache_id_seq TO aistock;

SELECT 'podcast_cache 表创建完成' AS message;
