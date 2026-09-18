-- 020_attribution_chains.sql
-- 大盘归因链权威表（date text PK，content 为整棵链树 JSONB）。
-- 2026-09-17 前由路由内联建表（src/core/routes/attributionChainRouter.ts 的
-- CREATE TABLE IF NOT EXISTS，每次 POST 都执行、非事务且多实例并发会竞态），此处转正；
-- 已上线的库执行本迁移无副作用（IF NOT EXISTS）；未执行的库由本迁移建表，
-- 路由不再建表，故**部署必须先执行本迁移**（执行方式同 016/017：
-- psql "$DATABASE_URL" -f src/db/migrations/020_attribution_chains.sql）。

CREATE TABLE IF NOT EXISTS attribution_chains (
    date text PRIMARY KEY,
    content jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
