# Stock Trace module

This module owns event-scoped stock-movement trace facts, snapshots, jobs, validated results, and artifacts.

### 2026-10-07 更新：movements 列表 `visible_only` 过滤前置（opt-in）+ cursor 复合键 tiebreaker

- **动机**：`GET /api/cn/favorites/movements` 是「**先 LIMIT、前端再过滤**」——前端用 `isUnattributableMovement` 隐藏 `unavailable` 与低置信 `low`、再对同日同股去重，因此**被隐藏的行白占了窗口**，较早的有效异动可能因窗口被占满而取不到（实测 mxfff：50 条里 27 条是 `low`）。
- **`visible_only`（加性、opt-in）**：`listUserEvents(id, openid, limit, cursor?, options?: { visibleOnly?: boolean })` 与 `listRecentEvents(limit, cursor?, options?)`，仅 `options.visibleOnly === true` 时在 WHERE 追加 `VISIBLE_ONLY_PREDICATES`（两处共用同一常量，零新增占位符 → 不打乱 `params`/cursor 序号）。controller 解析 `?visible_only=1|true`（其它值一律不开启）。
  - 谓词①（排除"不可归因"）**必须带 `a.event_id IS NULL` 守卫**：`CASE` 中 `WHEN a.event_id IS NOT NULL THEN 'completed'` **优先于** unavailable，故"有有效 artifact（重新归因场景）但当前修订最新 result 被拒/失败"的行**前端会显示**；漏掉守卫会静默丢卡（计划审查抓出的缺陷）。
  - 谓词②用 `IS DISTINCT FROM 'low'` 而非 `<> 'low'`：后者对 NULL 求值为 NULL，会把"无归因结果的进行中事件"误隐藏。
  - 谓词①只针对 *result* 的 rejected/failed，**不碰 job 状态** → `analysis_status='failed'`（job `dead_letter`）的行刻意保持可见（2026-10-06 口径）。
  - **`internalRouter` 不改**：agent-py 读层走同一个 `listUserEvents`，不传 `options` → WHERE 不追加谓词。
- **cursor 复合键 + tiebreaker**：`ORDER BY e.first_triggered_at DESC, e.event_id DESC`；`nextCursor` 改为 `"<first_triggered_at ISO>|<event_id>"`；下页条件改行值比较 `(e.first_triggered_at, e.event_id) < ($ts::timestamptz, $eid)`。原因：单字段 cursor 在**同一毫秒**的多条事件上会漏行，而翻页是本次新引入的能力（此前 `nextCursor` **无任何消费方**，故该不透明字符串格式由本次定义）。
  - ⚠️ **tiebreaker 是无条件加的**：所以"不传 `visible_only` 时 SQL 逐字不变"只对 WHERE 成立；`ORDER BY` 变了 → 在 `first_triggered_at` **完全并列**的边界行上入选行可能与改动前不同（agent-py 读层同样受此影响，仅并列边界，且使排序确定化）。
- **测试**：`__tests__/visibleOnly.spec.ts`（不传 options 时 SQL 不含谓词 / `a.event_id IS NULL` 守卫断言 / `IS DISTINCT FROM` / cursor + visibleOnly 联合时占位符序号 / 未超页 `nextCursor === null`）；`internalRouter-events.spec.ts` 补断言（该路径 `options` 为 `undefined`）。
- **前端配套**：见 aistock-app-frontend `modules/favorites/AGENTS.md`（两页 cursor 翻页 + `@scrolltolower` + `upsertEventById`）。

### 2026-10-06 更新：归因失败可观测（`last_error_detail`）+ `analysis_status` 第 4 值 `failed`

