# AGENTS.md - aistock-app-api

> 本文档是 **AI 开发助手的入口地图**，开发时 AI 必读。
>
> **与 README.md 的分工**：
> - `README.md` 面向人类开发者，介绍项目全貌、快速开始、技术栈、部署流程（"是什么、怎么跑起来"）
> - `AGENTS.md`（本文件）面向 AI 开发助手，聚焦模块架构地图、开发规范、硬约束、扩展流程、降级策略和跨服务协作契约（"怎么开发、开发时必须遵守什么"）
>
> **新增模块 / 接口时必读**：本文件第 4 节（开发规范）和第 6 节（降级策略）。
> 各子模块有独立的 `AGENTS.md`（`src/modules/<模块>/AGENTS.md`），说明该模块的功能、接口和依赖。

## 1. 项目概述

AiStock App 后端，基于 Express 5 + TypeScript，作为 App/H5/小程序的统一数据层和 HTTP 接入层。同时作为 Python Agent 推理服务（aistock-agent-py）的反向代理和数据源，通过 `/internal/*` 接口向 Python 提供 A 股数据。

## 2. 模块架构地图

### 三层结构

| 层 | 目录 | 职责 | 维护规则 |
|----|------|------|---------|
| 共享层 | `src/shared/` | 全局类型、工具函数、共享服务（CacheService、JWT、交易日历等） | 组长维护，模块只读引用 |
| 基础设施层 | `src/core/` | 数据库连接池、Redis 连接、路由注册、WebSocket 服务 | 组长维护 |
| 业务模块层 | `src/modules/` | 各业务功能模块，每人负责一个 | 模块间解耦，禁止互相引用 |

### 业务模块

| 模块 | 目录 | 功能范围 | 子模块 AGENTS.md |
|------|------|---------|-----------------|
| 行情 | `modules/quote` | 腾讯行情、K线、指数、个股分析、龙头股 | [quote/AGENTS.md](./src/modules/quote/AGENTS.md) |
| 推送 | `modules/push` | 微信模板消息、定时推送、事件订阅 | [push/AGENTS.md](./src/modules/push/AGENTS.md) |
| 认证 | `modules/auth` | 扫码登录、微信授权、飞书登录 | [auth/AGENTS.md](./src/modules/auth/AGENTS.md) |
| 监控 | `modules/monitor` | 风口龙头、异动监控、趋势股评分、知识图谱、机构调研、业绩预测、新闻 | [monitor/AGENTS.md](./src/modules/monitor/AGENTS.md) |
| 爬虫 | `modules/crawler` | 数据爬取、OCR、资讯研判、飞书研报 | [crawler/AGENTS.md](./src/modules/crawler/AGENTS.md) |
| Agent | `modules/agent` | `/api/agent/*` 反代到 Python FastAPI（SSE 透传 + 502 降级） | — |
| Chat | `modules/chat` | 会话元数据（P9）、token 用量统计（P10 线 2） | — |
| User | `modules/user` | 用户画像 profile（Phase 4-3 改进 15）：`GET/PUT /api/user/profile`（JWT，openid 即 user_id；部分更新，investment_preferences 数组整体替换） | [user/AGENTS.md](./src/modules/user/AGENTS.md) |

> 新增模块时，必须创建对应的 `src/modules/<模块名>/AGENTS.md`。

## 3. 目录结构速览

