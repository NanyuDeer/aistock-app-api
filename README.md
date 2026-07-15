# AI Stock App 后端

> AI 投资助手 App 后端，基于 Express + TypeScript。
>
> **AI 开发助手请先阅读 [AGENTS.md](./AGENTS.md)** — 模块架构地图、开发规范、硬约束、降级策略和跨服务协作契约。本 README 面向人类开发者，介绍项目全貌、快速开始和部署。

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式（tsx watch 热重载）
pnpm dev

# TypeScript 编译
npx tsc --noEmit

# 生产模式
pnpm build && pnpm start
```

### 环境变量
复制 `.env.example` 为 `.env`，填入以下配置：
- `DATABASE_URL` — PostgreSQL 连接串
- `REDIS_URL` — Redis 连接串
- `WECHAT_APPID` / `WECHAT_SECRET` — 微信公众号配置
- `JWT_SECRET` — JWT 签名密钥
- `OPENAI_API_KEY` — LLM API 密钥（DeepSeek/OpenAI）
- `AGENT_PY_URL` — Python Agent 服务地址（默认 `http://localhost:8000`，Phase 5）
- `INTERNAL_API_TOKEN` — 内网鉴权 Token（`/internal/*` 接口校验，Phase 5）

本地开发无数据库时，服务自动进入降级模式（使用内存缓存和 mock 数据）。

## 技术栈

- 框架: Express 5 + TypeScript
- 数据库: PostgreSQL + pgvector（向量检索）
- 缓存: Redis
- WebSocket: ws
- LLM: OpenAI SDK（支持 DeepSeek/OpenAI）
- 定时任务: node-cron

## 项目架构

### 三层模块化设计

```
src/
├── index.ts                # 入口：Express + WebSocket 挂载 + cron 调度
├── shared/                 # 共享层（组长维护）
│   ├── types/              # 全局类型定义
│   │   └── cache.ts        # 缓存键、TTL 配置、类型
│   └── utils/              # 工具函数 + 共享服务
│       ├── CacheService.ts # Redis 缓存服务
│       ├── TradingCalendarService.ts # 交易日历
│       ├── jwt.ts          # JWT 签发/验证
│       ├── response.ts     # 统一响应格式
│       ├── validator.ts    # A 股代码校验
│       ├── tradingTime.ts  # 交易时间判断
│       ├── httpAgent.ts    # HTTP 会话复用
│       ├── stock.ts        # 股票代码身份识别
│       ├── throttle.ts     # 限流器
│       ├── throttlers.ts   # 预定义限流器
│       ├── datetime.ts     # 时间格式化
│       ├── parser.ts       # HTML 表格解析
│       ├── crawler.ts      # 爬虫工具
│       └── query.ts        # 查询工具
├── core/                   # 基础设施（组长维护）
│   ├── db.ts               # PostgreSQL 连接池
│   ├── redis.ts            # Redis 连接
│   ├── routes/             # 路由注册
│   │   ├── internal.ts     # Internal API（Python Agent 服务专用）
│   │   └── configController.ts # 配置接口
│   └── ws/                 # WebSocket 服务
│       ├── handler.ts      # 连接管理 + 事件分发
│       └── channels/       # 频道（alert/quote）
├── modules/                # 业务模块层（每人负责一个模块）
│   ├── quote/              # 行情模块
│   ├── push/               # 推送模块
│   ├── auth/               # 认证模块
│   ├── monitor/            # 监控模块（异动/风口/十倍股/知识图谱/机构调研）
│   ├── crawler/            # 爬虫模块
│   └── agent/              # Agent 反代模块（Phase 5）
│       ├── agent.proxy.ts  # /api/agent/* → Python FastAPI 反向代理（SSE 透传）
│       └── __tests__/      # 代理测试（JSON 转发 + SSE 流式 + 502 + 流错误）
```

### 模块负责人

| 模块 | 目录 | 功能范围 |
|------|------|---------|
| 行情 | modules/quote | 腾讯行情、K线、指数、个股分析 |
| 推送 | modules/push | 微信模板消息、定时推送 |
| 认证 | modules/auth | 扫码登录、微信授权 |
| 监控 | modules/monitor | 股票异动监控、风口龙头、十倍股评分、知识图谱、机构调研热门股 |
| 爬虫 | modules/crawler | 数据爬取、OCR、资讯研判 |
| Agent | modules/agent | `/api/agent/*` 反代到 Python FastAPI（SSE 透传 + 502 降级） |

## 开发规范

> 完整开发规范见 [AGENTS.md](./AGENTS.md)，包括模块依赖规则、新增模块/路由/Internal API 流程、硬约束和降级策略。以下为速览。

