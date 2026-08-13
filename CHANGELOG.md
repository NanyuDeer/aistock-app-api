# Changelog — aistock-app-api

> 所有修改记录按时间倒序排列。每条记录标注分支、时间、开发者。

## [changer] 2026-08-12 — Phase 5 删会话联动删 checkpointer thread
**开发者**: 37588

### 新增
- `src/modules/chat/agentThreadClient.ts`：`deleteChatThread(sessionId)`——调用 agent-py `DELETE /api/agent/internal/chat/threads/:session_id`（X-Internal-Token；AbortController 3s 超时；非 2xx 抛错；env：`AGENT_PY_URL || PYTHON_AGENT_URL || http://localhost:8080`）

---

## [junliang] 2026-08-06 — 自选股洞察：事件归属锚定标题主体股票 + 归因回写修复

**开发者**: Aria

---

## [master] 2026-08-06 — 风口龙头 v4-flash 思考关闭不可靠的兜底：JSON 截断重试 + 数据异常提示

**开发者**: Aria

### 修复
- `src/modules/insight/InsightService.ts`：自选股事件匹配锚定标题主体股票（"XX触及涨停"），详情页推荐/相关股票链接不再创建事件（修复事件挂错标的，如汇金通被挂到中国电建）；单篇详情抓取失败仅记日志跳过不中断整轮
- `src/modules/insight/LimitUpRadarCrawler.ts`：新增 `parseTitleStockName`（提取标题主体股票并去除括号代码）；详情页为 UTF-8，fetchDetail 显式指定编码；列表分页按 articleId 去重（CDN 缓存抖动）
- `src/db/migrations/016_watchlist_insights.sql`：`watchlist_insight_results.confidence` 由 VARCHAR(8) 扩为 VARCHAR(16)（'unconfirmed' 11 字符超长导致结果回写 500）
- `src/shared/utils/crawler.ts`：`fetchHtml` 支持 `encoding` 参数（'gbk'|'utf-8'，默认 gbk），修复详情页乱码

### 测试
- `src/modules/insight/__tests__/limitUpRadarCrawler.spec.ts`：新增 5 个 `parseTitleStockName` 用例（含涨停复盘类标题返回 null）

---

- `WindLeaderAnalyzerService.aiAnalyzeSector`：v4-flash 深度思考无法 100% 关闭——长 prompt + 异常数据（领涨股涨幅0/涨跌家数0）时模型仍会思考，耗尽 max_tokens 导致 content 为空或 JSON 截断（`Unterminated string in JSON`）→ ① max_tokens 提档 [2000,6000] ② JSON 截断/解析失败也触发提高 max_tokens 重试（原仅 content 空才重试）③ 请求超时 60s→90s
- `buildAiPrompt`：提示词增加"输入数据可能存在异常，请忽略并直接基于现有数据判断，不要质疑数据"（模型曾因异常数据陷入深度思考）

---

## [master] 2026-08-06 — 风口龙头 AI 关闭深度思考：deepseek-v4-flash 直接输出 JSON

**开发者**: Aria

### 修复
- `WindLeaderAnalyzerService.aiAnalyzeSector`：DeepSeek V4 系列（v4-flash/v4-pro）默认开启深度思考，`max_tokens` 被 `reasoning_content` 耗尽导致 `content` 为空（服务器实测）→ 对 deepseek 模型请求体附加 `reasoning_effort:"none"` 显式关闭思考，模型直接输出 JSON（服务器实测有效，不换模型）
- AI 输出健壮性：`long_term_days`/`short_term_days` clamp 到 schema 范围（0~90 / 0~30），防 LLM 越界值（实测模型输出过 120 天）

---

## [master] 2026-08-06 — 风口龙头 AI 推理模型兜底：content 空自动提高 max_tokens 重试

**开发者**: Aria

### 修复
- `WindLeaderAnalyzerService.aiAnalyzeSector`：服务器日志定位到 `content=""` 但 `reasoning_content` 有内容——`AI_MODEL` 配置的是推理模型（deepseek-reasoner/v4 推理版），token 消耗在思考过程、最终答案为空 → 新增重试：content 空且存在 reasoning_content 时提高 max_tokens（1200→4000）重试一次；请求超时 45s→60s。仍失败则降级规则引擎（已按月分档+标签区分）
- 更优解：服务器 `AI_MODEL` 直接改用非推理模型 `deepseek-chat`（curl 实测直接输出 content）

---

## [master] 2026-08-06 — 风口龙头双链修复：AI 截断降级 + 规则引擎月度分档 + 标签区分

**开发者**: Aria

### 修复
- `WindLeaderAnalyzerService.aiAnalyzeSector`：`max_tokens` 500→1200（14 字段+80 字理由的中文 JSON 在 500 token 下被截断 → `JSON.parse` 报 `Unexpected end of JSON input` → 全部板块走规则引擎，长线全 45 天、标签全"资金"；服务器实测 DeepSeek API 正常，确认为截断问题）
- `WindLeaderAnalyzerService.ruleBasedAnalysis`：长线持续天数由固定 45 天改为按月分档（30/60/90 天，对应 1/2/3 个月）；`logic_type` 按板块名关键词区分（政策/业绩/资金/无支撑），避免降级时全部为"资金"

### 改进
- `src/modules/chat/sessionController.ts` `remove`：PG 删除 `chat_sessions` 成功后 `await deleteChatThread(sessionId)`（`__threadClientDependencies` 注入点供测试 stub）；失败仅 warning 不阻断，仍返回 200（"永不 500"）

### 测试
- `src/modules/chat/__tests__/session.spec.ts` +2（联动调用触发 / 联动失败仍 200）

> 验证：tsc --noEmit 0 错误；chat 定向 18/18。配套 agent-py Phase 5（窗口+零 LLM 摘要 / 删 thread / busy_timeout）。代码验收通过（待生产验证），待组长 merge 后部署验证。

---

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