```
src/
├── index.ts                # 入口：Express + WebSocket 挂载 + cron 调度
├── shared/                 # 共享层（组长维护）
│   ├── types/
│   │   └── cache.ts        # 缓存键、TTL 配置、类型
│   └── utils/              # 工具函数 + 共享服务
│       ├── CacheService.ts          # Redis 缓存（Map 本地降级）
│       ├── TradingCalendarService.ts # 交易日历
│       ├── jwt.ts                   # JWT 签发/验证
│       ├── response.ts              # 统一响应格式
│       ├── validator.ts             # A 股代码校验
│       ├── tradingTime.ts           # 交易时间判断
│       ├── httpAgent.ts             # HTTP 会话复用
│       ├── stock.ts                 # 股票代码身份识别
│       ├── throttle.ts / throttlers.ts # 限流器
│       ├── datetime.ts              # 时间格式化
│       ├── parser.ts                # HTML 表格解析
│       ├── crawler.ts               # 爬虫工具
│       └── query.ts                 # 查询工具
├── core/                   # 基础设施（组长维护）
│   ├── db.ts               # PostgreSQL 连接池
│   ├── redis.ts            # Redis 连接
│   ├── routes/
│   │   ├── internal.ts     # Internal API（Python Agent 专用 + Agent 报告持久化）
│   │   └── configController.ts
│   └── ws/
│       ├── handler.ts      # WebSocket 连接管理 + 事件分发（noServer + 按 path 精确分发：/ws 行情频道）
│       ├── chat-bridge.ts  # Chat WS 桥接（P0：/api/agent/ws/chat 验签 JWT → 覆写 user_id → 反代 agent-py）
│       └── channels/       # 频道（alert / quote）
├── modules/                # 业务模块层（每人负责一个）
│   ├── quote/              # 行情
│   ├── push/               # 推送
│   ├── auth/               # 认证
│   ├── chat/               # 会话元数据（P9）+ token 用量（P10 线 2）
│   ├── monitor/            # 监控（异动/风口/趋势股评分/知识图谱/机构调研）
│   ├── crawler/            # 爬虫
│   └── agent/              # Agent 反代（SSE 透传 + 502 降级）
└── data/kg-cache/          # 知识图谱缓存（运行时生成，勿手动编辑）
```

## 4. 开发规范

### 4.1 模块依赖规则

- ✅ `modules/*` → `shared/`（允许）
- ❌ `modules/A` → `modules/B`（禁止，模块间解耦）
- ✅ `core/` → `shared/`（允许）
- ✅ `core/` → `modules/*`（仅路由注册时）
- 模块间需要共享数据时，通过 `shared/` 提取公共逻辑，或在 `core/routes/` 中编排

### 4.2 新增模块流程

1. 在 `src/modules/` 下新建目录
2. 创建 `controller.ts`（路由处理）和必要的 `Service.ts`（业务逻辑）
3. 创建 `src/modules/<模块名>/AGENTS.md`，说明功能、接口、依赖
4. 在 `core/routes/` 中注册路由
5. 在 `index.ts` 中挂载路由
6. 更新本文件第 2 节的模块表

### 4.3 新增路由流程

1. 在对应模块的 `controller.ts` 中实现处理函数
2. 在 `core/routes/` 对应文件中注册路由（或新建路由文件）
3. 在 `index.ts` 中挂载（`app.use('/api/...', router)`）
4. 更新 `README.md` 的 API 路由表
5. 更新对应模块的 `AGENTS.md` 接口列表

### 4.4 新增 Internal API 流程（供 Python Agent 调用）

1. 在 `core/routes/internal.ts` 中新增路由
2. 路由必须校验 `X-Internal-Token`（通过 `verifyInternalToken` 中间件）
3. 接口返回统一 JSON 格式：`{ code: 0, data: ..., message: "" }`
4. 同步更新 Python 侧 `aistock-agent-py/AGENTS.md` 的 "Node.js 侧配合接口" 表
5. 更新本文件第 7 节的 Internal API 表

### 4.5 路由规范

- 新增路由在 `core/routes/` 中添加
- 必须在 `index.ts` 中挂载
- 统一响应格式通过 `shared/utils/response.ts`

## 5. 关键约束（硬约束）

