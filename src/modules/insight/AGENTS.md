# AGENTS.md - modules/insight（自选股洞察模块）

> 本文件是 AI 开发助手的模块入口地图，开发本模块时必读。

## 功能范围

自选股洞察：对用户自选股生成异动洞察报告，涵盖一期（涨停雷达）与二期（午盘/尾盘价格异动）：

- **一期（limit_up_radar）**：采集同花顺涨停雷达文章，命中自选股后创建事件、入队、Python 归因、推送。
- **二期（midday_price_move / close_price_move）**：午盘 11:30 / 尾盘 15:05 打点，按 `abs(move_bps) >= 700`（700 触发 / 699 不触发）触发价格异动；Node 冻结证据包（公告/新闻/业绩/研报/涨停雷达 + L2 量化联动），Python 按证据时效分层（T0/T1/T2/earnings）候选抽取 + LLM 归因 + 置信度封顶；20 分钟补抓重归因。

## 核心文件与职责

| 文件 | 职责 |
|------|------|
| `InsightService.ts` | 一期涨停雷达 runCycle、`getWatchlistSymbols`、`buildEventId`（limit_up / pm 两类事件 ID） |
| `PriceMoveService.ts` | 午/尾盘打点（`run('midday'|'close')`）、`computeMoveBps` 纯函数、快照入库、阈值触发、`refetchMiddayEvidence` 补抓 |
| `PriceEventService.ts` | `createOrUpdatePriceEvent` 幂等三分支（午盘创建 / 尾盘同向升级 / 反向独立事件） |
| `EvidencePackageService.ts` | 冻结证据包（5 来源收集 + `days_offset`/`time_bucket` 计算 + `freezeEvidencePackage` frozen_seq 版本化） |
| `SectorMarketEvidenceService.ts` | L2 量化联动证据（板块强度 ≥3% / 同行同步 ≥3 只且 ≥5% / 市场冲击 ±1.5%，腾讯免积分） |
| `InsightJobService.ts` | 任务队列（jobs + outbox → Redis Stream），`enqueue(eventId, {force?})`，`publishPending`，`reportStatus` |
| `InsightPushService.ts` | 三通道推送（WS/微信/飞书），`pushWithKind(kind)`，`isSubstantiveChange` 判定，push_records 去重 |
| `internalRouter.ts` | Python 归因专用 internal API：context / jobs 状态 / results 回写（UPSERT 前判定 changed） |
| `controller.ts` | 前端列表/详情（详情 LATERAL join 最新价格快照） |

## 数据模型（016/017 迁移）

- `watchlist_insight_events`：事件主表，唯一键 `(symbol, trade_date, direction, insight_group)`；`source_id` 可空（价格异动无文章来源）
- `watchlist_insight_sources`：一期来源文章
- `watchlist_insight_jobs` / `watchlist_insight_outbox`：任务队列（唯一键 `(event_id, analysis_version)`）
- `watchlist_insight_results`：归因结果（唯一键 `(event_id, analysis_version)`，upsert）
- `watchlist_price_snapshots`：价格快照（唯一键 `(symbol, trade_date, snapshot_type)`）
- `watchlist_evidence_packages`：证据包（`UNIQUE(event_id, frozen_seq)` 版本化）

## 关键契约

- 事件 ID：涨停 `wi_{date}_{symbol}_limit_up`；价格异动 `wi_{date}_{symbol}_pm_{direction}`（direction 进 ID 保证反方向独立）
- `insight_group`：涨停 `limit_up`，价格异动 `price_move`
- `analysis_version`：`watchlist-insight-v1`（`InsightJobService` 常量）
- 证据包条目：`{source_id, source_type, provider, title, excerpt, published_at, symbol, url, strength, days_offset, time_bucket}`；`time_bucket` ∈ T0/T1/T2/earnings
- 结果回写：`POST /internal/insight/results/external`，**`isSubstantiveChange` 必须在 UPSERT 之前计算**（否则读到的旧值是刚覆盖的新值，changed 恒 false，pushUpdated 永不触发）
- 补抓：`enqueue(eventId, { force: true })` 重置 job 为 queued 并追加新 outbox；**默认不带 force 时幂等 DO NOTHING，同版本重复入队会被吞掉**

## 依赖

- 行情：`modules/quote`（`TencentQuoteService`、`TencentKlineService`、`TushareService`）
- 共享：`shared/utils/TradingCalendarService`（`shanghaiDate`）、`core/db`、`core/redis`
- 外部：同花顺涨停雷达爬虫（一期）、财联社/东财公告/performance_reports（证据收集）、腾讯行情（免积分）
- 消费端：`aistock-agent-py` 的 `insight_worker` / `insight_candidate` / `insight_validator`

## cron 调度（index.ts 挂载，均指定 `{ timezone: 'Asia/Shanghai' }`）

| 时间 | 任务 |
|------|------|
| 交易日 11:30 | 午盘价格打点 |
| 交易日 11:50 | 午盘补抓（20 分钟窗口，重新冻结证据包 + force 重入队） |
| 交易日 15:05 | 尾盘价格打点 |

## 测试

- 运行：`node --import tsx --test src/modules/insight/__tests__/*.spec.ts`
- 类型检查：`npx tsc --noEmit`
- 仓库惯例：node:test + mock.method 拦截 pool.query / pool.connect / redis.xadd；禁止触碰真实数据库与 Redis
