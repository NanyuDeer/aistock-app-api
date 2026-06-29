# AGENTS.md - aistock-app-api

> 本文件是 AI Agent 的入口地图，开发者与 AI 对话前必读

## 项目概述
AI Stock App 后端，基于 Express + TypeScript，在现有 API 基础上扩展 Agent + Skills 智能体架构。

## 技术栈
- 框架: Express 5 + TypeScript
- 数据库: PostgreSQL + pgvector（向量检索）
- 缓存: Redis
- WebSocket: ws
- LLM: OpenAI SDK（支持 DeepSeek/OpenAI）
- 定时任务: node-cron

## 目录结构
```
src/
├── index.ts              # 入口：Express + WebSocket 挂载
├── db.ts / redis.ts      # 数据库连接
├── controllers/          # 现有控制器（保持不变）
├── services/             # 现有服务（被 Skills 复用，保持不变）
├── agent/                # 智能体内核（核心新增）
│   ├── orchestrator.ts   # Agent 调度器
│   ├── agents/           # 各 Agent 实现
│   ├── skills/           # 可插拔 Skills
│   │   ├── registry.ts   # 注册中心
│   │   ├── types.ts      # 类型定义
│   │   └── *.ts          # 各 Skill 实现
│   └── prompts/          # 提示词模板
├── routes/               # 路由
│   └── agent.ts          # Agent 相关路由
├── ws/                   # WebSocket 服务
│   └── handler.ts        # 连接管理 + 事件分发
└── utils/                # 现有工具（保持不变）
```

## 开发规范

### 1. Skills 开发规范
- 每个 Skill 必须实现 `Skill` 接口（见 `agent/skills/types.ts`）
- **必须复用现有 services**，禁止重复实现数据获取逻辑
- 在 `registry.ts` 中注册新 Skill
- 参数必须定义 Schema

### 2. Agent 开发规范
- 每个 Agent 必须实现 `Agent` 接口
- Agent 的 `handle` 方法应为 AsyncGenerator（流式输出）
- 提示词放在 `prompts/` 目录

### 3. 路由规范
- Agent 相关路由统一前缀 `/api/agent/`
- 新增路由在 `routes/agent.ts` 中添加
- 必须在 `index.ts` 中挂载

## 常用命令
```bash
pnpm dev      # 开发模式（tsx watch）
pnpm build    # TypeScript 编译
pnpm start    # 生产模式启动
```

## 关键约束
- 行情数据必须使用腾讯行情 API
- 东方财富不允许使用
- 龙头股数据必须来自同花顺
- Skills 必须复用现有 services，禁止重复实现
- 向量检索使用 pgvector，不引入独立向量数据库
- LLM 调用失败时跳过，返回纯数据，不重试（防烧钱）

## 复用现有服务清单
| 服务 | 文件 | 被 Skill 复用 |
|------|------|--------------|
| 腾讯行情 | services/TencentQuoteService.ts | stock_quote |
| 新浪资金流 | services/SinaMoneyFlowService.ts | capital_flow |
| 同花顺 | services/ThsService.ts | leader_stock |
| 飞书研报 | services/FeishuResearchReportService.ts | research_report |
| 知识图谱 | services/IndustryKGService.ts | knowledge_graph |
| 股票监控 | services/StockMonitorService.ts | alert_monitor |

## 参考文档
- 架构设计: ../AI投资App架构设计文档.md
- Harness 体系: ../Harness架构设计文档.md