- **动机**：2026-09-30 海正生材 688203 事故——某股当日 3 条异动，**最新一条**归因 job 三次尝试后进入终态 `dead_letter`，因无 result 被派生为 `processing`，卡片永久显示「归因中」，并在"同日同股取最新"的展示口径下**遮盖了当日已有的有效归因**。排查时又发现：`last_error_code` 只存 worker 的通用兜底码 `LLM_OR_DEPENDENCY_UNAVAILABLE`，真实异常（类名+消息）既没落库、日志也没留存 → 事后完全无法定位根因。
- **可观测性**：`stock_trace_jobs` 新增 `last_error_detail TEXT` —— migration `024_stock_trace_job_error_detail.sql` + `StockTraceJobService.ensureSchema()` 幂等 `ADD COLUMN IF NOT EXISTS`（存量库启动即自动补列）+ `015_stock_trace_jobs.sql` 回写冷部署表定义。`PATCH /internal/stock-trace/jobs/:jobId` 请求体新增可选 `last_error_detail`（**服务端强制截断 500 字符**）；`reportStatus` 用 `SET last_error_detail = COALESCE($5, last_error_detail)`，**仅在本次带明细时覆盖**，避免后续 `completed` 报告把已存明细清空。上报侧见 agent-py `StockTraceWorkerOutcome.error_detail`。
- **状态区分**：`analysis_status` 新增第 4 个值 **`failed`**（终态失败）。`listUserEvents` / `listRecentEvents` 两处 SQL 各新增 `LEFT JOIN LATERAL (SELECT j.status FROM stock_trace_jobs j WHERE j.event_id = e.event_id AND j.trigger_revision = e.current_trigger_revision ORDER BY j.created_at DESC LIMIT 1) j ON TRUE` 与 `CASE` 分支 `WHEN j.status = 'dead_letter' THEN 'failed'`；详情链路新增 `StockTraceJobService.getLatestJobStatusForEventRevision(eventId, triggerRevision)` 并透传给 `presentStockTraceAnalysis`（其 `processingStatus` 联合类型加 `'failed'`）。
- **优先级口径（重要）**：`unavailable` **优先于** `failed` —— 存在被拒/失败 result 时不算"归因失败"（确有产出可回退展示），只有 job `dead_letter` **且无 result** 才落 `failed`。两处派生点（列表 SQL 与详情 presentation）**必须保持一致**。
- **不改**：WS/推送的 `toPublicEvent` 仍返回 `'processing'`（仅在事件创建/修订时调用，此时必然尚无结果）；`stock_trace_results`/快照/worker 错误码语义与 `REPLAYABLE_ERROR_CODES` 均未动。
- **前端配套**（详见 aistock-app-frontend `modules/favorites/AGENTS.md`）：`failed` 显示「归因失败」（5 处文案映射）；`dedupeDailyMovements` 挑最新时跳过 `failed`（当日有有效归因则回退显示它，全 failed 才保留最新）；`failed` **不被** `isUnattributableMovement` 隐藏。
- 测试：`listAnalysisStatus.spec.ts`（两处 SQL 的 job LATERAL 与 `unavailable > failed` 分支**位置**断言）、`presentation.spec.ts`（dead_letter→failed / artifact 优先 / unavailable 优先）、`presentEventAnalysis.spec.ts`（controller 详情链路透传）→ `npx tsc --noEmit` exit 0。

### 2026-09-30 更新：列表接口透出 `confidence_level`（低置信不展示卡片口径）

- **动机**：产品口径——**低置信（`low`）的归因不展示异动卡片**（`medium`/`high` 照常展示）。判定在前端做，因此列表接口须把归因置信度透出（此前只透出 `primary_cause`）。
- **改动**：`listUserEvents` / `listRecentEvents` 的 SELECT 各新增 `(SELECT r3.confidence_level FROM stock_trace_results r3 WHERE r3.result_id = a.result_id LIMIT 1) AS confidence_level`，items 映射为 `confidence_level: row.confidence_level ? String(row.confidence_level) : null`。**与 `primary_cause` 同源**（均取 effective artifact 对应 result，`r3.result_id = a.result_id`）——若改用"最新 result"会与主因短语指向不同版本、口径不一致。
- **枚举**：`low` / `medium` / `high`（阈值 `score >= 0.75 → high`、`>= 0.5 → medium`，见 `StockTraceResultService`）。
- **降级语义**：无归因结果（事件仍在归因/归因失败）时返回 `null`；前端据此**不隐藏**，只隐藏显式 `low` —— 避免"字段缺失/null 即隐藏"误杀全部卡片。
- **加性改动**：新增 SELECT 列与返回字段，不改排序/游标/可见性，旧前端未消费该字段时零影响。
- 测试：`__tests__/eventPayloadFields.spec.ts` 新增 describe「列表接口透出 confidence_level（低置信不展示口径）」5 例（两列表取值 + SELECT 断言 + `null` 透传；SQL 断言用设计中立的 `/confidence_level/`，不绑定实现别名）→ **13 pass / 0 fail**；`npx tsc --noEmit` exit 0。
- **前端配套**（详见 aistock-app-frontend `modules/favorites/AGENTS.md`）：`isUnattributableMovement` 增加 `if (m.confidence_level === 'low') return true`。

