# Stock Trace module

This module owns event-scoped stock-movement trace facts, snapshots, jobs, validated results, and artifacts.

### 2026-08-15 更新：价格异动触发接入 + 五域证据采集

- **价格异动触发接入**：`PriceMoveService`（insight 模块）的 11:30/15:05 打点触发改接本模块事件层（`emitStockTraceEvent`），使用 `mv` 事件类型，经由 `isEligiblePriceSecurity` 过滤非 A 股/ST/退市，阈值改为 `changePct`（原 `moveBps` 映射）。11:50 补抓 cron 已停用。
- **五域证据采集**：`StockTraceSnapshotService` 扩展为五域采集——company（统一事件库优先，回落同花顺/财联社，T-72h 窗口）、sector（板块行情）、market（大盘指数）、capital（资金流向，新增）、technical（技术指标，新增，T-72h 窗口）。

### 2026-08-19 更新：列表接口归因状态派生

- `listUserEvents` / `listRecentEvents` 的 `analysis_status` 改为 SQL 派生（LEFT JOIN LATERAL artifact + 最新 result），与详情接口 `presentStockTraceAnalysis` 一致：有 effective artifact → `completed`；最新 result rejected/failed → `unavailable`；其余 → `processing`。不再硬编码 `pending`。

### 2026-08-19 更新：主因短语 primary_phrase / primary_cause

- `StockTraceResult` 新增 `primaryPhrase`（可选）；`stock_trace_results` 表新增 `primary_phrase VARCHAR(24) NOT NULL DEFAULT ''` 列（LLM 生成的 ≤20 字简短主因短语，供列表/卡片展示；无确立主因时给出简短结论如"证据不足"）。
- `ExternalResultInput` 新增 `primary_phrase?: string`，`acceptExternalResult` / `persist` / `getBySnapshot` 均支持该字段读写。
- `listUserEvents` / `listRecentEvents` 的 LATERAL JOIN 增选 `rr.primary_phrase AS primary_cause`，items 映射为 `primary_cause`（无短语时为 `null`），前端卡片据此显示"主因：xxx"。

### 2026-08-20 更新：归因失败回退上一版有效归因

- 列表接口（`listUserEvents` / `listRecentEvents`）的 artifact LATERAL 不再限定 `s.trigger_revision = current_trigger_revision`，改为取该事件最近 effective 的 artifact（`ORDER BY artifact_version DESC`）；`primary_cause` 从该 artifact 对应 result 的 `primary_phrase` 取（而非当前版本最新 result）。效果：最新版本归因失败（rejected/failed）时，仍展示历史版本已通过的有效归因（`completed`），避免"有异动却看不到归因"。
- 详情接口（`controller.ts presentEventAnalysis`）：当前版本无 artifact 且最新 result 被拒/失败时，回退调用 `StockTraceArtifactService.getEffectiveArtifact(eventId)` 展示最近有效归因。

### 2026-08-20 更新：PriceTriggerDetector 行情级别修复

- `PriceTriggerDetector.detect` 拉行情原用 `'core'` 级别，但 `CORE_FIELDS` 不含"昨收价"，导致 `previousClose` 恒为 undefined → 所有股票在阈值分支被跳过，**实时检测链路从未真正触发过**。已改为 `'activity'` 级别（含昨收价/今开价）。排查手法：`getBatchQuotes(symbols, 'core')` 实测返回只有 股票代码/简称/最新价/行情时间/涨跌幅 五字段。

- `StockTraceJobService` writes a PostgreSQL job and transactional Outbox before publishing to Redis Stream `stock-trace.jobs`.
- Stream messages contain `job_id`, `event_id`, `trigger_revision`, `analysis_version`, and `job_kind` only; never include user data or source content.
- Redis publish failure must leave the Outbox record pending and must not affect TriggerEvent persistence or the initial alert.
- Python Workers consume jobs idempotently. They may only read Node Stock Trace context by `event_id` / `snapshot_id` and must not fetch A-share sources directly.
- User APIs remain in `controller.ts`; Python-facing routes remain in `internalRouter.ts` and require `X-Internal-Token`.
- Company-context evidence is read from the unified event store first (`loadEventStoreEvidence` → Python `GET /api/agent/event/scrape-by-symbol/:symbol?date=当日`, via `AGENT_PY_URL || PYTHON_AGENT_URL` + `X-Internal-Token`, Shanghai-today date); on empty/miss/failure `collectCompanySources` falls back to the original CLS stock news + stock-info announcement collection (2026-08-12).
