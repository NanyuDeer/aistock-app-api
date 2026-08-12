# AGENTS.md - modules/user（用户画像）

> Phase 4-3（改进 15 全局用户记忆）：记录用户精华信息（称呼/投资偏好/风险偏好），
> 供对话回答个性化（agent-py 注入 qa_router/synth_answer 消费）。

## 功能范围

- `user_profiles` 表：`user_id TEXT PRIMARY KEY` + `nickname` + `investment_preferences JSONB` + `risk_tolerance TEXT` + `updated_at`；启动时 `CREATE TABLE IF NOT EXISTS`（`src/index.ts` 迁移块）
- `GET/PUT/DELETE /api/user/profile`（JWT 鉴权；openid 即 user_id，P0 身份契约）；DELETE 为 PIPL 删除权，删除后同步失效 agent-py 侧画像缓存（Phase 4 验收修复 B8）

## 接口契约

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/user/profile` | GET | 当前用户画像；无记录返回 `{}`（不 404） |
| `/api/user/profile` | PUT | upsert 部分更新：仅更新传入字段（未传 → COALESCE 保留旧值）；`investment_preferences` **数组整体替换**（G7，非追加）；`risk_tolerance` 限定 `conservative | balanced | aggressive`；**成功后失效 agent-py 缓存（DEL `user_profile:{userId}`，消除 300s 旧画像窗口）** |
| `/api/user/profile` | DELETE | 删除当前用户画像（`DELETE FROM user_profiles WHERE user_id=$1`）+ **DEL agent-py 缓存**；成功返回 `{code:0,data:{deleted:true}}` |

## 校验边界（超限 400）

- `nickname`：非空字符串 ≤50 字
- `investment_preferences`：数组 ≤10 项、每项非空 ≤20 字
- `risk_tolerance`：Literal 三值

## 硬约束

- **JSONB 参数必须 JSON 序列化**（`JSON.stringify`）：node-postgres 对 JS 数组直传会报"类型json的输入语法无效"（500）——集成冒烟实证，测试断言参数为 JSON 文本
- "永不 500"：DB 异常返回 500 兜底文案，错误细节不外泄
- 无 token / 无效 token / 已撤销 token → 401（不触达 SQL）
- **跨库缓存失效**：agent-py 侧画像缓存 `user_profile:{userId}` 在 **db=1**（TTL 300s）；app-api 主 redis 连接在 **db=2**（`core/redis.ts`），**禁止 SELECT 污染**——用专用 db=1 短生命周期连接（`lazyConnect` + 1.5s 超时），`AGENT_PROFILE_CACHE_REDIS_URL`（默认 `redis://127.0.0.1:6379/1`）与 agent-py 生产 `REDIS_URL` 对齐（同一实例同一 db）；缓存失效失败仅 warning，不阻断 DELETE/PUT 200 响应

## 依赖

- `src/core/db`（PostgreSQL 连接池）
- `ioredis`（db=1 短生命周期连接，跨库缓存失效）
- `src/shared/utils/jwt`（verifyJwt）+ `src/shared/utils/tokenBlacklist`（撤销检查）
- internal 读取端：`src/core/routes/internal.ts` `GET /internal/user-profile/:userId`（X-Internal-Token，agent-py 对话注入用）
