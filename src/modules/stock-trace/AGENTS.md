# Stock Trace module

This module owns event-scoped stock-movement trace facts, snapshots, jobs, validated results, and artifacts.

### 2026-08-30 更新：涨停雷达并入 stock-trace 链路（统一事件与归因）

- **事件**：`InsightService.runCycle` 命中自选股（标题主体/涨停复盘汇总）改拉腾讯行情走 `processPriceFact(..., { immediateEnqueue: true })`，建 mv 事件并立即归因；`watchlist_insight_events` 不再新建（存量保留）。
- **immediateEnqueue**（`StockTraceService.processPriceFact` 第三参，默认 false）：true 时创建分支事务内入队 revision1 job，COMMIT 后既有 `publishPending` 发布；默认 false 保持"落定后归因"。
- **insight_article 证据域**：`StockTraceSnapshotService` 新增 `collectInsightArticleSources`（读当日 `watchlist_insight_sources` mentioned_symbols 命中该股的文章）+ 导出纯函数 `toInsightArticleSourceRecord`；kind=`insight_article`、provider=`ths_limit_up_radar`；入复用域（修订不重采）；`DataReadinessDomains`/`SourceKind` 增加 `article`/`insight_article`。候选层仍强制五层。
- **去重**："同股同向已归因（文章盘中触发）则午尾盘打点跳过"由 `processPriceFact` revision 机制天然实现（`isRevisionNeeded` false → `unchanged`）。

### 2026-08-30 更新：实时检测默认停用（opt-in）

- **决策**：自选股洞察仅保留午尾盘打点（11:30/15:05）与涨停雷达，`PriceTriggerDetector`（盘中每 5 秒实时价格检测）默认停用——盘中假动作多（产生 9:15/9:16 等盘中任意时间戳事件）。
- 启动条件改为 opt-in：`STOCK_TRACE_TRIGGER_ENABLED === 'true'` 才 `start()`（`src/index.ts`）；手动触发接口 `POST /internal/stock-trace/detect`（`runOnceForce`）与 `POST /internal/stock-trace/jobs/publish` 保留作应急调试。
- 午尾盘打点（`PriceMoveService` cron 11:30/15:05）与涨停雷达（`InsightService.runCycle`）不受影响。

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

### 2026-08-21 更新：盘中不再即时归因，落定后归因一次

- **决策**：盘中异动 6 方面数据不全导致归因不准，且每次 revision 即时入队消耗 token 过多。改为**实时检测+实时推送不变，最终归因只在事件落定后触发一次**（用最终 `current_trigger_revision` 的 enriched 快照，数据最全）。
- **落定三条路径**（统一走 `enqueueFinalAnalysis`，入队幂等由 `UNIQUE(event_id, trigger_revision, analysis_version, job_kind)` + `SELECT FOR UPDATE` 保证）：
  1. 恢复窗口到期：`startRecovery` 的 close UPDATE 加 `RETURNING`，对落定事件触发最终归因；
  2. 反向落定：`processPriceFact` 关闭相反方向 active 事件时，在同一事务内入队其最终归因；
  3. 收盘兜底：新增 `StockTraceService.settleActiveEvents()`（15:05 cron 调用），强制落定当日仍 active 的事件并触发归因。
- `processPriceFact` 的 create/revision 分支**不再**调用 `StockTraceJobService.enqueue`，仅保留快照采集、实时推送、`triggerEventScrape`；`publishPending` 仍保留用于刷新 outbox。
- Python consumer 的 `SNAPSHOT_NOT_READY` 重试（pending reclaim）天然适配：落定即入队、enriched 快照就绪后消费。

### 2026-08-21 更新：movements 列表/详情实时跟随当前自选

- `listUserEvents` / `getUserEvent` 的归属判定从 `stock_trace_user_events` 快照关联（事件创建时记录当时的持有者）改为**实时 `INNER JOIN user_stocks`**：
  - 列表可见性完全跟随当前自选——移出自选立即消失、之后加入自选可见历史事件，与 insights（`JOIN user_stocks`）行为一致；
  - 详情归属同样实时校验（当前自选无该股即 404），避免"列表可见但详情 404"的不一致。
