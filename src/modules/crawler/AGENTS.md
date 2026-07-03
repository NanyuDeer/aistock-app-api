# crawler 爬虫模块

## 功能
个股资讯爬虫、AI 研判入库、OCR 识别、股票信息查询、推送触发。

## 对外接口（路由）
- `GET /api/cn/stock/infos` — 批量个股信息
- `GET /api/internal/stock-info/targets` — 爬取目标
- `POST /api/internal/stock-info/judgements` — 保存研判
- `POST /api/internal/stock-info/push` — 触发推送
- `GET /api/cn/stock-info/judgements` — 查询研判
- `POST /api/cn/stocks/ocr` — OCR 识别
- `POST /api/internal/crawl/run` — 手动触发爬虫
- `POST /api/internal/crawl/cycle` — 完整爬虫周期

## 核心文件
- `controller.ts` — StockInfoController（批量信息查询）
- `judgementController.ts` — StockInfoJudgementController（研判管理）
- `ocrController.ts` — StockOcrController（OCR 识别）
- `StockInfoService.ts` — 研判数据 CRUD
- `StockInfoPushService.ts` — 自选股异动推送触发
- `StockOcrService.ts` — OCR 服务
- `TushareInfoService.ts` — Tushare 股票信息
- `EmInfoService.ts` / `EmStockRankService.ts` — 东方财富信息（内部使用）
- `FeishuResearchReportService.ts` — 飞书研报
- `services/EastmoneyCrawler.ts` — 东方财富爬虫
- `services/StockInfoCrawlService.ts` — 爬虫调度器
- `services/StockInfoJudgeService.ts` — AI 研判

## 依赖的 shared 类型
- `shared/types/cache` — 缓存键定义
- `shared/utils/CacheService` — Redis 缓存
- `shared/utils/*` — 各种工具函数
- `core/db` — 数据库连接

## 跨模块依赖
- `modules/quote/TushareService` — Tushare API 基础服务
- `modules/push/WechatPushService` — 微信推送
- `modules/push/MessagePushService` — 飞书推送
- `modules/monitor/HotKeywordDetectorService` — 热词检测

## 开发注意事项
- 东方财富不允许对外暴露，仅限内部爬虫使用
- 爬虫调度由 cron 管理（每天 8:00 和 15:00）
- AI 研判使用 LLM，失败时跳过返回纯数据
