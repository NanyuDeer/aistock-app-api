# Changelog — aistock-app-api

> 所有修改记录按时间倒序排列。每条记录标注分支、时间、开发者。

## [changer] 2026-08-12 — 问题 19 修复：user_profile 缓存失效连接对齐 agent-py 真实 Redis
**开发者**: 37588

### 修复
- `src/modules/user/profileController.ts`：新增 `resolveAgentCacheRedisUrl()`——缓存失效连接默认值原写死 `redis://127.0.0.1:6379/1`（无密码），生产 Redis requirepass + agent-py 画像缓存实际在 db15 → `NOAUTH` 失效从未执行（DELETE 后 300s 内旧画像仍生效，删除权失效窗口，Phase 4 生产验证 D3 实证）。现改为：`AGENT_PROFILE_CACHE_REDIS_URL` 显式覆盖优先；未配置则从本服务 `REDIS_URL` 派生（保留 auth/host/port，仅把 db 段替换为 `AGENT_PROFILE_CACHE_DB`=15，与 agent-py 缓存真实位置对齐）；无 `REDIS_URL` 兜底 `redis://127.0.0.1:6379/15`。`_agentCacheRedisFactory.current` 改为运行时调用

### 新增
- 测试：`src/modules/user/__tests__/profile.spec.ts` +4 用例（显式 env 优先 / REDIS_URL 派生替换 db / 无 db 段追加 / 无配置兜底），18/18 通过

### 文档
- `src/modules/user/AGENTS.md`：硬约束"跨库缓存失效"更新为 db15 + 派生逻辑描述（原 db=1 描述过时）

> 待部署：push → PR → merge → 服务器 `git pull` + `tsc` build + `pm2 restart` → 重跑 D3（DELETE 后立即对话应回通用档）。

---

## [changer] 2026-08-11 — P1 JWT 撤销与演进（token-revocation）
**开发者**: 37588

### 新增
- `src/shared/utils/tokenBlacklist.ts`：`revokeToken`（按 jti 写 `token_blacklist:{jti}`，TTL=剩余寿命 clamp [1,7天]，返回 `{ok, persisted}`）、`isTokenRevoked`（读侧 fail-open + 读异常 WARN 非静默）、`extractTokenFromRequest`（Bearer 优先 Cookie 兜底）、`REVOKED_MESSAGE`
- 测试：`src/shared/utils/__tests__/cacheService.spec.ts`（5）、`tokenBlacklist.spec.ts`（8）、`src/modules/auth/__tests__/logout.spec.ts`（5）

### 改进
- `src/shared/utils/CacheService.ts`：`set/put/refresh` 返回 `Promise<boolean>`（Redis 持久写落地状态）；`token_blacklist:` 键豁免 `LOCAL_CACHE_MAX_SIZE` 通用淘汰（仅 TTL 自然过期）；Redis 不可用一次性 WARN；`__cacheServiceDependencies` 测试注入点
- `src/shared/utils/jwt.ts`：`JwtPayload.jti?` + `signJwt` 自动生成 `jti`（UUID；显式 jti 优先）；`verifyJwt` 零改动（无 jti 在途旧 token 零拒绝）
- `src/modules/auth/controller.ts` logout：按 jti 撤销——`persisted=false` → 200 + `data.degraded:true`；`ok=false` → 500；无 jti 旧 token → 200 + `data.legacy:true` + WARN；无效/无 token 幂等 200；token 来源与 requireAuth 对齐；所有分支删 Cookie（`setLogoutCookie` 私有辅助）
- 鉴权入口读侧黑名单（8 处）：chat/sessionUsageController、sessionController、usageController、auth/userController、feishuAuthController、monitor/controller（requireAuth 验签后 `isTokenRevoked` 401）+ insight/controller、stock-trace/controller（`openidFromRequest` 改 async + 黑名单，7/7 调用点 await）
- `src/modules/agent/agent.proxy.ts` chat 三路径 + `src/core/ws/chat-bridge.ts`：验签后查黑名单——命中 HTTP 401（上游零调用）/ WS close(4401)（不建上游连接）

