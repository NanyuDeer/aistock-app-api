# Stock Trace module

This module owns event-scoped stock-movement trace facts, snapshots, jobs, validated results, and artifacts.

### 2026-08-15 更新：价格异动触发接入 + 五域证据采集

- **价格异动触发接入**：`PriceMoveService`（insight 模块）的 11:30/15:05 打点触发改接本模块事件层（`emitStockTraceEvent`），使用 `mv` 事件类型，经由 `isEligiblePriceSecurity` 过滤非 A 股/ST/退市，阈值改为 `changePct`（原 `moveBps` 映射）。11:50 补抓 cron 已停用。
- **五域证据采集**：`StockTraceSnapshotService` 扩展为五域采集——company（统一事件库优先，回落同花顺/财联社，T-72h 窗口）、sector（板块行情）、market（大盘指数）、capital（资金流向，新增）、technical（技术指标，新增，T-72h 窗口）。

- `StockTraceJobService` writes a PostgreSQL job and transactional Outbox before publishing to Redis Stream `stock-trace.jobs`.
- Stream messages contain `job_id`, `event_id`, `trigger_revision`, `analysis_version`, and `job_kind` only; never include user data or source content.
- Redis publish failure must leave the Outbox record pending and must not affect TriggerEvent persistence or the initial alert.
- Python Workers consume jobs idempotently. They may only read Node Stock Trace context by `event_id` / `snapshot_id` and must not fetch A-share sources directly.
- User APIs remain in `controller.ts`; Python-facing routes remain in `internalRouter.ts` and require `X-Internal-Token`.
- Company-context evidence is read from the unified event store first (`loadEventStoreEvidence` → Python `GET /api/agent/event/scrape-by-symbol/:symbol?date=当日`, via `AGENT_PY_URL || PYTHON_AGENT_URL` + `X-Internal-Token`, Shanghai-today date); on empty/miss/failure `collectCompanySources` falls back to the original CLS stock news + stock-info announcement collection (2026-08-12).