### 2026-09-24 更新：列表/推送载荷补齐（window_end_at + is_limit_up + analysis_status 口径对齐）

- **列表接口透出 `window_end_at`**：`listUserEvents` / `listRecentEvents` 的 SELECT 增选 `e.window_end_at`，items 映射为 `window_end_at`（ISO 字符串）。原因：前端卡片按 `window_end_at || triggered_at` 取"最近异动时间"，缺该字段时恒退化为**首次**触发时刻（每次再触发/修订都会刷新 `window_end_at`，见 `processPriceFact` 的 `SET window_end_at = $2`）。加性改动，排序/游标仍按 `first_triggered_at`，未变。
- **`toPublicEvent` 透出 `is_limit_up`**：`TriggerEvent` 新增可选 `isLimitUp`（来自 `PriceFact.isLimitUp`，由 `buildTriggerEvent` 透传；与 DB 列 `is_limit_up` 写入口径一致），投影为 `is_limit_up`（缺省 `false`）。原先 WS 新建推送/`internalRouter` 触发响应缺该字段，前端「涨停」徽标在推送卡片上恒不显示（须等 refresh 才有）。
- **`analysis_status` 口径对齐**：`toPublicEvent` 原先硬编码 `'pending'`，而列表 `analysis_status` 是 SQL 派生（无 artifact/result → `'processing'`，见 2026-08-19 条目）→ 同一事件在 WS 卡片显示"待归因"、下拉刷新后立刻变"归因中"。现统一为 `'processing'`（推送时刚创建/修订，必然尚无 artifact 与 result）。
- **护栏**：新增 `__tests__/eventPayloadFields.spec.ts`（8 例：两列表的 `window_end_at` 取值 + SELECT 断言、`is_limit_up` 真/缺省、`analysis_status === 'processing'`、`window_end_at` ISO 回归）；同步 `__tests__/listAnalysisStatus.spec.ts` 的 fixture（其 `row()` 注释即"与 SELECT 列一致"，补 `window_end_at`）。
- **未改**：`stock_trace_events` 无 `analysis_status` 列（状态始终派生）；`getUserEvent`（详情）本就 SELECT `e.window_end_at`，未变。

### 2026-09-18 更新：capital 候选层降级为条件准入层（agent-py 侧口径变更）

- **背景**：资金净流入/流出方向与价格涨跌是同义反复（价格本即资金博弈结果），作为候选归因维度信息增量为零，且因"永远存在且天然同向"成为五层中最易置 supported 的一层，会挤压 company/sector/market 真因；但资金的结构/来源/背离（分单结构、席位来源、量价背离）含价格读不出的增量信息 → **保留维度、收紧准入**。
- **agent-py 改动（本仓无代码改动）**：`schemas/stock_trace.py` `required_layers` 五层 → `{company, sector, market, technical}`（`capital` 仍在 layer 枚举，存量结果兼容）；`prompts/workers/stock_trace.py` 新增 capital 专项规则（禁同义反复、仅结构/来源/背离可 supported、T-1 资金数据不得支撑主链）；PDF 报告章节标题改为"分层候选归因"。
- **本仓为何无需改动**：`StockTraceResultService.validateStockTraceResult` 本就只强制 `company/sector/market` 三层，对 capital 缺席已兼容；`stock_trace_candidates` 按 `(result_id, layer, rank)` 唯一，少一层不影响落库与报告组装。
- **陈旧能力标记已清理（2026-09-18 当日追加）**：删除 `missingCapabilities: ['capital_flow_disabled']` 硬编码（`runRuleFallback` / `acceptExternalResult` 共 4 处）与 `ValidationInput.missingCapabilities` 字段——资金流数据已实际采集，该标记使 sector/market 的 `missing_counter_evidence` 校验被永久跳过。
- **capital 证据补齐结构信息（2026-09-18）**：`StockTraceSnapshotService` 抽出纯函数 `toCapitalSourceRecord(flow, symbol, capturedAt)`（对齐 `toInsightArticleSourceRecord` 约定），透出原先被丢弃的 `orders`（超大单/大单/中单/小单）与 `windows`（1/5/10/20 日拆解），正文改为 `截至 {tradeDate}：主力净流入…；分单结构…`。原因：agent-py 侧资金维度降级为条件准入层后，只有"价格读不出的增量信息（结构/来源/背离）"才可能被置 supported/weak，否则恒为 insufficient；正文标注 `trade_date` 用于"同日可 supported、T-1 最高 weak"的时效分档判定。
- **配套防回归**：直接启用严格校验会让"未引用反证的 supported 板块/大盘候选"被拒 → `processing_status='partial'` → artifact 不生成 → 报告端点 409。故同步：① agent-py 提示词新增"反向板块/大盘事实下仍置 supported 必须引用 `counter_evidence_ids`"；② agent-py `validate_stock_trace_result` 镜像该规则（Node 是回写后终态门、无重试；Python 侧失败可触发 LLM 纠错重试）。规则兜底路径的 `buildCandidate` 自带 counter 证据，不受影响。

