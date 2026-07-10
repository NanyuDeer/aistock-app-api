# agent 智能体模块

## 功能
AI 智能体调度器，负责意图识别 → 路由到对应 Agent → 调用 Skills → 生成回复。

## 对外接口（路由）
- `POST /api/agent/chat/message` — 对话消息（非流式）
- `GET /api/agent/skills` — 已注册 Skills 列表
- `GET /api/agent/briefing/morning` — 晨报（开发中）
- `GET /api/agent/briefing/evening` — 晚报（开发中）
- `GET /api/agent/valuation/:symbol` — 动态估值（开发中）

## 核心文件
- `orchestrator.ts` — 调度器：意图识别 + Skill 路由
- `agents/general-agent.ts` — 通用对话 Agent
- `skills/registry.ts` — Skill 注册中心
- `skills/types.ts` — Skill/Agent 类型定义
- `skills/stock-quote.ts` — 个股行情 Skill
- `skills/capital-flow.ts` — 资金流向 Skill
- `skills/leader-stock.ts` — 龙头股 Skill
- `prompts/system.ts` — 系统提示词模板

## 依赖的 shared 类型
- 无直接依赖（通过 Skills 间接使用 shared）

## 跨模块依赖
- `modules/quote/TencentQuoteService` — 行情数据
- `modules/quote/SinaMoneyFlowService` — 资金流向
- `modules/quote/TushareTagLeaderService` — 龙头股
- `modules/monitor/ClsStockNewsService` — 财联社新闻
- `modules/monitor/ThsService` — 同花顺数据

## 开发注意事项
- 新增 Skill 必须在 `skills/registry.ts` 注册
- Skill 必须实现 `Skill` 接口（见 `skills/types.ts`）
- Skill 必须复用现有 services，禁止重复实现数据获取逻辑
- Agent 的 `handle` 方法应为 AsyncGenerator（流式输出）