| 约束 | 说明 |
|------|------|
| 行情数据源 | 行情用腾讯 API，龙头用同花顺，**禁止东方财富** |
| cron 时区 | 所有 `cron.schedule()` 必须显式指定 `{ timezone: 'Asia/Shanghai' }` |
| LLM 失败处理 | LLM 调用失败时跳过，返回纯数据，不重试 |
| 微信 API | 微信 API 用原生 `fetch`，不用 `sessionFetch` |
| 向量检索 | 使用 pgvector，不引入独立向量数据库 |
| 数据库/Redis | 仅服务端可用，本地开发使用降级模式（内存缓存 + mock 数据） |
| 诊断零错误 | 前端和后端必须零诊断错误才能正常运行 |
| 模块解耦 | 模块间禁止互相引用，组件必须解耦可插拔 |
| 禁用 emoji | 禁止使用 emoji 图标，统一用 SvgIcon 组件加载 SVG |
| 接口兼容 | aistock-app-api 必须与 aistock-api 端点完全兼容，支持无缝替换 |
| 内部接口鉴权 | `/internal/*` 接口必须校验 `X-Internal-Token` |
| JWT 撤销 | `token_blacklist:{jti}` 黑名单（TTL=token 剩余寿命）；logout 按 jti 撤销，`degraded: true`（仅内存）/ `legacy: true`（无 jti 旧 token）；各鉴权入口验签后查黑名单，命中 401 / WS 4401；读侧 fail-open + 写侧 never-silent（2026-08-11 token-revocation） |

## 6. 降级策略

### 6.1 数据库降级

- 本地开发无数据库时，服务自动进入降级模式
- 使用 mock 数据替代真实数据库查询
- 不影响服务启动和接口响应

### 6.2 Redis 降级

- `CacheService.ts` 实现双写策略：Redis + Map 本地缓存
- Redis 不可用时降级到 Map 本地缓存
- 详见 `shared/utils/CacheService.ts`

### 6.3 LLM 降级

- LLM 调用失败时跳过，返回纯数据
- 不重试，不中断请求

### 6.4 Agent 反代降级

- `/api/agent/*` 反代到 Python FastAPI
- Python 服务不可用时返回 502 降级响应
- SSE 流式透传中断时返回流错误
- 详见 `modules/agent/agent.proxy.ts`

### 6.5 节假日降级

- 节假日 API 失败时 `isChinaHoliday()` 返回 `false`（不跳过交易相关定时任务）
- 详见 `shared/utils/TradingCalendarService.ts`

## 7. 跨服务协作（与 Python Agent）

### 7.1 Internal API 完整列表

Python Agent 服务通过以下接口获取 A 股数据（需携带 `X-Internal-Token`）：

