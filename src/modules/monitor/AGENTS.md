# monitor 监控模块

## 功能
趋势风口、风口龙头、新闻、业绩预测、十字评分、AI 知识图谱、行业知识图谱、个股-板块映射、股票同步、共振检测。

## 对外接口（路由）
- `GET /api/cn/trend-hotspots/events` — 趋势风口列表
- `GET /api/cn/trend-hotspots/stats` — 趋势风口统计
- `GET /api/cn/wind-leaders` — 风口龙头
- `POST /api/cn/hot-keywords/detect` — 热词检测
- `GET /api/news/*` — 新闻接口
- `GET /api/cn/stocks/profit-forecast` — 业绩预测
- `GET /api/cn/stocks/tenx-score/*` — 十字评分
- `GET /api/aigraph/*` — AI 知识图谱
- `GET /api/kg/*` — 行业知识图谱

## 核心文件
- `controller.ts` — StockMonitorController（趋势风口）
- `windLeaderController.ts` — 风口龙头/机构调研/热词
- `newsController.ts` — 新闻
- `profitForecastController.ts` — 业绩预测
- `tenxScoreController.ts` — 十字评分
- `aiGraphController.ts` / `industryKGController.ts` — 知识图谱
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
- 风口龙头分析使用 `WindLeaderAnalyzerService`，每天凌晨 3 点定时执行
- 机构调研推荐使用 `HotBurstService`，交易日多次检测
- 十字评分批量任务由 cron 调度（凌晨 4 点）
- 业绩预测自动更新由 cron 调度（凌晨 0 点）