### 2026-09-18 修复：收盘落定与收盘打点同 cron 竞态导致归因卡住

- **现象**：蓝盾光电（300862）/海正生材（688203）当日归因卡在"归因分析中"。
- **根因**：`index.ts` 中 close 打点（`runPriceMoveDetect('close')`）与收盘落定（`settleActiveEvents`）曾注册为**同一 cron 表达式 `5 15 * * 1-5`**，两者并发触发。落定是一两条 UPDATE，很快跑完，会抢在打点（遍历自选股 + 采快照，耗时数秒）中途把当日 active 事件一次性关闭并入队；打点随后（落定之后）为同一标的**又新建一条事件** → 该事件永远停在 `active`、**无 job / 无 outbox**，前端同日聚合取最新 → 卡片恒显"归因分析中"。
- **判别特征**（复现/排查用）：同标的当日出现**两条** 15:05 事件（落定前一条被关闭、落定后一条 active）；`stock_trace_events` 有 active 行但 `stock_trace_jobs` 无对应 `(event_id, trigger_revision)`；outbox 无对应行。
- **修复**：落定改为在 close 打点**完成后**执行（`runPriceMoveDetect` 的 `finally` 内 `await StockTraceService.settleActiveEvents()`），保证"先建齐当日事件、再落定"的时序；独立落定 cron 由 `5 15` 后移到 `10 15` 作兜底（覆盖打点异常或 15:05 后新建事件），`settleActiveEvents` 幂等可重复调用。

### 2026-09-18 修复：outbox 发布失败无重试入口导致 pending 永久滞留

- **现象**：`stock_trace_outbox` 某行 `status='pending'`、`last_error_code='Error'`（Redis 命令失败，`error.name.slice(0,64)` 落成 `'Error'`）、`attempt_count=3`、`published_at=NULL`，此后 15 小时无任何重试。
- **根因**：`publishPending` 只在 `enqueue` / `scheduleEnriched` 完成等**事件路径**被顺带调用，没有周期性触发点 → 一旦发布失败，该行没有重试入口（同一模式 2026-08-25 已复现过一次，当时靠人工重发）。
- **修复**：新增每分钟 cron `StockTraceOutboxCron` 调用 `StockTraceJobService.publishPending()`（`status='pending'` 有索引，常态零行近零成本；日志仅在 `published>0 || failed>0` 时打印）。实测已自动补发滞留行。

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
- ⚠️ **已被 2026-10-06 扩展**：新增第 4 值 `failed`（job `dead_letter`），且该分支位于 `unavailable` **之后**（即 `unavailable` 优先）。当前完整口径见本文件顶部 2026-10-06 条目。

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

### 2026-09-03 更新：is_limit_up + forecast slot 分存（阶段 2 轻量预判）——已于 2026-09-13 移除

> forecast（轻量预判）功能已彻底下线。迁移 `022_drop_forecast.sql` 已删除 `stock_trace_events` 的 `forecast` 列（保留 `is_limit_up`）。以下方法/端点已删除：
>
> - `StockTraceService.listLightPredictTargets(tradeDate)` — 按 symbol 去重返回当日预判候选。
> - `StockTraceService.upsertEventForecast(eventId, slot, forecast)` — slot 级 upsert（`forecast = forecast || jsonb_build_object($slot, $forecast::jsonb)`）。
> - Internal 端点：`GET /internal/stock-trace/light-predict-targets`、`PATCH /internal/stock-trace/events/:eventId/forecast`。
>
> `is_limit_up` 列保留不变（涨停文章命中标记，前端涨停文案仍依赖）。