| 接口 | 数据源 | 说明 |
|------|--------|------|
| `GET /internal/quote/:symbol` | 腾讯行情 | 个股实时行情 |
| `GET /internal/flow/:symbol` | 新浪+Tushare | 资金流向 |
| `GET /internal/leader/:tagCode` | Tushare | 板块龙头 |
| `GET /internal/news/search/:symbol` | 财联社 | 个股新闻 |
| `GET /internal/news/telegraph?date=YYYY-MM-DD&limit=200` | 财联社 | 当日全量电报流（溯源用） |
| `GET /internal/news/latest` | 财联社 | 最新快讯 |
| `GET /internal/news/fulltext/:id` | 财联社 | 新闻全文 |
| `GET /internal/forecast/:symbol` | 同花顺 | 盈利预测 |
| `GET /internal/wind-leaders` | 风口算法 | 长线风口龙头数据 |
| `GET /internal/institution-research` | 机构调研 | 机构调研热门股（共振检测） |
| `GET /internal/institution-research/history` | 机构调研 | 历史记录 |
| `GET /internal/monitor/:symbol` | 异动引擎 | 个股监控事件 |
| `GET /internal/trend/score/:symbol` | 趋势股评分 | 评分详情（S/A/B/C/D 评级） |
| `GET /internal/trend/top` | 趋势股评分 | 排行列表（含60日均线剔除过滤） |
| `GET /internal/graph/concepts` | 知识图谱 | 产业链概念列表 |
| `GET /internal/graph/:concept` | 知识图谱 | 产业链图谱数据 |
| `GET /internal/health` | — | 轻量健康探针（无需 token） |
| `GET /internal/market/quick-snapshot` | 腾讯 | 15:30 后简版收盘快照（snapshot_kind=quick，指数/宽度/概念板块/主力资金均腾讯源）；**非交易日 409**（不返回"伪当日"） |
| `GET /internal/market/close-snapshot` | Tushare | 当日完整收盘快照（15:30 门禁 + 交易日/数据完整性校验） |
| `GET /internal/market/last-close-snapshot` | Tushare | **严格早于今天的最近交易日**收盘快照（盘中/空窗/非交易日回退用；目标日数据缺失则 409） |
| `GET /internal/quote/:symbol/kline` | Tushare | 个股日 K 线（P5 D41：days≤120、klt=101、fqt∈{0,1,2}；复用 TushareKlineService，返回英文键行 trade_date/open/high/low/close/pct_chg） |
| `GET /internal/index/quotes` | 腾讯行情 | A 股指数快照（P5 工作线 B：6 位纯数字代码、逗号分隔去重、上限 MAX_SYMBOLS；复用 IndexQuoteController 缓存+腾讯源，驼峰输出 index/name/price/changePercent/changeAmount；腾讯源失败单指数 → null 不整体 500） |
| `POST /internal/push/market-event` | 推送 | 市场事件重磅推送（Python morning_agent 触发） |
| `POST /internal/usage/records` | chat_token_usage | 记录一次对话 token 用量（Python ws.py 计费回调；user_id 必填非空、token 字段非负整数；成功 `{code:200,data:{id}}`） |
| `GET /internal/usage/summary?user_id=` | chat_token_usage | 按 user_id 累计用量（SUM/COUNT 聚合，无记录全 0，返回 prompt/completion/total_tokens + turn_count） |
| `GET /internal/user-profile/:userId` | user_profiles | 用户画像检索（Phase 4-3；agent-py 对话入口按 user_id 拉取注入，Redis 5min 缓存；无记录返回 200 + 空对象，不 404） |
| `POST /internal/predictions` | prediction_records | 预测记录落库（大盘溯源预测；source_type/source_id/schema_version/prediction/due_dates） |
| `GET /internal/predictions?status=pending` | prediction_records | 读取全部 pending 预测（到期验证扫描） |
| `PUT /internal/predictions/:id/verification` | prediction_records | 回写单档位验证结果（horizon/result/actual/reason → 全档位覆盖自动置 verified） |

> `prediction_records` 表（预测能力）：启动时自动建表（`src/index.ts`），列含 id/source_type/source_id/schema_version/prediction(JSONB)/verification(JSONB)/status(pending|verified)/due_dates(JSONB)/created_at；status 仅 `{pending, verified}`（无 expired）；`appendVerification` 全档位覆盖自动置 verified。Python agent-py scheduler 每日 16:00 到期验证任务消费。

### 7.2 Agent 分析报告持久化接口

供 Python Agent 持久化分析报告（scheduler 触发时写入，broadcast_agent 读取）：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/internal/analysis-reports` | POST | Upsert 报告（`report_type` + `report_date` + `content` JSONB + 可选 `user_id` + `expires_at`） |
| `/internal/analysis-reports/:type/:date` | GET | 查询报告（按类型 + 日期） |
| `/internal/analysis-reports/:type/:date/:userId` | GET | 查询用户专属报告 |
| `/internal/analysis-reports/cleanup` | DELETE | 清理过期报告（`expires_at < NOW()`，定时 03:00 执行） |
| `/internal/briefing/generate-audio` | POST | 根据 broadcast 报告生成 MP3，并写回 `content.audio_path` |

> 数据库表：`agent_analysis_reports`，`content` 字段为 JSONB，唯一索引使用 `COALESCE(user_id, '')` 解决 NULL 问题。
> 建表脚本：`docs/sql/agent_analysis_reports.sql`

### 7.3 Agent 公开接口（前端直接调用，无需 X-Internal-Token）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/agent/report/:intent/:date` | GET | 查询分析报告（intent: morning/wind_leader/hot_burst/broadcast/stock/alert/review/iterate，date: YYYY-MM-DD） |
| `/api/agent/audio/:filename` | GET | 音频文件流服务（防路径遍历，默认目录 `AGENT_AUDIO_DIR` 或 `/home/aistock/aistock-agent-py/data/audio`） |
| `/api/agent/event/list` | GET | 事件传导报告列表（分页，page/pageSize；每项含 `chain_summary` 字段） |
| `/api/agent/event/:eventId` | GET | 事件传导报告详情（完整 analysis_reports；顶层含 `chain_summary` 字段） |