### 文档
- `AGENTS.md`：§5 关键约束表新增 JWT 撤销行 + §7.5 身份契约段 token-revocation 注

> 硬约束：写侧 never-silent（撤销未持久化显式 `degraded` / 500）、读侧 fail-open（黑名单只含被撤销凭证，读失败不影响合法用户，WARN 非静默）。
> **部署前置（上线前必须执行）**：`pm2 list` 确认 app-api 单实例；若多实例须升级黑名单为 Redis 必须项（见 roadmap §5）。

---

## [changer] 2026-08-11 — P0 身份鉴权（Phase 1a）
**开发者**: 37588

### 新增
- `src/core/ws/chat-bridge.ts`：接管 `/api/agent/ws/chat` upgrade——验签 query token（无 token 放行 user_id=None；非法/过期 close(4401)），作为 WS 客户端连 agent-py（带 X-Internal-Token），双向转发并覆写消息体 user_id（客户端自报失效）
- `src/core/ws/__tests__/chat-bridge.spec.ts`（6 用例）、`src/shared/utils/__tests__/jwt.spec.ts`（7 用例）

### 修复
- `src/shared/utils/jwt.ts`：verifyJwt 畸形输入 fail-closed（签名长度预检 + try/catch 返回 null，不抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH）
- `src/core/ws/handler.ts`：改 noServer + 按 path 精确分发（ws@8 双 {server,path} 实例对不匹配 path abortHandshake(400) 互斥）

### 改进
- `src/modules/agent/agent.proxy.ts`：chat 三路径（/chat/message、/chat/stream/messages、/chat/stream/updates）Authorization Bearer JWT 校验（非法/过期 401）+ 覆写 body user_id；非 chat 路径行为零变化
- `src/index.ts`：挂载 chat 桥接 + createAgentProxy 传 jwtSecret

> 部署注意：Caddy `/api/agent/ws/*` 已指向 app-api（管理员 2026-08-11），本改动部署后 WS 恢复 + HTTP 面鉴权生效；前端发版须在其后。

---

## [changer] 2026-08-10 — B2.1 历史预测跟踪公开查询接口（/api/predictions）

**开发者**: 37588

### 新增
- `src/modules/prediction/publicRouter.ts`：`GET /api/predictions`（列表 + 命中率统计 + 分页，status=all|pending|verified）、`GET /api/predictions/:id`（详情）；公开接口无需 X-Internal-Token；`__predictionPublicDependencies` 测试注入点；`toItem` 中 `id` Number() 归一（pg BIGSERIAL 返回 string）
- `src/modules/prediction/publicRouter.test.ts`：路由层 6 用例（400×2 / 列表统计 / hitRate null / 详情 / 404，mock Service 不触达 PG）
- `src/modules/prediction/PredictionRecordService.ts`：`list` / `listAllForStats` / `getById` 三个查询方法

### 改进
- `src/index.ts`：挂载 `/api/predictions`（404 catch-all 之前）

### 测试
- `publicRouter.test.ts` 6/6；`npx tsc --noEmit` 0 错误；真实联调 curl 列表/详情/400/404 全部正确

---


## [changer] 2026-08-10 — B2 预测能力落库接口（prediction_records）

### 新增
- `src/core/routes/internal.ts`：`POST /internal/predictions`（upsert，`(source_type, source_id)` 唯一索引 + ON CONFLICT DO UPDATE）、`GET /internal/predictions?status=pending`、`PUT /internal/predictions/:id/verification`（appendVerification 全档位覆盖自动置 verified）
- `src/modules/prediction/PredictionRecordService.ts`：create / listPending / appendVerification

### 改进
- `src/index.ts`：启动时自动建表 `prediction_records`（status 仅 {pending, verified}）