### 2026-09-26 更新：报告章节由 `lines` 改为结构化 `blocks`（六阶段因果链纵向时间轴）

- **动机**：用户反馈完整报告"排版不美观"、六阶段因果链希望用表格/流程图。纯文本 `lines: string[]` 无法承载节点卡与表格 → 整份报告改结构化输出（三仓同步），`lines` 彻底移除（唯一消费方是本仓，不留兼容壳）。
- **契约**：`sections` 元素由 `{heading, lines}` 改为 **`{heading, blocks}`**；空节 → `blocks: []`（前端渲染"暂缺"）。Block 判别联合 6 类：`kv` / `verdict` / `candidates` / `chain` / `evidence` / `list`（类型定义见 `InsightReportService.ts` 的 `ReportBlock`，与 agent-py 逐字段一致）。
- **本仓改动**：① `InsightReportService` 新增 `ReportBlock`/`ReportKvItem`/`ReportChainStage` 类型，`ReportSection.lines` → `.blocks`；`fetchSections` 增加**边界归一化**（章节缺 `blocks`/非数组 → 补 `[]`，不把 `undefined` 透给前端）。② `controller.reportStream` 推送的 section 事件由 `lines` 改为 `blocks`（`data: {"type":"section", index, heading, blocks}`）。
- **`chain` 只含主链**：由 agent-py `_primary_chain()` 筛选（真实 artifact 通常有 primary + alternative 各 6 节点，旧实现把 12 个节点平铺混淆）。节点同时带中文标签与机器 key（`stageKey`/`epistemicKey`/`statusKey`），供前端做中性弱化判定；**候选项同理带 `statusKey`**（前端用 `statusKey !== 'supported'` 判弱化，不匹配中文 `status` 标签）。
- **`buildReportData` 不变**：主因正文的三级兜底（`primaryPhrase ?? primaryCandidate.verdict ?? primary_cause`）继续**只在本仓**做，agent-py 不重复兜底（两侧同兜底会各自演化、口径漂移）。
- 测试：`__tests__/insightReport.spec.ts` 改为断言 `blocks` 透传（含 `chain.stages` 与 `stageKey`）；新增 `fetchSections` 边界归一化 3 例（缺 blocks → `[]`、缺 header → 空串、`sections` 非数组 → 抛错转 502）→ **11 pass / 0 fail**；`npx tsc --noEmit` exit 0。
- 前端配套：新增 `modules/favorites/components/InsightReportBody.vue` 按 `block.type` 分派渲染，六阶段因果链为**纵向时间轴**（序号圆点 + 竖线 + 节点卡）。

### 2026-09-25 更新：洞察报告由 PDF 下载改为 SSE 流式输出

- **背景**：用户反馈完整洞察报告以 PDF 文件形式体验不好（移动端需外部阅读器打开、每次都要下载文件）。**决策：彻底移除 PDF 链路**，改为在洞察详情页点击「生成完整洞察报告」后，在按钮下方**逐章节流式输出**。
- **端点变更**：`StockTraceController.report()`（`GET /api/cn/favorites/movements/:eventId/report.pdf`）→ **`reportStream(req, res)`**（`GET /api/cn/favorites/movements/:eventId/report/stream`），响应 `text/event-stream;charset=UTF-8`。
  - **鉴权与前置校验全部在"开流前"完成** → 失败仍返回**真实 HTTP 状态码 + JSON**：`401`（未登录）、`404`（事件不存在/不在当前自选）、`409`（无有效归因 artifact）、`502`（agent-py 不可用或章节结构非法）。仅**开流之后**才发生的异常才走 `data: {"type":"error"}` 兜底 + `res.end()`。
  - **为什么能返回真实状态码**：前端改用 `fetch + ReadableStream` 消费（`EventSource` 无法设置 `Authorization` 头，而本端点需 JWT），因此可以直接读状态码。
  - **事件序列**（不写具名 `event:` 行，`type` 放进 data，前端按 `data: {...}\n\n` 分帧）：`{"type":"start", header, total}` → `{"type":"section", index, heading, blocks}` × N → `{"type":"done", message:"success"}`（**注**：section 事件在 2026-09-26 由 `lines` 改为 `blocks`，见上一条）；单条 `section` 之间 `REPORT_SECTION_INTERVAL_MS = 80ms` 节奏（模板构建是毫秒级的，不加节奏前端会"瞬间铺满"、失去流式观感；调 0 即瞬时）；15s `: keep-alive` 心跳，响应头含 `X-Accel-Buffering: no`。