> **`chain_summary` 字段契约**（2026-08-10 新增）：`{industry, direction, impactStrength, reason}[]`，由 `src/core/routes/internal.ts` 的 `extractChainSummary` 从 `content.analysis_reports.event_transmission.chain` 提取（按 impactStrength 降序 Top5，过滤空 industry，不修改原 chain）。旧数据（无 chain）返回 `[]`，禁止返回 undefined/null。此字段专供前端展示，Python Agent 无需消费。

> publicRouter 必须在 createAgentProxy 之前挂载（`src/index.ts`），Express 按注册顺序匹配。

### 7.6 预测公开接口（前端直接调用，无需 X-Internal-Token）

| 接口 | 方法 | 说明 |
|------|------|------|
| `GET /api/predictions` | GET | 历史预测列表（B2.1）：`status=all\|pending\|verified`（默认 all）+ `page`（默认1）+ `pageSize`（默认20，上限50），按 created_at DESC；响应含 `items`（每项附 `report_date`，从 source_id `review:YYYY-MM-DD` 解析，失败回退 created_at 上海日期）+ `stats`（total/pendingCount/verifiedCount/hitRate/verifiedHorizonCount/hitCount/missCount；命中率 = hit/(hit+miss)，insufficient 不计）+ `pagination`；`id` 已归一为数字（pg BIGSERIAL 返回 string） |
| `GET /api/predictions/:id` | GET | 历史预测详情；`:id` 非正整数 → 400，不存在 → 404 |

> `modules/prediction/publicRouter.ts`（含 `__predictionPublicDependencies` 测试注入点，测试见 `publicRouter.test.ts`，6 用例 mock Service 层不触达 PG）。

### 7.4 Agent 反代接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/agent/*` | GET/POST | 反代到 Python FastAPI（SSE 流式透传，自动注入 `X-Internal-Token`）。**P0 身份鉴权（chat 三路径）**：`/chat/message`、`/chat/stream/messages`、`/chat/stream/updates` 校验 `Authorization: Bearer` JWT（非法/过期 401，上游零调用）+ 覆写 body `user_id` 为 openid（无 token 置 null）；非 chat 路径行为不变（原始 pipe 透传） |
| `/api/agent/ws/chat` | WS | **P0 Chat WS 桥接**（`core/ws/chat-bridge.ts`）：upgrade 验签 query `token`——无 token 放行（user_id=None）、非法/过期 `close(4401)`；作为 WS 客户端连 agent-py（带 `X-Internal-Token`），双向转发并覆写消息体 `user_id`（前端→上游），上游→前端字节原样透传 |

> 配置环境变量 `AGENT_PY_URL`（默认 `http://localhost:8080`）、`JWT_SECRET`（chat 路径验签）。
> **Caddy 部署顺序**：WS 面收口依赖 Caddy 删 `gupiao-api.yaozhineng.com` 块内 `@agentWs` 命名路由（使 `/api/agent/ws/*` 落 app-api 56790）；切换前 WS 仍直连 agent-py。

### 7.5 Chat 会话与用量接口（前端直接调用，JWT openid 鉴权）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/chat/sessions` | POST | 幂等 upsert 会话元数据（`{session_id, question}`；title=question 前 30 字或'新会话'；同 id 重复上报仅刷新 last_message_at，不改 title/归属；id 已归属他人→409；401 未登录；400 session_id 非法） |
| `/api/chat/sessions` | GET | 当前用户最近 50 个会话（last_message_at DESC，camelCase：session_id/title/last_message_at/created_at） |
| `/api/chat/sessions/:id` | DELETE | 删除会话（id + user_id 双条件，防越权删他人会话） |
| `/api/chat/usage/summary` | GET | 当前用户累计 token 用量（prompt/completion/total_tokens + turn_count，无记录全 0） |

