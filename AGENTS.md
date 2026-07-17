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
| 监控 | `modules/monitor` | 风口龙头、异动监控、十倍股、知识图谱、机构调研、业绩预测、新闻 | [monitor/AGENTS.md](./src/modules/monitor/AGENTS.md) |
| 爬虫 | `modules/crawler` | 数据爬取、OCR、资讯研判、飞书研报 | [crawler/AGENTS.md](./src/modules/crawler/AGENTS.md) |
| Agent | `modules/agent` | `/api/agent/*` 反代到 Python FastAPI（SSE 透传 + 502 降级） | — |

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
│       ├── handler.ts      # WebSocket 连接管理 + 事件分发
│       └── channels/       # 频道（alert / quote）
├── modules/                # 业务模块层（每人负责一个）
│   ├── quote/              # 行情
│   ├── push/               # 推送
│   ├── auth/               # 认证
│   ├── monitor/            # 监控（异动/风口/十倍股/知识图谱/机构调研）
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
| `GET /internal/news/latest` | 财联社 | 最新快讯 |
| `GET /internal/news/fulltext/:id` | 财联社 | 新闻全文 |
| `GET /internal/forecast/:symbol` | 同花顺 | 盈利预测 |
| `GET /internal/wind-leaders` | 风口算法 | 长线风口龙头数据 |
| `GET /internal/institution-research` | 机构调研 | 机构调研热门股（共振检测） |
| `GET /internal/institution-research/history` | 机构调研 | 历史记录 |
| `GET /internal/monitor/:symbol` | 异动引擎 | 个股监控事件 |
| `GET /internal/tenx/score/:symbol` | 十倍股评分 | 评分详情 |
| `GET /internal/tenx/top` | 十倍股评分 | 排行列表 |
| `GET /internal/graph/concepts` | 知识图谱 | 产业链概念列表 |
| `GET /internal/graph/:concept` | 知识图谱 | 产业链图谱数据 |
| `GET /internal/health` | — | 轻量健康探针（无需 token） |
| `POST /internal/push/market-event` | 推送 | 市场事件重磅推送（Python morning_agent 触发） |

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

> publicRouter 必须在 createAgentProxy 之前挂载（`src/index.ts`），Express 按注册顺序匹配。

### 7.4 Agent 反代接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/agent/*` | GET/POST | 反代到 Python FastAPI（SSE 流式透传，自动注入 `X-Internal-Token`） |

> 配置环境变量 `AGENT_PY_URL`（默认 `http://localhost:8080`）。

## 8. 定时任务速查

| 时间 | 任务 | 说明 |
|------|------|------|
| 00:00 | 业绩预测自动更新 | 同花顺数据 |
| 00:05 | 数据同步 | — |
| 03:00 | 报告清理 | 删除过期 Agent 分析报告（`expires_at < NOW()`） |
| 03:00 | 知识图谱/其他 | — |
| 03:00 | 风口龙头分析 | WindLeaderAnalyzerService（空结果不覆盖旧数据） |
| 04:30 | 十字评分批量 | TenxBatchService |
| 08:00 | 数据预热 | — |
| 09:30-15:05 | 机构调研检测 | 交易日 6 个时段（开盘/上午/午前/午盘/尾盘/收盘） |
| 15:00 | 数据归档 | — |
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