- **Service 层变更**：`InsightReportService` 删除 `renderPdf`，新增 `fetchSections(data)` → `POST /api/agent/insight-report/sections`（agent-py，`X-Internal-Token`，10s 超时），返回 `{header, sections}`；结构与返回非法时抛错，由 controller 转 502。`buildReportData`（报告数据组装）与 `event.tradingDate`/`attribution.primaryLayer`/`generatedAt` 字段**保持不变**（章节文案仍由 agent-py `insight_report.py` 模板 + 中文化映射产出）。
- **数据流**：app-api 组装报告数据 → agent-py 纯模板构建章节 JSON（无 LLM）→ app-api 分块推 SSE → 前端逐章节渲染。
- 测试：`__tests__/insightReport.spec.ts` 改为 SSE 用例集（新增 `fakeSseRes()`/`sseEvents()` 辅助，覆盖 401/404/409/成功 `start→section×2→done`/agent-py 失败 502 共 5 例）→ **8 pass / 0 fail**；`npx tsc --noEmit` exit 0。
- 前端配套（详见 aistock-app-frontend）：新增 `useInsightReportSSE.ts`（fetch+ReadableStream，60s 超时 + AbortController）；详情页按钮改为「生成完整洞察报告」（生成中可点击停止、完成后变「重新生成」）；monitor 卡片「报告 ›」改为跳详情页带 `autostart=1` 自动开始生成；删除 `shared/utils/downloadInsightReport.ts`。
- **设计文档**：`docs/superpowers/specs/2026-09-25-insight-report-streaming-design.md`（本章节的权威契约来源）。

### 2026-09-24 更新：洞察报告 PDF 字体内嵌（修乱码）+ 页眉与字段补齐

> **注：2026-09-25 起 PDF 链路已整体替换为 SSE 流式输出**（见上一条），本节记载的是当时排查 PDF 乱码的根因与修复过程，其中「`trading_date::text` 补齐」与「中文化映射」两项结论在流式方案中**继续有效**。

- **用户报障**：下载的 PDF 中文大量乱码（尤其章节标题）。**根因**：agent-py 侧原用非嵌入 CID 字体 `STSong-Light`，PDF 只写字体名不带字形（实测 `FontFile`/`FontFile2`/`FontFile3` 计数全为 **0**），阅读器未安装该字体即整篇回退乱码。与"能否生成图片/彩色"无关。
- **修复（agent-py 侧，详见其 changelog）**：改用内嵌 TTF `assets/fonts/NotoSansSC-Regular-Subset.ttf`（2.33MB，OFL 授权的 Noto Sans SC 子集）；`pyproject.toml` 的 package-data 增 `assets/fonts/*.ttf`。
- **app-api 侧配套**：
  - `InsightReportService.buildReportData` 给 agent-py 的内部 payload 新增 `event.tradingDate`、`attribution.primaryLayer`（归类标签，渲染层映射中文）、`attribution.generatedAt`（归因生成时间）。
  - `StockTraceService.getUserEvent` / `getRecentEvent` 的 SELECT 增选 `e.trading_date::text AS trading_date`、返回投影新增 `trading_date`。**这是本次发现的真实缺口**：两条投影原先都未带该列（`getInternalEvent` 本就带，故此前未暴露），导致 PDF 页眉交易日恒为"暂缺"。用 `::text` 是为避开 PG `DATE` 列被 node-postgres 解析成 `Date` 后 JSON 化为 UTC ISO 串（实测页眉曾显示 `2026-09-23T16:00:00.000Z`，应为 `2026-09-24`）。**加性改动**：前端未消费该字段，零破坏。
- **报告内容变化**：页眉新增「股票名（代码） · 交易日」；主因结论新增归类标签与归因生成时间；分层候选行/六阶段链节点行追加证据 ID；证据清单行扩为 `source_id｜provider｜kind｜occurred_at｜source_level｜title｜摘要`。
- 测试：`__tests__/insightReport.spec.ts` **10 例全过**（新增 `getUserEvent` 投影含 `trading_date` 的 mock-pool 用例）；`npx tsc --noEmit` exit 0。
- 跨端（cross-repo-impact-analyzer 已确认）：`trading_date` 为纯加性字段，**无需同步前端**；`/insight-report/render` 唯一调用方是 app-api。

