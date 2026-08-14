# monitor 监控模块

## 功能
个股异动监控、风口龙头、新闻、业绩预测、趋势股评分（含60日均线剔除）、AI 知识图谱、行业知识图谱、个股-板块映射、股票同步、共振检测。

## 对外接口（路由）
- `GET /api/cn/stock-monitors/events` — 个股异动列表
- `GET /api/cn/stock-monitors/events/:stockCode` — 指定股票异动事件
- `GET /api/cn/stock-monitors/stats` — 个股异动统计
- `GET /api/cn/wind-leaders` — 风口龙头
- `GET /api/cn/wind-leaders/board-kline` — 板块日 K 线（同花顺 bk_ 源，近 N 日默认 120）
- `POST /api/cn/hot-keywords/detect` — 热词检测
- `GET /api/news/*` — 新闻接口
- `GET /api/cn/stocks/profit-forecast` — 业绩预测
- `GET /api/cn/stocks/trend-score/*` — 趋势股评分
- `GET /api/aigraph/*` — AI 知识图谱
- `GET /api/kg/*` — 行业知识图谱

## 核心文件
- `controller.ts` — StockMonitorController（个股异动监控）
- `windLeaderController.ts` — 风口龙头/机构调研/热词
- `newsController.ts` — 新闻
- `profitForecastController.ts` — 业绩预测
- `trendScoreController.ts` — 趋势股评分（S/A/B/C/D 评级 + 60日均线剔除）
- `TrendBatchService.ts` — 趋势股批量评分（cron 凌晨2点）
- `FeishuMessageAiService.ts` — 领取待处理飞书消息、调用千问并生成按股票关联的关键词
- `TenxScoreService.ts` — 评分基础设施（共享计算函数，被 TrendScoreService 依赖；十倍股独立模块已下线）
- `aiGraphController.ts` / `industryKGController.ts` — 知识图谱
- `RotationBoardStore.ts` — 板块轮动榜持久化（同花顺板块指数日线法，网页"板块轮动表"同款口径；每日涨/跌前10 落库 `board_rotation_daily`，供风口龙头与趋势股评分读取）；`fetchBoardKline` 按需拉取单板块日 K 线（OHLC，1h 缓存）
- 对应 Service 文件

## 依赖的 shared 类型
- `shared/types/cache` — 缓存键定义
- `shared/utils/CacheService` — Redis 缓存
- `shared/utils/*` — 各种工具函数
- `core/db` — 数据库连接

## 跨模块依赖
- `modules/quote/TushareService` — Tushare API 基础服务
- `modules/quote/TencentQuoteService` — 行情数据
- `modules/quote/TencentKlineService` — K 线数据
- `modules/quote/SinaMoneyFlowService` — 资金流向
- `modules/crawler/FeishuResearchReportService` — 飞书研报
- `modules/crawler/TushareInfoService` — 股票信息
- `modules/crawler/StockInfoService` — 股票信息（研判）

## 开发注意事项
- 行业知识图谱（`IndustryKGService`）：
  - 行业上下游边由 AI 批量生成（`buildAIEdges`，每批 20 行业）+ **专家人工修正表**（`EXPERT_INDUSTRY_RELATIONS`，按行业名精确匹配，约 90 个热门行业权威上下游）双重保障；`applyExpertEdges` 幂等覆盖 AI 边，缓存命中与重新生成统一生效
  - 缓存 TTL 修复：full_graph.json 的过期判断用缓存内部 `updateTime` 而非文件 mtime（mtime 会被龙头股后台加载重写刷新，导致永不更新）；`rebuild(force)` 支持强制跳过 ai_edges 缓存
  - AI prompt 明确：881xxx 为二级行业、884xxx 为三级细分，严禁把并列/细分-父级/服务外包当上下游
- 风口龙头分析使用 `WindLeaderAnalyzerService`，每天凌晨 3 点定时执行（全行业覆盖，不再筛选AI板块）；轮动窗口 120 天（`LONG_WINDOW`），数据源为 `RotationBoardStore` 落库的板块轮动榜（每日涨/跌前10，网页同款口径），板块区分 cycle=short（短线）/long（长线，月线多头排列且同比环比向上确认）；轮动榜每日 15:35 收盘后增量同步、启动时自动回填
- 风口榜单会出现行业板块（881xxx）：行业板块不走"概念→行业"映射（`mapConceptToIndustries`），改走 `mapIndustryToChain` 直接从知识图谱取行业上下游（`getUpstreamDownstreamByName`，失败返回空不阻塞）；前端 WindLeaderPanel 流向图支持无 related 节点的行业板块布局
- 龙头股爬取必须经 `isValidStockCode`/`isValidStockName`/`extractStockCodeFromHref` 校验：同花顺概念页新闻链接（`news.10jqka.com.cn/20260805/...`）URL 中日期 `202608` 会被旧正则 `/(\d{6})/` 误当股票代码、新闻标题被当股票名（曾污染 leading_stock 如"概念细分|玻璃基板…"）；`extractLeadingStock` 爬取失败时回退 main_stocks 评分最高者补全 code/价格（行业板块 881xxx 无概念页龙头结构）
- 推送历史在交易日 15:30 后执行收盘结算，并通过启动补偿和历史接口读取检测修复漏跑任务。
- 机构调研推荐使用 `HotBurstService`，交易日多次检测
- 飞书消息 AI 任务每分钟执行一次；仅处理正文/OCR非空且已有候选股票代码的消息，失败不自动重试
- 趋势股批量评分由 cron 调度（凌晨 2 点），含60日均线剔除规则（连续两日跌破60日线→从Top列表剔除）
- 业绩预测自动更新由 cron 调度（凌晨 0 点）