- `read_at` 仍从 `stock_trace_user_events`（`LEFT JOIN ... ON ue.openid = $1`）读取；`markRead` 由 `UPDATE` 改为 `INSERT ... ON CONFLICT (event_id, openid) DO UPDATE`，支持"之后加入自选"的用户标记已读。
- `stock_trace_user_events` 保留用途：事件创建时的推送对象（`createUserEvents`/`sendInitialPush`）、已读状态落点、归因完成二次推送（`StockTraceAlertOrchestrator.pushSecondary`）。
- 未登录降级 `listRecentEvents`/`getRecentEvent` 不变。

### 2026-08-21 更新：优化实施（发布 gate / 并发检测 / 抓取重试 / 增量采集）

- **发布 gate**：`StockTraceJobService.publishPending` 发布前检查 `(event_id, trigger_revision)` 的 enriched 快照是否就绪；未就绪置 `held_until`（5s 重查、60s 硬超时后强制发布交由 consumer 兜底）。outbox 新增 `held_until` 列。`scheduleEnriched` 完成后自动冲刷 outbox。
- **落定路径就绪兜底**：`enqueueFinalAnalysis`（无 client 路径）入队前 `ensureEnrichedReady`——enriched 缺失时同步采集一次；反向落定（事务内）不阻塞等待，靠 consumer 超时兜底。
- **detect 并发**：`PriceTriggerDetector.detect` 按批次并发（上限 5），导出 `splitIntoBatches`；自选股 DISTINCT 保证同股不并发，事务 + UNIQUE 约束保写入安全。
- **抓取重试**：`triggerEventScrape` 失败指数退避重试（500ms/2s，共 3 次），仍失败仅告警不阻断。
- **revision 增量采集**：`StockTraceSnapshotService.captureEnriched/captureCorrected` 增加 `incremental` 分支——修订时复用上一 enriched 快照中"盘面基本不变"域（news/announcement/sector_fact/market_fact，`pickReusableSources`），仅重采 capital/technical 与当期 baseSources，压减 Tushare/东财请求量；`reusedDomainAvailability` 保证被复用域在 `dataReadiness`/`missingFields` 中如实报告可用（而非缺失）；无上一 enriched 快照时 fallback 原全量五域采集，创建（created）仍走全量。

### 2026-08-27 更新：Python 读层只读列表端点（阶段 2.2）

- `internalRouter.ts` 新增只读列表端点 `GET /internal/stock-trace/events?openid=&symbol=&limit=`：openid 走 query（internal 可信，需 `X-Internal-Token`），复用 `StockTraceService.listUserEvents` 后按 `symbol` 内存过滤（symbol 可空——为空返回该用户全部异动溯源）；`limit` 默认 50、上限 100。供 Python agent-py 的 `stock_trace_lookup` skill 对话查询使用（只读，无写入副作用）。

- `StockTraceJobService` writes a PostgreSQL job and transactional Outbox before publishing to Redis Stream `stock-trace.jobs`.
- Stream messages contain `job_id`, `event_id`, `trigger_revision`, `analysis_version`, and `job_kind` only; never include user data or source content.
- Redis publish failure must leave the Outbox record pending and must not affect TriggerEvent persistence or the initial alert.
- Python Workers consume jobs idempotently. They may only read Node Stock Trace context by `event_id` / `snapshot_id` and must not fetch A-share sources directly.
- User APIs remain in `controller.ts`; Python-facing routes remain in `internalRouter.ts` and require `X-Internal-Token`.
- Company-context evidence is read from the unified event store first (`loadEventStoreEvidence` → Python `GET /api/agent/event/scrape-by-symbol/:symbol?date=当日`, via `AGENT_PY_URL || PYTHON_AGENT_URL` + `X-Internal-Token`, Shanghai-today date); on empty/miss/failure `collectCompanySources` falls back to the original CLS stock news + stock-info announcement collection (2026-08-12).