### 2026-09-13 更新：完整洞察报告 PDF + 预判彻底移除（迁移 022）

> **注：本节描述的 PDF 报告端点已于 2026-09-25 被 SSE 流式输出整体替换**（`report.pdf` → `report/stream`，见上文最新条目）。迁移 022 与"彻底移除预判"部分仍然有效。

- **新增端点**：`GET /api/cn/favorites/movements/:eventId/report.pdf`（StockTraceController.report）——JWT 鉴权，返回实时渲染的 PDF。
  - 状态码：`401`（无/无效 JWT）、`404`（事件不存在或不属于当前用户）、`409`（事件无归因完成结果，不可生成报告）、`200`（正常返回 PDF 字节流，Content-Type: application/pdf）、`502`（上游 agent-py 渲染服务不可用/超时/非 PDF 响应）。
  - 数据流：app-api 组装快照 + 归因结果 → `POST /api/agent/insight-report/render`（agent-py，X-Internal-Token 鉴权）→ 收到 PDF buffer → 设 Content-Disposition attachment 文件名 `{symbol}_{eventId}_{date}.pdf` → 返回。
  - 报告**实时生成不落盘**（无 DB 存储，无缓存）。
- **agent-py 侧**：`POST /api/agent/insight-report/render`（`services/insight_report.py`，X-Internal-Token 校验）——接收 event JSON body，以 reportlab 渲染 PDF（A4, 中文正文+表格+归因证据），500 出错。
- **迁移 `022_drop_forecast.sql`**：`stock_trace_events` 与 `stock_info_judgements` 的 `forecast` 列已彻底删除（**保留 `is_limit_up`**——涨停文案仍依赖）。`ensureSchema` 中对应的幂等 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS forecast` 已同步清理（否则重启会复活列）。
- **Service 层移除**：`StockTraceService.listLightPredictTargets`、`upsertEventForecast` 已删除；`StockInfoService.upsertJudgementForecast` 已删除。
- **端点移除**：`GET /internal/stock-trace/light-predict-targets`、`PATCH /internal/stock-trace/events/:eventId/forecast`、`PATCH /internal/stock-info/judgements/:id/forecast` 已删除。

### 2026-09-04 更新：movements 持仓期可见 + 新增自选股"加入即打点"

- **问题**：用户刚把某股加入自选，却在"自选股异动"看到加入前历史（09-03 mv 历史 / 08-04 老雷达存量），且改为"仅当日"误伤老自选股（历史归因消失）。
- **最终决策**：movements 可见性下界 = 该股**当前持仓期**（`listUserEvents` JOIN ON 追加 `AND e.first_triggered_at >= us.created_at`）：
  - 老自选（created_at 早）全历史 + 今日新触发照常（恢复 08-21"当前在自选即可见"直觉）；
  - 新加入股只显示加入时刻之后触发/仍活跃的异动，避免"刚加入即见加入前历史事件"。
  - `user_stocks.created_at` = 行首次加入（移出再重加则新行/新时刻）；`addFavorites` 用 `INSERT ... ON CONFLICT DO NOTHING RETURNING symbol` 识别本次真正新加入的 symbol。
- **加入即打点**：`PriceTriggerDetector.detectSymbols(symbols, now)`（新增）——仅对给定 symbols 拉 `activity` 行情（复用 detect 的字段/阈值/eligible 过滤），命中（相对昨收 ≥ PRICE_TRIGGER_PERCENT）即 `processPriceFact(..., { immediateEnqueue: true })` 盘中立即归因，使新加入股当天即可见归因（不回填历史）。`UserController.addFavorites` 在交易时段（`isAShareTradingTime`）对新加入 symbols 调用它；非交易时段跳过（避免用收盘价误判）。检测失败仅告警不影响添加。
- `listRecentEvents`（未登录/全局）还原原样（无持仓期概念）；`StockTraceController.list` 登录分支调用还原为不带额外参数。
- monitor.vue（前端）移除老雷达数据源 `watchlistInsightApi.getInsights`（存量 watchlist_insight_events 08-30 起停用，含 8 月初远古事件）。