### 模块依赖规则
- ✅ modules/* → shared/（允许）
- ❌ modules/A → modules/B（禁止）
- ✅ core/ → shared/（允许）
- ✅ core/ → modules/*（仅路由注册时）

### 模块规范
- 每个模块有独立的 `AGENTS.md`，说明功能、接口、依赖
- 模块间通过 `../模块名/文件` 引用，禁止循环依赖
- 新增功能优先归入已有模块，必要时新建模块

## API 路由

| 路径 | 功能 |
|------|------|
| `/api/cn/stock-quote/*` | 行情接口 |
| `/api/cn/wind-leaders` | 龙头股接口 |
| `/api/cn/trend-hotspots/*` | 重磅消息接口 |
| `/api/auth/wechat/*` | 微信认证接口 |
| `/api/agent/*` | 反代到 Python FastAPI（SSE 流式透传，注入 X-Internal-Token；配置 `AGENT_PY_URL`，默认 `http://localhost:8000`） |
| `/api/agent/event/list` | **事件传导报告列表**（公开，分页） | page, pageSize |
| `/api/agent/event/:eventId` | **事件传导报告详情**（公开，完整 analysis_reports） | eventId |
| `/internal/*` | Python Agent 服务专用内部接口（需 X-Internal-Token） |
| `/internal/health` | 轻量健康探针（无需 token，供 Python `/health/ready` 探测） |

### Internal API 接口详情

| 路径 | 功能 | 参数 |
|------|------|------|
| `/internal/quote/:symbol` | 个股实时行情（腾讯数据源） | symbol: A股代码 |
| `/internal/flow/:symbol` | 个股资金流向（新浪+Tushare双源） | symbol: A股代码 |
| `/internal/leader/:tagCode` | 板块龙头股（Tushare数据源） | tagCode: 板块代码（如BK0475） |
| `/internal/news/search/:symbol` | 财联社个股相关新闻 | symbol: A股代码, limit: 返回数量 |
| `/internal/news/latest` | 财联社最新快讯 | limit: 返回数量 |
| `/internal/news/fulltext/:id` | 财联社新闻全文 | id: 新闻ID |
| `/internal/forecast/:symbol` | 机构盈利预测（同花顺数据源） | symbol: A股代码 |
| `/internal/wind-leaders` | **长线风口数据**（供Python Agent调用） | limit: 返回板块数量（默认8，最大20） |
| `/internal/institution-research` | **机构调研热门股**（供Python Agent调用） | hours: 最近N小时（默认6，最大72）, min_resonance: 最小共振数 |
| `/internal/monitor/:symbol` | **个股监控事件**（供团队成员使用） | symbol: A股代码, cycle: 周期, limit: 返回数量 |
| `/internal/analysis-reports` | **Agent 分析报告持久化**（POST upsert） | report_type, report_date, content(JSONB), user_id?, event_id?(event_conduction必填，复用 user_id 列做隔离), expires_at? |
| `/internal/analysis-reports/:type/:date` | **查询报告**（按类型+日期） | type: morning/wind_leader/hot_burst/review/event_conduction, date: YYYY-MM-DD |
| `/internal/analysis-reports/:type/:date/:userId` | **查询用户专属报告** | userId: 用户ID |
| `/internal/analysis-reports/cleanup` | **清理过期报告**（DELETE，定时03:00） | — |
| `/internal/briefing/generate-audio` | **生成双人播报音频**（POST） | date: YYYY-MM-DD，需 X-Internal-Token |

> 新增接口（2026-07-08）：`/internal/wind-leaders`、`/internal/institution-research`、`/internal/monitor/:symbol` 供Python Agent和团队成员调用
>
> 新增接口（2026-07-10）：`/internal/analysis-reports/*` 系列，供 Python Agent 持久化分析报告（scheduler 触发写入，broadcast_agent 读取），建表脚本见 `docs/sql/agent_analysis_reports.sql`
>
> 更新（2026-07-14）：`event_conduction` 加入报告白名单，POST 支持 `event_id` 作为隔离键（复用 `user_id` 列，同日不同事件分别保存、同事件重跑 upsert）；新增公开接口 `GET /api/agent/event/list`（分页列表，返回 eventId/title/source/publishTime/摘要/结论）和 `GET /api/agent/event/:eventId`（详情，返回完整 analysis_reports 含四模块 + event_podcast_brief）

## Vibecoding 工作流

本项目使用 aistock-workflow rules 规范 AI 辅助开发流程。在 Trae IDE 中开发时，AI 自动执行 9 步流程：上下文加载→需求确认→编码→跨端同步检查→验证→文档维护→用户验收→技能缺口记录→修改记录。

详见：[Vibecoding 工作流文档](../docs/vibecoding-workflow.md)

## 部署

```bash
# 编译
npx tsc

# PM2 启动
pm2 start ecosystem.config.json

# 查看日志
pm2 logs aistock-api
```

## 相关项目

- [aistock-app-frontend](../aistock-app-frontend) — App 前端
- [aistock-agent-py](../aistock-agent-py) — Python Agent 推理服务
- [aistock-api](../aistock-api) — 原 PC Web 后端
