# 涨停雷达与午尾盘异动链路合并设计

- 日期：2026-08-30
- 分支：junliang（aistock-app-api / aistock-app-frontend / aistock-agent-py）
- 状态：设计已获用户确认，待实施

## 1. 背景与目标

当前自选股洞察有两条独立链路，事件表与归因体系分家：

| 维度 | 涨停雷达（insight） | 午尾盘异动（stock-trace） |
|------|---------------------|---------------------------|
| 触发 | 每 10 分钟爬同花顺涨停雷达文章命中自选股 | 11:30/15:05 打点 |
| 事件表 | `watchlist_insight_events`（wi_ 前缀） | `stock_trace_events`（mv 前缀） |
| 归因 | agent-py 从文章正文总结归因（扁平 driver） | agent-py 五层候选 + 六阶段链（Node 快照五域证据） |
| 前端 | insight-detail.vue | insight-detail-move.vue |

**目标**：合并两条链路。涨停雷达文章**只作为 stock-trace 归因的额外证据来源**，事件与归因统一走午尾盘异动（stock-trace）链路。

## 2. 用户确认的决策

1. **取消归因语义**：同一股票同一交易日，若涨停雷达文章已触发归因并产出结果，午尾盘打点命中同股时不再重复归因（跳过）——每只股票每天只归因一次。
2. **事件落点**：涨停雷达命中与午尾盘打点统一写入 `stock_trace_events`；`watchlist_insight_events` 不再新建（存量保留）。
3. **文章命中时机**：盘中爬取到命中自选股的涨停文章时**立即**建事件并触发归因（文章证据入快照），不等落定。
4. **证据实现**：新增独立证据来源（source kind = `insight_article`），不并入 company 域。
5. **前端范围**：仅 App 端（aistock-app-frontend）同步改造。
6. **对话 skill**：insight_lookup 停用，词条统一映射到 stock_trace_lookup。
7. **存量事件**：watchlist_insight_events 存量保留在库、App 端不再展示。

## 3. 现状关键事实（实施依据）

- 午尾盘打点已走 `StockTraceService.processPriceFact(security, fact)`（`PriceMoveService.run`），事件创建后**默认不立即归因**（`src/modules/stock-trace/StockTraceService.ts:255`，创建分支无 enqueue，等 15:05 `settleActiveEvents` 落定归因，08-21 决策降 token）。
- `processPriceFact` 的 revision 机制天然去重：同向 active 事件存在且 `isRevisionNeeded` 为 false → 返回 `unchanged` 不重新归因（line 307-310）。**"文章已归因则打点跳过"由此天然实现，无需新增去重逻辑。**
- `processPriceFact` 要求 `|changePct| >= PRICE_TRIGGER_PERCENT(7)` 才建事件（line 257）。
- 涨停雷达命中逻辑在 `InsightService.runCycle`（`InsightService.ts:61-90`）：`createEvent` 建 wi 事件 + `enqueue`（insight job）。
- stock-trace 快照采集 `StockTraceSnapshotService.captureEnriched/captureCorrected` 五域并行采集（company/sector/market/capital/technical），agent-py `SourceKind` 8 类（schemas/stock_trace.py:16-18），候选层强制五层（required_layers，line 145）。
- 前端 `AlertContent.vue` 并行拉 `insights`（涨停雷达）+ `movements`（价格异动），按 `event_type` 分流跳转两个详情页。

## 4. 目标架构

```
涨停雷达文章爬取（保留，runCycle 每10分钟）
   └─ 命中自选股 → 拉腾讯行情构造 PriceFact
                      └─ processPriceFact(security, fact, { immediateEnqueue: true })
                          ├─ 创建 stock_trace mv 事件（revision1）
                          ├─ 快照采集：五域 + 新增 insight_article 文章证据域
                          ├─ 立即 StockTraceJobService.enqueue → stock-trace 归因
                          └─ 打点命中同股同向 → isRevisionNeeded=false → 跳过（天然去重）
午尾盘打点（保留，11:30/15:05）→ processPriceFact → 无文章且无事件则正常归因
```

## 5. 分节设计

### 5.1 事件与触发（aistock-app-api）

**InsightService.runCycle 命中分支改造**（`InsightService.ts:61-90`）：

- 命中自选股（标题主体股票 / 涨停复盘汇总文章逐只）时：
  1. 拉腾讯行情（`TencentQuoteService.getBatchQuotes` activity 级别，取 昨收/最新价/涨跌幅）构造 `PriceFact`；
  2. 行情有效且 `|changePct| >= 7` → `StockTraceService.processPriceFact(security, fact, { immediateEnqueue: true })`；
  3. 行情无效（停牌/缺字段/涨跌幅 <7%）→ 跳过该命中并记日志（防假数据），不再建 wi 事件。
- 移除 `createEvent`（wi 事件）与 `InsightJobService.enqueue` 调用；`watchlist_insight_events` 不再写入。
- `runCycle` 文章入库（`upsertSources` 到 `watchlist_insight_sources`）保留——它同时是文章证据源与去重高水位。

**processPriceFact 新增可选参数 `options.immediateEnqueue`**（`StockTraceService.ts`）：

- 仅创建分支（mutation='created'）生效：在 `captureSnapshots(event, 'created')` 前调用 `StockTraceJobService.enqueue(eventId)`（幂等），随后 `publishPending()` 发布到 `stock-trace.jobs`。
- 默认值 false，保持打点/实时链路既有"落定后归因"策略不变。
- 签名：`processPriceFact(security: FavoriteSecurity, fact: PriceFact, options?: { immediateEnqueue?: boolean })`。

### 5.2 证据：新增 insight_article 域（aistock-app-api + aistock-agent-py）

