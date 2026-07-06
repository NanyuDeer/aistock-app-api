# quote 行情模块

## 功能
提供 A 股实时行情、K 线、资金流向、个股信息、龙头股、股票分析等查询接口。

## 对外接口（路由）
- `GET /api/cn/stock/quotes/core` — 核心行情
- `GET /api/cn/stock/quotes/realtime` — 实时行情
- `GET /api/cn/stock/quotes/activity` — 活跃行情
- `GET /api/cn/stock/quotes/kline` — K 线数据
- `GET /api/cn/stock/fundamentals` — 基本面行情
- `GET /api/cn/index/quotes` — A 股指数行情
- `GET /api/gb/index/quotes` — 全球指数行情
- `GET /api/cn/stocks/:symbol/capital-flow` — 个股资金流向
- `GET /api/cn/tags/:tagCode/leaders` — 板块龙头
- `GET /api/cn/stocks/:symbol/analysis` — 个股分析
- `GET /api/cn/stocks` — 股票列表
- `GET /api/cn/stock/infos` — 批量个股信息

## 依赖的 shared 类型
- `shared/types/cache` — 缓存键、TTL 配置
- `shared/utils/CacheService` — Redis 缓存
- `shared/utils/validator` — A 股代码校验
- `shared/utils/response` — 统一响应
- `shared/utils/tradingTime` — 交易时间判断
- `shared/utils/httpAgent` — HTTP 会话复用
- `shared/utils/stock` — 股票代码身份识别
- `shared/utils/throttle` / `throttlers` — 限流

## 跨模块依赖
- `modules/monitor/ThsService` — 同花顺数据（分析用）
- `modules/monitor/ClsStockNewsService` — 财联社新闻
- `modules/monitor/TenxScoreService` — 十字评分

## 内部子模块
- `analysis-agent/` — 个股分析 Agent 工具（tools/prompts/types）

## 开发注意事项
- 行情数据必须使用腾讯行情 API，禁止东方财富
- 龙头股数据来自同花顺/Tushare
- K 线数据来自 Tushare
- 所有行情接口均支持缓存，使用 CacheService