> 身份契约：JWT payload 的 `openid` 即计费 user_id（Authorization Bearer 优先，Cookie `token=` 兜底）。**P0（2026-08-11）**：chat agent 路径（HTTP chat 三路径 + WS 桥接）的 `user_id` 由 app-api 验签后服务端注入，客户端自报一律失效（无 token 为 null）。
> **token-revocation（2026-08-11）**：signJwt 自动生成 `jti`；`POST /api/auth/logout` 按 jti 写 `token_blacklist:{jti}`（TTL=剩余寿命）；鉴权入口（chat/auth/monitor/insight/stock-trace + agent.proxy chat 三路径 + chat-bridge WS）验签后查黑名单，命中 401 / close(4401)；`degraded`/`legacy` 为显式降级字段，前端可选用作提示（不改 token 存储方式）。
> 数据库表：`chat_sessions`（P9 会话元数据：id PK、user_id、title、last_message_at、created_at，索引 idx_chat_sessions_user）、`chat_token_usage`（P10 线 2 用户维度计费：BIGSERIAL PK、user_id、session_id 预留、三个 token 字段、question、created_at），均在启动时自动建表（`src/index.ts`）。

## 8. 定时任务速查

| 时间 | 任务 | 说明 |
|------|------|------|
| 启动时 | trend_scores 自动迁移 | CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN IF NOT EXISTS ma60_excluded（堵住 deploy.sh 漏执行 SQL 的缺口） |
| 00:00 | 业绩预测自动更新 | 同花顺数据 |
| 00:05 | 数据同步 | — |
| 02:00 | 趋势股批量评分 | TrendBatchService（含60日均线剔除），每天执行不检查交易日 |
| 03:00 | 报告清理 | 删除过期 Agent 分析报告（`expires_at < NOW()`） |
| 03:00 | 知识图谱/其他 | — |
| 03:00 | 风口龙头分析 | WindLeaderAnalyzerService（空结果不覆盖旧数据） |
| 08:00 | 数据预热 | — |
| 09:30-15:05 | 机构调研检测 | 交易日 6 个时段（开盘/上午/午前/午盘/尾盘/收盘） |
| 11:30 | 午盘价格打点 | PriceMoveService.run('midday')，自选股按 abs(move_bps)>=700 触发价格异动洞察 |
| 11:50 | 午盘补抓 | refetchMiddayEvidence：对当日午盘已触发事件重新冻结证据包（frozen_seq++）+ force 重入队，Python 重新归因 |
| 15:05 | 尾盘价格打点 | PriceMoveService.run('close')，同方向升级/反方向独立事件 |
| 15:00 | 数据归档 | — |
| 15:35 | 板块轮动榜同步 | RotationBoardStore.syncRotationHistory（交易日收盘后增量，幂等；首次部署启动时自动回填近140交易日） |
| 19:05 | 收盘后任务 | — |

> 所有 cron 任务必须指定 `{ timezone: 'Asia/Shanghai' }`。

## 9. 常用命令

```bash
pnpm install              # 安装依赖
pnpm dev                  # 开发模式（tsx watch 热重载）
npx tsc --noEmit          # TypeScript 类型检查
pnpm build && pnpm start  # 生产模式
pm2 start ecosystem.config.json  # PM2 部署
pm2 logs aistock-api      # 查看日志
```

## 10. 相关项目

- [aistock-app-frontend](../aistock-app-frontend) — App 前端（uni-app）
- [aistock-agent-py](../aistock-agent-py) — Python Agent 推理服务
- [aistock-api](../aistock-api) — 原 PC Web 后端（兼容参照）