**aistock-app-api `StockTraceSnapshotService`**：

- 新增 `collectInsightArticleSources(event, capturedAt)`：查询 `watchlist_insight_sources`（trade_date = 当日）中标题主体或正文提及命中该 `event.symbol` 的文章，构造 `StockSourceRecord`：
  - `kind: 'insight_article'`，`provider: 'ths_limit_up_radar'`，`sourceLevel: 'B'`，`title` 文章标题，`contentExcerpt` 正文摘录（600 字上限，对齐 EXCERPT_LIMIT），`canonicalUrl` 详情页 URL，`sourceRef` article_id，`payload: { keywords, published_at }`。
  - `occurred_at` 用文章 published_at，`freshness_seconds` 相对 capturedAt 计算。
- 在 `captureEnriched` / `captureCorrected`（含增量路径的 baseSources 拼接）中加入该采集；`buildDataReadiness` 增加 `article` 域（count>0 → complete）。无文章时 article 域 missing，不阻塞归因（与其余域缺失语义一致）。
- `DataReadinessDomains` 类型增加 `'article'`（`src/modules/stock-trace/types.ts`）。

**aistock-agent-py `schemas/stock_trace.py`**：

- `SourceKind` Literal 增加 `"insight_article"`。
- `data_readiness` 键类型允许 `"article"`（`dict[str, Literal[...]]`，键为 str 时无需强改，但 Node 返回含 article 键需与校验兼容；若无 strict 校验则免改）。
- 候选层 `required_layers` **不变**（仍五层）——文章证据作为 LLM 可见的额外 source record，不强制作为候选层。

### 5.3 去重：文章已归因则打点跳过（零新增逻辑）

复用 `processPriceFact` revision 机制：

- 文章命中建事件（revision1）并立即归因 → 打点命中同股同向 → `isRevisionNeeded`（幅度差 <2 且 severity 不升）为 false → 返回 `unchanged`，不建新 revision、不重新入队归因。
- 归因结果（stock_trace_results/artifacts）保持不变，前端展示既有结果。

### 5.4 前端（aistock-app-frontend，仅 App 端）

- `AlertContent.vue`：移除 insights 拉取与合并，列表只消费 movements API（stock-trace 事件）；`event_type` 统一为 price，跳转统一 `insight-detail-move.vue`。
- `insight-detail.vue`（涨停雷达详情）：不再作为入口使用，文件保留不删（历史兼容）。
- 详情页可展示 `insight_article` 证据（若现有证据清单组件能透出 source kind 则直接展示；否则展示为普通证据条目）。

### 5.5 agent-py：insight 链路停用

- `InsightService.runCycle` 不再建 wi 事件 → `watchlist-insight.jobs` 无新消息 → insight consumer 自然空闲（保留进程不主动停用，避免误伤存量处理）。
- 对话侧：qa_router 词条优先级调整——`涨停雷达/自选股/洞察/归因` 统一映射到 `stock_trace_lookup`；`insight_lookup` 从 registry 摘除或标记停用（不再出现于 skill 清单渲染）。

## 6. 影响面与风险

| 项 | 影响 |
|----|------|
| app-api：InsightService / StockTraceService / StockTraceSnapshotService / types.ts | 事件创建与快照采集改造 |
| app-api：只读端点 `GET /internal/insight/events` | 数据源不再有新数据，保留存量；`insight_lookup` skill 停用后该端点无新调用方 |
| agent-py：schemas/stock_trace.py、qa_router.py、skills/registry.py | SourceKind 扩展 + 词条映射调整 |
| agent-py：insight_consumer / insight_worker | 保留，无新消息 |
| app-frontend：AlertContent.vue 等 | 列表只读 movements，统一详情页 |
| 存量 wi 事件 | 保留在库，不再展示 |

**风险点**：

1. **行情拉取失败**：涨停雷达命中时腾讯行情不可用 → 跳过命中（当日漏检由午尾盘打点兜底）。
2. **文章证据时效**：`watchlist_insight_sources.trade_date` 为当日，快照采集在事件创建后 ~1s 触发，文章已入库（runCycle 先 upsert 再建事件），时序安全。
3. **insight_article 域与候选层**：五层候选不强制含 article，归因质量依赖 LLM 自动利用该证据；若需提高权重可后续在 prompt 强调。
4. **前端兼容**：movements API 已含 `primary_cause` 等展示字段，insight-detail-move.vue 无需大改。

## 7. 测试计划

- app-api：
  - `InsightService`：runCycle 命中分支单测（mock 行情与 processPriceFact，断言调用与跳过分支）。
  - `StockTraceSnapshotService`：`collectInsightArticleSources` 构造/去重/无文章返回空；enriched 快照含 insight_article record。
  - `StockTraceService.processPriceFact`：`immediateEnqueue` 参数默认 false；true 时创建分支入队、已有事件 unchanged 不入队。
  - `internalRouter` 现有测试回归（endpoint 签名适配已在本次会话完成）。
- agent-py：`schemas/stock_trace.py` SourceKind 校验新增 insight_article 通过；qa_router 词条映射调整测试。
- app-frontend：AlertContent 列表渲染（只含 movements）测试更新；详情跳转统一断言。

## 8. 实施顺序建议

1. app-api：`processPriceFact` immediateEnqueue 参数 + 单测。
2. app-api：`StockTraceSnapshotService` insight_article 域 + 单测。
3. app-api：`InsightService.runCycle` 命中分支改走 processPriceFact。
4. agent-py：SourceKind 扩展 + qa_router 词条映射调整。
5. app-frontend：AlertContent 列表与跳转统一。
6. 端到端验证（涨停文章命中 → stock-trace 事件 + 归因；打点跳过已归因）。
