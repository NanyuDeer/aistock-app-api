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
- `POST {AGENT_PY_URL}/api/agent/internal/predictions/from-stock-info` — 个股情报入环转发（Node→Python 内部调用，非本模块对外路由）

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
- `services/StockInfoPredictionService.ts` — 个股情报入环候选聚合（当日最强口径） + 转发 agent-py（不做门槛/映射/due_dates，fail-safe；符号经 `shared/utils/stock.ts#normalizeStockSymbol` 与写库侧同口径归一）

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
- 个股情报入环：**在研判落库成功后触发**（`StockInfoService.upsertJudgements` 末尾挂 `StockInfoPredictionService.ingest`），fail-safe 任何异常只 `console.warn`，**不阻断研判落库**。
- 转发响应处理（**不得把映射失败当正常降级**）：agent-py 返回 `{status, reason_code, reason, record}`；**仅** `status='skipped'` 且 `reason_code='below_threshold'`（门槛未达）静默，`invalid_input` / `unmapped_value` / 缺失或未知 `reason_code` 一律 `console.warn`（带 `symbol`/`reason_code`/`reason`）；非 2xx / 网络异常 / 解析失败 / `saved` 但 `record` 为空亦告警。任何情况都不抛。
- 入环记录 `source_type='stock_info'`、`source_id=stock_info:{symbol}:{published_date}`（`published_date` = `published_at` 的上海自然日）。
- **入环门槛唯一判定点在 agent-py**（`meets_entry_threshold`）；app-api 只做候选聚合与转发，**不得实现门槛**（候选 SQL 的 `CASE ... ORDER BY` 只是"当日最强口径"排序，非门槛）。
- `due_dates` 只由 agent-py `_compute_due_dates` 产出，app-api 侧**不得引入第二套交易日历**。
- app-api 侧交易日判定以 `trading_calendar` 表为准（Tushare `trade_cal` / `exchange=SSE` 刷新，见根 `AGENTS.md` §6.5）；与 agent-py 的 `chinese_calendar` **尚未统一**（另立 spec）。两套口径并存期间，跨服务交易日结论以各自事实源为准，勿互相假定一致。
- **不得恢复 `stock_info_judgements.forecast` 列或前端预判区**（迁移 022 已删该列；P2 入环统一走 `prediction_records`）。

### 2026-09-03 更新：资讯 forecast 回写端点——已于 2026-09-13 移除

> 以下内容已在迁移 022 中删除：
>
> - `PATCH /internal/stock-info/judgements/:id/forecast` 端点已删除。
> - `StockInfoService.upsertJudgementForecast(id, slot, forecast)` 已删除。
> - `stock_info_judgements` 的 `forecast JSONB` 列已由迁移 `022_drop_forecast.sql` 删除。
