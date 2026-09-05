# 阶段 2 实施计划 — 自选股洞察定时轻量预判（forecast slot 落库）

> 日期：2026-09-03
> 上游设计：微信 `2026-08-31-自选股洞察升级-事件统一与两次打点-design.md` §4.2/§4.3（阶段 2）
> 已确认决策（2026-09-03 AskUserQuestion）：**双 cron 触发（11:40 + 15:20）**；**仅重大资讯股 forecast 落 `stock_info_judgements.forecast`（与文档一致）**
> 前置已完成（08-30）：涨停雷达并入 stock-trace（事件统一/归因唯一/insight_article 证据域）——即设计文档阶段 1
> 涉及仓库：aistock-app-api（Node）、aistock-agent-py（Python）

## 目标（阶段 2 验收口径）

两次打点后，对"当日异动/涨停 ∪ 当日重大利好/利空"的自选股（去重）批量生成条件化轻量预判（quick_think 单次 + json_mode → `conditions[]`），按 slot 分存：
- 有 `stock_trace` 异动事件（含交集）→ 写 `stock_trace_events.forecast`（slot 键 `midday`/`close`）
- 仅重大资讯（无事件）→ 写 `stock_info_judgements.forecast`（当日该股最后一条重大资讯行）
- slot 互不覆盖（幂等 upsert：`forecast || jsonb_build_object(slot, $val)`）

## 数据契约

### 事件表 `stock_trace_events` 加列（幂等）
- `is_limit_up BOOLEAN NOT NULL DEFAULT FALSE`：涨停标记，仅由涨停雷达文章命中（`runCycle` → `processPriceFact` fact `isLimitUp:true`）置 true；行情打点不猜板阈值（ST/创板/主板阈值各异、行情无涨停价字段，留 `change_pct` 由前端按板展示）
- `forecast JSONB NOT NULL DEFAULT '{}'`：slot 结构 `{ "midday"?: {...}, "close"?: {...} }`，value = 轻量预判摘要（见下）

### 轻量预判摘要结构（forecast value，schema_version=1）
```json
{
  "schema_version": "1",
  "scenario": "trace|intel",
  "summary": "1-2 句条件化摘要",
  "conditions": [{"condition": "...", "scenario": "...", "anchor": {"horizon": "short|mid", "threshold": "+5%", "metric": "close|volume", "direction": "bullish|bearish|neutral"}}],
  "generated_at": "ISO8601",
  "slot": "midday|close"
}
```
（对应 agent-py `PredictionResult`（`conditions[]`）序列化子集）

### internal 端点（均带 X-Internal-Token）
| 方法+路径 | 位置 | 说明 |
|---|---|---|
| `GET /internal/stock-trace/light-predict-targets?trade_date=` | stock-trace internalRouter | 跨用户当日候选聚合（自选股异动 ∪ 重大资讯，symbol 去重）；返回 `[{symbol, stock_name, event?:{event_id, direction, change_pct, severity, analysis_status, primary_cause, is_limit_up}, intel?:[{id,title,ai_summary,ai_impact,published_at}]}]` |
| `PATCH /internal/stock-trace/events/:eventId/forecast` | stock-trace internalRouter | body `{slot:'midday'\|'close', forecast:{...}}`；slot 级 upsert（不覆盖另一 slot）；事件不存在 404 |
| `PATCH /internal/stock-info/judgements/:id/forecast` | crawler internalRouter（新建） | 同上 slot upsert 写情报表 |

## Task 拆分

### Task 1（app-api）：事件表加列 + 读层带出 + is_limit_up 接入
- `src/db/migrations/018_stock_trace_forecast.sql`：两列幂等 ADD + 索引 `idx_stock_trace_events_trade_date`（(trading_date, event_status)）
- `StockTraceService.createSchema` DDL 同列 + `EventRow`/创建分支 INSERT 列同步；`processPriceFact` 创建分支写 `is_limit_up`（来自 `fact.isLimitUp`）；`types.ts` `PriceFact` 加可选 `isLimitUp?: boolean`
- `InsightService.radarHitToPriceEvent` 构造 PriceFact 加 `isLimitUp: true`
- `listUserEvents`/`listRecentEvents` SELECT + 映射带出 `is_limit_up`、`forecast`
- 测试：迁移文件存在性断言可省；`is_limit_up`/`forecast` 列带出依赖 DB —— 以 internal 端点测试覆盖（见 Task 2）

