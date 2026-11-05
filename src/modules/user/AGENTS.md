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
| `/api/user/profile` | DELETE | 删除当前用户画像（`DELETE FROM user_profiles WHERE user_id=$1`）**+ 级联删除 `user_profile_inferences`（画像自动挖掘一期，PIPL 删除权）** + DEL 两个 agent-py 缓存 key（`user_profile:{id}` 与 `user_profile_inferences:{id}`）；成功返回 `{code:0,data:{deleted:true}}` |

## 画像自动挖掘一期（2026-11-05）在本模块的落点

本模块只承担 **DELETE 级联**，不承担挖掘逻辑（挖掘在 `src/modules/profile-mining/`，且**不得被本模块反向依赖**）：

- `DELETE /api/user/profile` 依次执行：删 `user_profiles` 行 → 删 `user_profile_inferences` 行 → `delAgentProfileCache` → `delAgentInferenceCache`；任一步缓存失败仅 warning（TTL 300s 兜底），不阻断 200
- `delAgentInferenceCache` 定义在本文件（与 `delAgentProfileCache` 同源工厂 `_agentCacheRedisFactory`），key 为 `user_profile_inferences:{userId}`，DB 同为 15
- **显式画像仍是唯一权威**：本模块任何路径都不读、不写推断表内容（除上述级联删除），推断结果不覆盖 `user_profiles` 字段
- 公开侧推断接口在 `modules/profile-mining/ProfileMiningController`（`GET /api/user/profile/inferences/meta`、`DELETE /api/user/profile/inferences`），不在本模块
- 鉴权统一走 `src/shared/utils/authGuard.resolveAuth`（本文件与 profile-mining 共用；勿再新增 `private static requireAuth` 副本）

## 校验边界（超限 400）

- `nickname`：非空字符串 ≤50 字
- `investment_preferences`：数组 ≤10 项、每项非空 ≤20 字
- `risk_tolerance`：Literal 三值

## 硬约束

- **JSONB 参数必须 JSON 序列化**（`JSON.stringify`）：node-postgres 对 JS 数组直传会报"类型json的输入语法无效"（500）——集成冒烟实证，测试断言参数为 JSON 文本
- "永不 500"：DB 异常返回 500 兜底文案，错误细节不外泄
- 无 token / 无效 token / 已撤销 token → 401（不触达 SQL）
- **跨库缓存失效**：agent-py 侧画像缓存 `user_profile:{userId}` 在 **db=15**（agent-py `REDIS_URL` 所在 Redis，TTL 300s）；app-api 主 redis 连接在 **db=9**（`core/redis.ts`），**禁止 SELECT 污染**——用专用短生命周期连接（`lazyConnect` + 1.5s 超时）。连接 URL 解析（`resolveAgentCacheRedisUrl`，问题 19 修复 2026-08-12）：`AGENT_PROFILE_CACHE_REDIS_URL` 显式覆盖优先；未配置则从本服务 `REDIS_URL` 派生（保留 auth/host/port，仅把 db 段替换为 `AGENT_PROFILE_CACHE_DB`=15，与 agent-py 缓存真实位置对齐）；无 `REDIS_URL` 兜底 `redis://127.0.0.1:6379/15`。缓存失效失败仅 warning，不阻断 DELETE/PUT 200 响应

## 依赖

- `src/core/db`（PostgreSQL 连接池）
- `ioredis`（db=1 短生命周期连接，跨库缓存失效）
- `src/shared/utils/jwt`（verifyJwt）+ `src/shared/utils/tokenBlacklist`（撤销检查）
- internal 读取端：`src/core/routes/internal.ts` `GET /internal/user-profile/:userId`（X-Internal-Token，agent-py 对话注入用）
