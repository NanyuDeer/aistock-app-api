# AGENTS.md - aistock-app-api

> 本文件是 AI Agent 的入口地图，开发者与 AI 对话前必读

## 项目概述
AI Stock App 后端，基于 Express + TypeScript，采用模块化架构。

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
│   │   ├── agent.ts        # Agent 路由
│   │   ├── internal.ts     # Internal API（Python Agent 服务专用）
│   │   └── configController.ts # 配置接口
│   └── ws/                 # WebSocket 服务
│       ├── handler.ts      # 连接管理 + 事件分发
│       └── channels/       # 频道（alert/chat/quote）
├── modules/
│   ├── quote/              # 行情模块
│   │   ├── controller.ts   # StockQuoteController
│   │   ├── indexController.ts # IndexQuoteController
│   │   ├── capitalFlowController.ts # CapitalFlowController
│   │   ├── tagLeaderController.ts # TagLeaderController
│   │   ├── analysisController.ts # StockAnalysisController
│   │   ├── stockListController.ts # StockListController
│   │   ├── TencentQuoteService.ts # 腾讯行情
│   │   ├── TencentKlineService.ts # 腾讯 K 线
│   │   ├── TushareQuoteService.ts # Tushare 行情
│   │   ├── TushareKlineService.ts # Tushare K 线
│   │   ├── TushareService.ts # Tushare 基础服务
│   │   ├── TushareCapitalFlowService.ts # Tushare 资金流向
│   │   ├── TushareTagLeaderService.ts # Tushare 龙头
│   │   ├── SinaMoneyFlowService.ts # 新浪资金流
│   │   ├── StockAnalysisService.ts # 股票分析
│   │   ├── EmTagLeaderService.ts # EM 板块龙头
│   │   └── AGENTS.md
│   ├── agent/              # Agent 智能体模块
│   │   ├── orchestrator.ts # Agent 调度器
│   │   ├── agents/         # Agent 实现
│   │   ├── skills/         # 可插拔 Skills + 注册中心
│   │   ├── prompts/        # 提示词模板
│   │   ├── services/       # Agent 服务层
│   │   └── AGENTS.md
│   ├── push/               # 推送模块
│   │   ├── controller.ts   # PotentialStockPushController
│   │   ├── wechatEventController.ts # 微信事件
│   │   ├── MessagePushService.ts # 消息推送
│   │   ├── WechatPushService.ts # 微信推送
│   │   └── AGENTS.md
│   ├── auth/               # 认证模块
│   │   ├── controller.ts   # AuthController（微信登录）
│   │   ├── scanLoginController.ts # 扫码登录
│   │   ├── feishuAuthController.ts # 飞书授权
│   │   ├── userController.ts # 用户管理
│   │   ├── feishuMessageController.ts # 飞书消息
│   │   └── AGENTS.md
│   ├── monitor/            # 监控模块
│   │   ├── controller.ts   # StockMonitorController（趋势风口）
│   │   ├── windLeaderController.ts # 风口龙头
│   │   ├── newsController.ts # 新闻
│   │   ├── profitForecastController.ts # 业绩预测
│   │   ├── tenxScoreController.ts # 十字评分
│   │   ├── aiGraphController.ts # AI 知识图谱
│   │   ├── industryKGController.ts # 行业知识图谱
│   │   ├── service.ts      # StockMonitorService
│   │   ├── WindLeaderService.ts
│   │   ├── HotBurstService.ts
│   │   ├── ThsService.ts
│   │   ├── TenxScoreService.ts
│   │   ├── IndustryKGService.ts
│   │   ├── AiGraphService.ts
│   │   └── AGENTS.md
│   └── crawler/            # 爬虫模块
│       ├── controller.ts   # StockInfoController
│       ├── judgementController.ts # 研判管理
│       ├── ocrController.ts # OCR
│       ├── StockInfoService.ts
│       ├── StockInfoPushService.ts
│       ├── StockOcrService.ts
│       ├── services/       # 爬虫子服务
│       └── AGENTS.md
```

## 开发规范

### 1. 模块规范
- 每个模块有独立的 `AGENTS.md`，说明功能、接口、依赖
- 模块间通过 `../模块名/文件` 引用，禁止循环依赖
- 新增功能优先归入已有模块，必要时新建模块

### 2. Skills 开发规范
- 每个 Skill 必须实现 `Skill` 接口（见 `modules/agent/skills/types.ts`）
- **必须复用现有 services**，禁止重复实现数据获取逻辑
- 在 `modules/agent/skills/registry.ts` 中注册新 Skill
- 参数必须定义 Schema

### 3. Agent 开发规范
- 每个 Agent 必须实现 `Agent` 接口
- Agent 的 `handle` 方法应为 AsyncGenerator（流式输出）
- 提示词放在 `modules/agent/prompts/` 目录

### 4. 路由规范
- Agent 相关路由统一前缀 `/api/agent/`
- 新增路由在 `core/routes/` 中添加
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

## AI 开发工作流

> 工作流由 .trae/rules/aistock-workflow.md 定义，AI 自动执行 9 步流程：上下文加载→需求确认→编码→跨端同步检查→验证→文档维护→用户验收→技能缺口记录→修改记录。

### 小任务自动执行规则
修 bug、改配置、改接口等意图明确的任务，无需等待用户确认，直接执行后说明改了什么。

## 参考文档
- 架构设计: ../AI投资App架构设计文档.md
- Harness 体系: ../Harness架构设计文档.md