### Task 2（app-api）：internal 端点
- stock-trace internalRouter 新增 `GET /light-predict-targets`（SQL：事件侧 `stock_trace_events e JOIN user_stocks us` 按 `trading_date` + `event_status IN ('active','closed')` 取 symbol 当日主事件（最新 first_triggered_at），primary_cause 经 LATERAL artifact/result 取；资讯侧 `stock_info_judgements j JOIN user_stocks us` 当日重大（`ai_impact IN ('重大利好','重大利空')`）多行；内存按 symbol 归并去重）+ `PATCH /events/:eventId/forecast`（slot 级 upsert SQL + 404）
- 新建 `src/modules/crawler/internalRouter.ts` + index.ts 挂载 `/internal/stock-info`：`PATCH /judgements/:id/forecast`（slot upsert，judgement 不存在 404）；`StockInfoService.ensureSchema` DDL 加 `forecast` 列（幂等）；迁移文件同样补 ALTER（放 018）
- 测试（node:test + mock pool.query 断言 SQL/参数）：light-predict-targets（事件+资讯归并/重大过滤/日期过滤）、forecast upsert（slot 不覆盖 / 404 / slot 非法 400）、crawler forecast upsert

### Task 3（agent-py）：NodeApiClient 扩展
- data_client.py 新增：`list_light_predict_targets(trade_date)`（GET）、`set_event_forecast(event_id, slot, forecast)`（PATCH）、`set_judgement_forecast(judgement_id, slot, forecast)`（PATCH）、`get_quote(symbol)`（GET /internal/quote/:symbol）、`get_stock_flow(symbol)`（GET /internal/flow/:symbol）

### Task 4（agent-py）：light_predictor + prompt + 调度
- 新增 `prompts/workers/light_predict.py`：`PREDICTION_LIGHT_PROMPT`（scenario A 归因驱动+事件补充 / scenario B 事件影响；conditions 2-3 条含 anchor，≥1 条含成交量维度；只引用输入给定信息、禁止编造）
- 新增 `services/light_predictor.py`：
  - `assemble_features(target, slot)`：event 归因（primary_cause + movement 摘要，analysis_status='completed' 才有）+ intel（标题/摘要/ai_impact）+ 盘口（quote 最新价/涨跌幅 + kline 5/10/20 均线/20日高低/近5日成交额 + flow 主力净额）；deterministic，零 LLM
  - `run_light_prediction(slot)`：`shanghai_today` → targets → 逐 symbol `assemble→get_quick_think()+with_chat_structured_output(llm, PredictionResult)→校验（conditions 非空、anchor 含 horizon+threshold）→回写（有 event 写 event forecast，仅 intel 写 judgement forecast）`；单只失败 warning 跳过不阻断；空 targets 直接 0
- `config.py`：`scheduler_light_predict_midday_cron="40 11 * * 0-4"`、`scheduler_light_predict_close_cron="20 15 * * 0-4"`
- `scheduler.py`：`add_job` 两条（`light_predict_midday`/`light_predict_close`）→ `_run_light_predict_task('midday'|'close')`
- 测试（pytest，mock node_api + structured output）：空 targets→0；event-only（completed）→ 回写 event forecast（slot=close）；intel-only→ 回写 judgement forecast；交集→ 写 event forecast（primary_cause 驱动）；conditions 空→跳过不落库；close 不触碰 midday（slot 参数断言）；assemble 纯函数（无归因时降级用 event 基本信息）

### Task 5：验证
- app-api：`npx tsc --noEmit` + `node --import tsx --test` 相关 spec
- agent-py：`.venv311` pytest（light_predictor/scheduler/config 相关）
- 端到端契约核对：Node 端点返回字段与 agent-py client 解析一致（spec 断言）

## 风险/边界
- 午盘（11:40）场景 A 大多无归因（11:30 打点事件未 settle）→ 午盘 forecast 以 intel/事件基本信息生成先行版；close（15:20）settle+归因完成出终版（前端阶段 3 按 close 优先展示）
- 涨停判定仅文章来源（is_limit_up），行情打点不标注——若后续需"收盘涨停"精确标记，另行接 Tushare limit_list（需 8000 积分，留待候选）
- 验证画像降档（Spec B `read_validation_profile`）与 `light_predict` 通道落 `prediction_records` 均不在本阶段（文档标"可选/闭环"），后续 Spec C/阶段 5 接入

## 文档
- 同步：app-api `src/modules/stock-trace/AGENTS.md`（internal 端点表 + 事件表字段）、`src/modules/crawler/AGENTS.md`（internal 端点）、agent-py `src/aistock_agent/AGENTS.md`（light_predict 任务 + services/prompts 登记）、两仓 CHANGELOG.md、project_memory.md（light_predict 契约 + 时序决策）
