# Changelog — aistock-app-api

> 所有修改记录按时间倒序排列。每条记录标注分支、时间、开发者。

## [master] 2026-10-08 — 又查实两处时区问题并修复：微信推送时间显示 UTC、insight 裸串写 TIMESTAMPTZ

**开发者**: Aria

### 修复

- **微信推送的时间显示成 UTC（用户可见，比北京时间早 8 小时）**：`modules/push/WechatPushService.ts` 有两处先用 `new Date(...).toISOString()`（**UTC 墙钟**）再交给 `formatEventTime`，于是推送给用户的「时间」比实际早 8 小时：
  - `:514` 个股情报推送的 `published_at`；
  - `:1016` 首推场景的「当前时间」（`new Date().toISOString()`）。
  - 改用 `shanghaiDateTimeStr(...)`（上海墙钟），与同模块 `MessagePushService.ts:325` 的既有口径一致。
  - 注：这与 `published_at` 的值是否正确**无关** —— 即使库里时刻正确，这两处也会把显示压到 UTC。
- **insight 来源文章的裸北京时间串直接写 `TIMESTAMPTZ`**：`modules/insight/InsightSourceService.ts` 把爬虫产出的裸串（`LimitUpRadarCrawler.ts:168` 正则提取，形如 `"2026-08-05 11:26:03"`）作为参数直接插入 `watchlist_insight_sources.published_at`（迁移 `016` 定义为 **`TIMESTAMPTZ NOT NULL`**）。裸串会被 PostgreSQL 按**会话时区**解释，而 `core/db.ts` 只传 `connectionString`（**未设** `options`/`timezone`）→ 取决于 PG 服务器默认值；若为 UTC 则整体**偏晚 8 小时**。
  - 改用刚落位的统一能力 `asBeijingAwareText()` 补 `+08:00`，使结果**与 PG 会话时区无关**（带时区/仅日期的串原样透传）。
  - 该修法在两种情形下都是改进：若 PG 本就是上海时区 → 落库**时刻不变**、只是形态带上偏移；若 PG 是 UTC → **修正 8 小时偏差**。
  - 同步更新 `src/modules/insight/__tests__/limitUpRadarCrawler.spec.ts` 中「参数顺序」断言的期望值（`'2026-08-05 11:26:03'` → `'2026-08-05T11:26:03+08:00'`）。

### 已查证但不改（澄清一次误判）

- `iterate/case_scanner.py` 的 `_parse_time` 把裸时间按 UTC 解析 —— **实测无影响，不是缺陷**：其返回值只用于**同格式值之间**的比较/差值（`_within_window`、`_in_event_window`），统一偏移相互抵消；`event_time` 输出的是**原始字符串**（`str(cluster[-1].get("time"))`），排序也是**字符串排序**，均不经过该解析结果。此前把它列为高危属**高估**。

### 验证

- `TZ=UTC` / `TZ=Asia/Shanghai` / `TZ=America/New_York` 三种环境：`pnpm test` → **1030 / 1030 / 0**（新增一条时区无关性佐证）
- `npx tsc --noEmit` → exit 0

### 未处理（已由控制者决策，见下方说明）

- **历史数据不回填**：见下条「回填决策」。

---

## [master] 2026-10-08 — 修正 crawler 时间转换的时区双重偏移（任何时区都算错，生产偏早 8h）

**开发者**: Aria

### 修复

- **`src/modules/crawler/services/EastmoneyCrawler.ts` 的 `toChinaIso()` 在任意时区都算错**（东财**公告**与东财**新闻**的 `published_at` 都经它）。原实现先按**宿主时区**解析裸时间串，再 `+ getTimezoneOffset()`（符号反了）、**又叠一次** `+8h`，构成双重调整。实测（输入 `"2026-08-12 10:00:00"`，真值应为 `2026-08-12T02:00:00Z`）：

  | 宿主 TZ | 输出 | 实际时刻 | 误差 |
  |---|---|---|---|
  | Asia/Shanghai（生产） | `2026-08-12T02:00:00.000+08:00` | `2026-08-11T18:00:00.000Z` | **−8h** |
  | UTC | `2026-08-12T18:00:00.000+08:00` | `2026-08-12T10:00:00.000Z` | **+8h** |
  | America/New_York | `2026-08-13T02:00:00.000+08:00` | `2026-08-12T18:00:00.000Z` | **+16h** |

  - **影响面**：该值写入 `stock_info_judgements.published_at`（`TIMESTAMPTZ NOT NULL`，DDL 见 `StockInfoService.ts:351`），被窗口比较（`StockInfoService` / `StockInfoPushService`）、按日分桶（`StockInfoPredictionService`）、LLM prompt 展示（`StockInfoJudgeService`）与跨服务消费（agent-py）—— 生产下 `source='eastmoney'` 的数据自 2026-07-03（`10e5f35`）起**整体偏早 8 小时**。
  - **与上一条 `asDate` 修复的区别（重要）**：`asDate` 那处依赖的是**进程 TZ**，而生产由 `src/index.ts:8` 的 `process.env.TZ='Asia/Shanghai'` 与 pm2 `env.TZ` **双重兜住**，故属**潜在脆弱**（只在测试/CI 暴露）；**本条 `toChinaIso` 与进程 TZ 无关**（双重调整使任何 TZ 都错），是**当前就生效的缺陷**。
  - **新行为**：裸串**保留墙上时间**并补固定偏移 → `"2026-08-12 10:00:00"` → `"2026-08-12T10:00:00+08:00"`（其时刻恰为真值 `02:00Z`，拼进 prompt 也读作「北京 10:00」）；**仅日期**串显式归一为 `T00:00:00+08:00`（原实现会随时区漂移）；**带 `Z` / `±HH:MM`** 的串原样透传；非法串行为不变（仍抛 `invalid eastmoney notice time`）。同时删除无效三元 `cleaned.length >= 10 ? cleaned : cleaned` 与不再需要的 `CHINA_TZ_OFFSET`。
- **把「裸北京时间串 → 带时区串」的能力上提到统一工具** `src/shared/utils/shanghaiTime.ts`，新增并导出 `asBeijingAwareText()`。该文件此前**只有 Date → 串/分量**单向能力，缺反向解析，故本次是**补齐缺口而非重复造轮子**。
  - `StockTraceSnapshotService`（提交 `15b5760` 中新增的私有同名函数）改为**引用公共实现**并删除私有副本，`asDate()` 语义不变；`EastmoneyCrawler` 共用同一实现。
  - 可复用该函数的其它模块（本次未改）：`StockInfoPredictionService`、`ClsStockNewsService`、`EventEntityService`、`EvidencePackageService`。

### 新增

- `src/modules/crawler/__tests__/eastmoneyCrawlerTime.spec.ts`（9 例）+ `src/shared/utils/__tests__/shanghaiTime.spec.ts`（10 例）。
  - 断言方式：**输出串精确相等** + `new Date(result).toISOString()` 锁死时刻 → 断言**与宿主时区无关**。
  - **RED → GREEN 已验证**：旧实现（已导出）+ `TZ=UTC` → 8 failed / 1 passed；改后 19/19 passed。
  - 此前无覆盖的原因：`toChinaIso` 是**未导出私有函数**，只经需网络的 `fetchAnnouncements` / `fetchNews` 触达；既有测试要么喂已规范的 `+08:00` 串、要么只断言 prompt 文案、要么打桩 `queryJudgements`。

### 验证

- `TZ=Asia/Shanghai` 与 `TZ=UTC` 两种环境：`pnpm test` → **1030 / 1030 / 0**（原 1011 条无改动）
- `npx tsc --noEmit` → exit 0

### 回填决策：**不回填**（已决定，附依据）

已入库 `published_at` 的错误**不回填**。依据：

1. **近期数据会自愈**：`StockInfoService.upsertJudgements` 的 `ON CONFLICT(dedupe_key) DO UPDATE SET ... published_at = EXCLUDED.published_at`（`StockInfoService.ts:409`）—— 同一公告/新闻被再次爬到时，即会用新代码覆盖为正确值。
2. **已消费的下游无法追回**：已发出的微信/飞书推送不可撤回；已转发 agent-py 的 `published_date`（`source_id=stock_info:{symbol}:{published_date}`）已参与入环与分桶 —— 回头改会让库内时间与当时的实际产出**不一致**，还可能造成重复/错位入环。
3. **改的代价与风险不对等**：偏移方向取决于 **PG 服务器的 `TimeZone`**（`core/db.ts` 未设 `options`/`timezone`，`DATABASE_URL` 示例亦未带），**无法仅从代码确定**；猜错会把 8 小时误差变成反向或翻倍。
4. **受益面有限**：仅「历史列表里旧记录的时间显示/排序」。

→ 若后续确需修正历史展示，应另立任务：**先只读诊断**（`SHOW TimeZone;` + 统计受影响行数与是否含仅日期行）→ 备份 → 再执行，并评估与 agent-py 已存记录的一致性。

---

## [master] 2026-10-08 — CI 门禁首跑红转绿：裸时间串按 Asia/Shanghai 解释（真实产品缺陷修复）

**开发者**: Aria

### 修复（产品代码 + 回归测试）

- **现象**：新增 CI（`.github/workflows/ci.yml`）首跑时 `类型检查` 通过，`node:test` 有 4 例失败——全部集中在 `stock-trace/eventStoreEvidence` 的时区相关用例；本地（Asia/Shanghai）全绿，UTC runner 上才红。
- **根因**：`StockTraceSnapshotService.asDate()` 用 `new Date(text)` 解析**不带时区**的北京时间串（如 `2026-08-12 09:00:00`）。无时区后缀时机被按**宿主机时区**解释：在 UTC 容器上比北京时间**少 8 小时**，导致「当日」采集的事件库/新闻证据落到 `capturedAt -72h ~ +30min` 窗口之外被误丢弃——**这是真实生产缺陷（K8s 容器多为 UTC），非仅有测试环境问题**。
- **修法**：新增 `NAIVE_BEIJING_DATETIME` 正则与 `asBeijingAwareText()`，把 `YYYY-MM-DD HH:mm[:ss[.SSS]]` 这类裸时间串补 `+08:00` 后再交给 `Date` 解析；带时区/`Z` 后缀的 ISO 串原样透传，行为不变。
- **回归测试**：`__tests__/eventStoreEvidence.spec.ts` 新增「时区契约」describe（2 例）：① 事件库 `scrape_at` 为北京 09:00 → 必须解析为 `01:00Z`（不随宿主机时区漂移）；② 公司域窗口：北京 10:00 的新闻相对北京 12:00 的采集必须保留。
- **验证**：改前以 `TZ=UTC` 全量复现 `fail 4`；改后 `npx tsc --noEmit` exit 0、`TZ=UTC` 全量 `1011/1011 pass`、北京时间宿主机两侧均通过。最终判据取 CI 二次运行。

---

## [junliang] 2026-10-07 — 归因失败可观测与状态区分（A/B/C）+ movements 列表过滤前置 / cursor 翻页 / 两周窗口

**开发者**: NanyuDeer

### 新增

- `stock_trace_jobs.last_error_detail TEXT`：承载 Python Agent 上报的归因失败**真实异常**（`"{异常类名}: {消息}"`，两端统一截断 500 字符）。迁移 `src/db/migrations/024_stock_trace_job_error_detail.sql` + `StockTraceJobService.ensureSchema()` 幂等 `ADD COLUMN IF NOT EXISTS` + `015_stock_trace_jobs.sql` 冷部署表定义回写。
- `analysis_status` 新增第 4 个枚举值 **`failed`**（该事件当前 `trigger_revision` 的最新 job 为 `dead_letter` 时派生）：列表侧新增 `stock_trace_jobs` 的 `LEFT JOIN LATERAL` 与 `CASE` 分支；详情侧新增 `StockTraceJobService.getLatestJobStatusForEventRevision` 并透传 `presentStockTraceAnalysis`。**优先级 `unavailable` > `failed`**（有 rejected/failed result 时不算"归因失败"，两处派生点一致）。
- `GET /api/cn/favorites/movements` 新增两个 **opt-in** 查询参数：`visible_only`（把"会被前端隐藏的行"挡在 `LIMIT` 之前）、`since=YYYY-MM-DD`（时间下界，按 `trading_date`）。
- 新增 `StockTraceJobService.getLatestJobStatusForEventRevision(eventId, triggerRevision)`。
- 测试：`__tests__/visibleOnly.spec.ts`（13 例）、`__tests__/sinceWindow.spec.ts`（14 例）、`__tests__/presentEventAnalysis.spec.ts`（2 例）。

### 变更

- `StockTraceService.listUserEvents` / `listRecentEvents` 签名增**末尾可选** `options?: { visibleOnly?: boolean; since?: string }`；`internalRouter`（agent-py 读层）**不传** → WHERE 不追加谓词、行为不受影响。
- `visible_only` 两谓词（共用常量 `VISIBLE_ONLY_PREDICATES`，零新增占位符）：
  - `NOT (a.event_id IS NULL AND rr.result_id IS NOT NULL AND (rr.validation_status='rejected' OR rr.processing_status='failed'))` —— **必须带 `a.event_id IS NULL` 守卫**：`CASE` 中"有 artifact → `completed`"优先于 `unavailable`，漏守卫会把"有有效 artifact（重新归因场景）但最新 result 被拒"的卡**静默丢掉**。
  - `(SELECT ... confidence_level ...) IS DISTINCT FROM 'low'` —— 必须放行 NULL（`<> 'low'` 对 NULL 求值为 NULL 会误隐藏"进行中"事件）。
  - 两者都**不碰 job 状态** → `analysis_status='failed'` 的行保持可见。
- `since` 谓词 `e.trading_date >= $N::date`（两处查询）；校验为「格式正则 **+** `Date.UTC` 回读三成分」，**非法值忽略**（加性参数不返回 400）。
- **cursor 契约变更**：`nextCursor` 由单值改为**复合键** `"<first_triggered_at ISO>|<event_id>"`；`ORDER BY` 增 `e.event_id DESC` tiebreaker；下页条件改行值比较 `(e.first_triggered_at, e.event_id) < ($ts, $eid)` —— 修"同一毫秒多条事件跨页漏行"（翻页是本次新引入的能力；此前 `nextCursor` 无任何消费方，故该不透明格式可自由定义）。
- `reportStatus` 增 `lastErrorDetail`，`SET last_error_detail = COALESCE($5, last_error_detail)`（**仅本次带明细时覆盖**，避免后续 `completed` 报告清空明细）；`PATCH /internal/stock-trace/jobs/:jobId` 接收 `last_error_detail` 并服务端强制截断 500。
- 列表接口透出 `confidence_level`（低置信不展示卡片的判定依据；**与 `primary_cause` 同源**，取 effective artifact 对应 result）。

### 修复

- **归因失败此前与"进行中"在接口层完全同形**（无 result → 一律派生 `processing`）→ 卡片永久显示「归因中」，且在"同日同股取最新"的展示口径下**遮住当日已有的有效归因**（表现为"总是最新一次异动卡住"）。现由 `failed` 在接口层区分，并可回退显示有效归因。
- **同毫秒事件跨页漏行**：单字段 cursor + `first_triggered_at < cursor` 会跳过并列行；已由复合键 + 行值比较修复。

### 测试

- `npx tsc --noEmit` **exit 0**；stock-trace 相关 spec 全绿（含 `listAnalysisStatus.spec.ts` 的 job LATERAL 与**分支位置**断言、`presentation.spec.ts` 的 failed/artifact 优先/unavailable 优先）。
- ⚠️ 注意：本仓**部分 spec 在 DB/Redis 可达时进程不退出**（真实 PG/Redis 连接池持有句柄），表现为命令挂住看不到汇总 —— **断言其实全部通过**，加 `--test-force-exit` 即可拿到 `ℹ tests/pass/fail`。

### 文档

- `src/modules/stock-trace/AGENTS.md`：新增 2026-10-06 与 2026-10-07 三批更新块（含 `a.event_id IS NULL` 守卫、`IS DISTINCT FROM` 放行 NULL、cursor tiebreaker、日期参数两层校验、时间窗口口径归属等易错点）。

### 实测

- `visible_only`（同账号 `limit=50`）：不带时 50 条含 **27 条 `low`**；带上后 `low` 为 0，被剔除的 27 条**全部**是 `low`，`failed` 行保留。
- `since=2026-09-24`：返回 **13 条**，无早于该日期的行；`since=2026-13-45`（非法）被忽略并等价于不传（**未 500**）。

## [master] 2026-10-06 — 收编被 glob 遗漏的 8 个测试文件 + 修正 kline 陈旧断言

**开发者**: Aria

### 改进

- **修掉测试盲区**：`package.json` 的 `test` glob 追加 `"src/**/*.test.ts"`。此前 `src/` 下按 `*.test.ts` 命名、且不在 `__tests__/` 目录内的 **8 个测试文件**（calendar ×3、core/routes ×4、fear-greed ×1）**从不被 `npm test` 执行** —— 等于永久盲区。
- `npm test` 收集量：**876 → 936 tests**（+60，恰为新收编的 8 个文件），pass 864 → 924。

### 修复

- `src/core/routes/internal.kline.test.ts`（约 L106）：断言未跟上接口契约变更 —— `GET /internal/quote/:code/kline` 自 2026-09-05 起透传 `vol` / `amount`（缺失为 `null`），期望对象补上这两个字段。

### 验证

- `npm test` → **936 tests / 924 pass / 12 fail**，12 条与基线逐条同名同源（全部位于既有 `tests/**`）→ **零新增失败**。
- `npx tsc --noEmit` → EXIT 0。

### 说明

- 只放宽 glob，未重命名/移动任何测试文件；未使用 `skip`/`todo`/注释断言；未改动任何生产代码。
- 约定提醒：后续在 `src/**/__tests__/` 下新增测试请沿用 `*.spec.ts`（Node 对重复 pattern 会去重，但统一命名更清晰）。

---

## [master] 2026-10-06 — 末项 Important 修复：sufficientSample 统一为复合判据

**开发者**: Aria

### 修复

- **问题**：`sufficientSample` 判据两侧/各桶不一致——既有聚合桶 `n>=30`，而本批新增下钻桶也是 `n>=30`，agent-py 侧聚合桶却是 `n>=30 and n_predictions>=30`。后果：同响应内会出现 `bucketStats.combined.sufficientSample=false` 而 `directionBuckets.bullish.sufficientSample=true`，且同一字段两侧判据不同 → 假信心。
- **改法（统一为复合判据）**：`publicRouter.ts` 的 `summarizeSettled`（下钻桶唯一实现）与 `bucketStats`（聚合桶）统一为 `n >= 30 && nPredictions >= 30`，`nPredictions` = 桶内**不同预测数**（按记录 id 去重）。因 app-api 的 entry 不携带记录 id，新增 `interface SettledEntry { entry; predictionId }`：`collectSlots` 槽位带 `predictionId: r.id`，`computeStats` push 时带 `row.id`，两条路径同源同值（`computeStats` 与 `bucketStats.combined` 同维桶仍相等）。
- **行为变更（有意收紧）**：既有聚合桶 `combined/index/sector` 的 `sufficientSample` 在「档位条目 n>=30 但不同预测数 <30」时由 `true` → `false`；顶层下钻桶同理。只会更保守，不会反向。判据为 `n>=30` 的真子集。

### 验证

- **测试**：`__tests__/publicRouter.spec.ts` +2（RED→GREEN：15 行 × 2 同方向档 = n30/pred15 → false；30 行 × 1 档 → true）。既有 `sufficientSample` 断言仅 `:410/:414/:992`（均 false），无需同步。
- **验证**：`npm test` → 876 tests / 864 pass / 12 既有基线失败（`publicRouter.spec.ts` 全绿，未在失败清单）；`npx tsc --noEmit` exit 0。

---

## [master] 2026-10-06 — 终评修复：I1 关键测试进入 CI + §8-3 方向/档位桶

**开发者**: Aria

### 修复

- **I1（关键假信心修复）**：`publicRouter.test.ts` / `internalRouter.test.ts` 原不匹配 `npm test` 的任一 glob（`src/**/__tests__/**/*.spec.ts` 与 `tests/**/*.test.ts`）→ 版本过滤 / long 排除 / `flat_rate` / `settled_ratio` 等关键断言**从不被 CI 执行**。**选方案 (b)**：迁入 `src/modules/prediction/__tests__/` 并改用 `.spec.ts`（对齐仓库既有布局），把原有小 spec `__tests__/publicRouter.spec.ts`（long 舍入 1 条）**合并进同名文件**，删除旧 `publicRouter.test.ts` 与 `internalRouter.test.ts`。（未选 (a) 扩展 glob：会把 `src/` 下另外 8 个既有 `.test.ts`（calendar / core-routes / fear-greed）一并扫入，风险与范围都超出本改造。）

### 新增

- **I2（§8-3 落地下钻桶）**：`publicRouter.ts` 新增共用聚合 `summarizeSettled` 与 `dimensionBuckets`：`computeStats` 与 `bucketStats` 的**每个桶**同时输出 `directionBuckets`（bullish/bearish/neutral，各带 `flat_rate`，分母 = 该方向已结算数）与 `horizonBuckets`（short/mid/long；**long 单列并标注 `iteration_board:false`**）。口径与主桶逐条一致：4.0、排除 approximate、long 不入迭代桶、无样本 hitRate=null（不用 0）、`sufficientSample=n>=30`、小数 `round4`；同响应 `computeStats` 与 `bucketStats.combined` 同维桶同值。

### 验证

- **测试**：`src/modules/prediction/__tests__/publicRouter.spec.ts` 合并后 35 条（含新增 6 条方向/档位桶用例）；`src/modules/prediction/__tests__/internalRouter.spec.ts` 35 条。
- **验证**：`npm test` → 874 tests / 862 pass / 12 既有基线失败（fail 数与基线持平；新收集的 prediction 两文件 70 条全部通过）；`npx tsc --noEmit` exit 0。（另注：全量偶见 `src/shared/utils/__tests__/jwt.spec.ts`「篡改签名」1 条 flaky，单跑 5/5 通过、二次全量回落 12，非本改动引入。）

---

## [master] 2026-10-06 — Task 10：板块 horizon `metric_projection` 透传 + long 命中率舍入结转

**开发者**: Aria

### 新增

- **改动（2 生产文件 + 2 测试）**：
  - `src/core/routes/sectorInsightRouter.ts`：`SectorInsightHorizon` 补可选 `metric_projection`；`toPredictionSummary` 的 horizon 投影新增透传（`typeof === 'string'` 且 `trim()` 非空才下发，缺失/空白即省略——方案 B 字段驱动，前端不兜底）。`metric_projection` 本就在库（prompt/schema 早已要求），无需改 prompt/schema、无需 LLM 重跑。
  - `src/modules/prediction/publicRouter.ts`（Task 5 终评 Minor 结转）：`computeStats` / `bucketStats` 两处 `long.hitRate` 用已有 `round4` 舍入到 4 位，与 agent-py `round(...,4)` 对齐（此前 long 样本非 2 的幂时 1/3 得 `0.3333333333333333` vs `0.3333`）；**主 `hitRate` 舍入行为不变**。

### 验证

- **测试**：`src/core/routes/__tests__/sectorInsight.spec.ts` +2（透传 / 缺失空白不下发，并同步主用例整形状断言）；新增 `src/modules/prediction/__tests__/publicRouter.spec.ts`（1/3 → `long.hitRate === 0.3333`）。两者均落在 `npm test` glob（`src/**/__tests__/**/*.spec.ts`）内。
- **验证**：`npm test` → 805 tests / 793 pass / 12 既有基线失败（fail 数与基线持平，新用例均被采集且通过）；`npx tsc --noEmit` exit 0。

---

## [master] 2026-10-06 — Task 5 二轮修复：long_excluded 近似排除 + 舍入对齐 + insufficient 计 pending 定调

**开发者**: Aria

### 修复

- **I2（真 bug 修复）**：`publicRouter.computeStats` 的 long 检测补 `!isApprox`（复用循环内已有的 `isApprox` 判定，与 `bucketStats.longScope` 同源）——修掉「approximate-long 令 `stats.long_excluded=true` 而 `bucketStats.combined.long_excluded=false`」的两侧不一致。新增测试断言两侧一致（均 false）。
- **I1（定义确认，不改行为）**：`computeStats` 最终 else 与 `bucketStats` pending 分支各补「为什么」注释——insufficient 属**数据可用性状态**、非**判定结论**，故计入 pending_slots。新增测试（scope={4.0 hit, 4.0 insufficient} → settled_ratio 0.5）。
- **M1（舍入对齐）**：新增 `round4`（`Math.round(x*1e4)/1e4`），对**新增字段** `settled_ratio` / `flat_rate`（computeStats + bucketStats）统一舍入 4 位，与 agent-py `round(...,4)` 同值；既有 `hitRate` 舍入行为不改。新增测试锁死 1/3 → 0.3333。

### 验证

- `node --import tsx --test src/modules/prediction/publicRouter.test.ts` → 28 passed；`npx tsc --noEmit` 通过；`npm test` → 790 passed / 12 既有基线失败（与 prediction/publicRouter 无关）。

---

## [master] 2026-10-06 — Task 5 修复：settled_ratio 统一口径 + long 命中率交付 + 计数键 snake_case

**开发者**: Aria

### 修复

- **Important 1（settled_ratio 口径统一为「声明档位槽」）**：`src/modules/prediction/publicRouter.ts`——新增 `collectSlots`（来源 = 记录声明的 `prediction.horizons`，含真 pending）与 `isSettledCurrent`；`computeStats` / `bucketStats` 分母改为「声明非-long、非-近似档位槽」，分子 = 其中 4.0 已结算（hit/miss），**旧版本已结算槽位既不入分子也不入 pending**（口径隔离）。`bucketStats` 从 verification 键枚举改为声明档枚举（顺带修正其把 c{i} 条件键误当档位的既有偏差）；同响应 `stats.settled_ratio === stats.bucketStats.combined.settled_ratio`（新增测试锁死）。
- **Important 2（long 命中率交付）**：`computeStats` / `bucketStats` 补 `long: { n, hits, hitRate }`（long + hit/miss + 4.0 + 非近似；无样本 hitRate=null）。前端 `prediction-history.vue` 展示 long 命中率与 n/hits（保留「long 档样本积累中，不参与迭代判读」标注）。
- **Minor**：① `flat_count` / `directional_count` 由 camel 改 snake（与 `settled_ratio`/`flat_rate`/`long_excluded` 一致）；② `long_excluded` 统一为「存在当前版本 long 档」（computeStats 补版本过滤，与 agent-py `_long_entries`、bucketStats 一致）。

### 验证

- **测试**：`publicRouter.test.ts` +4（真 pending 使 settled_ratio<1 且 =bucketStats.combined、旧版本已结算双隔离、long 命中率交付、无 long 样本 hitRate=null）；既有 long/flat/settled 用例同步 snake 键名。
- **验证**：`node --import tsx --test src/modules/prediction/publicRouter.test.ts` → 25 passed；`npx tsc --noEmit` 通过；`npm test` → 790 passed / 12 既有基线失败（与 prediction/publicRouter 无关，且该测试文件不在 npm test glob 内）。

---

## [master] 2026-10-06 — Task 5：long 档不计入迭代看板 + 补看板指标（computeStats / bucketStats）

**开发者**: Aria

### 新增

- **改动（1 文件 + 1 测试文件）**：`src/modules/prediction/publicRouter.ts`——`computeStats` / `bucketStats` 排除 `long` 档（`long_excluded` 标记），并按 agent-py 同口径新增 `settled_ratio`（已结算 / 全部非-long 档位，含未结算 pending）、`flat_rate`（分母 = 方向预判已结算数）、`flatCount`、`directionalCount`；`flat` 标记从 entry 读（由 agent-py 写入侧落库，app-api 不自行算 k）；新增 `BucketStats` 类型（三桶同形）。
- **口径**：`flat_rate = flatCount / directionalCount`（direction 从 entry.direction 读）；无方向样本 → null。`settled_ratio` 分母含未结算档位；无档位 → null。**观察项（保持原样）**：`computeStats.hitRate` 无样本返回 null，而 `bucketStats.hitRate` 返回 0 —— 口径不一致，本任务不改，留待后续。

### 验证

- **测试**：`publicRouter.test.ts` +4（long 排除且命中率不含 long、flat_rate 分母、无方向样本 null、settled_ratio 含 pending + 空档位 null）。
- **验证**：`node --import tsx --test src/modules/prediction/publicRouter.test.ts` → 21 passed；`npx tsc --noEmit` 通过；`npm test` → 790 passed / 12 既有基线失败（与 prediction/publicRouter 无关，且本测试文件不在 npm test glob 内）。
- **未提交**：无（随本任务 commit 提交）。app-frontend 两处改动（PredictionStats 可选字段 + long 文案）按任务约定未由本仓提交。

---

## [master] 2026-10-06 — 个股情报入环 P2：研判落库后自动入验证环

**开发者**: Aria

### 新增

- `modules/crawler/services/StockInfoPredictionService.ts`：取「该 symbol 当日最强口径」候选（一条批次 SQL：`DISTINCT ON (symbol, published_at 上海自然日)` + 强度排序），随后逐个转发 agent-py `from-stock-info`；本服务**不做门槛/映射/`due_dates`**，`ingest` 全程 fail-safe（只 `console.warn`、绝不抛）。
- `shared/utils/stock.ts#normalizeStockSymbol`：抽出写库侧与入环侧**共用**的符号归一化（吃掉 `SH600383` / `600383.SH` 等前后缀），消除「写库成功、入环侧严格匹配失败」的静默漏入环。
- `modules/crawler/StockInfoService.ts`：`upsertJudgements` 研判落库成功后调用 `StockInfoPredictionService.ingest(rawItems)`（旁路、不阻断落库）。

### 修复

- 转发响应处理：仅 `status='skipped'` 且 `reason_code='below_threshold'`（门槛未达）静默；`invalid_input` / `unmapped_value` / 缺失或未知 `reason_code`、非 2xx、网络异常、解析失败、`saved` 但 `record` 为空，一律告警（文案带 `symbol` / `reason_code` / `reason`）。此前所有 `skipped` 一律静默 → 映射失败无人知。

### 验证

- 新增 `modules/crawler/__tests__/stockInfoPrediction.spec.ts`（候选聚合与去重、SQL 契约、上海自然日、符号归一化、`defaultForward` 四分支告警语义、fail-safe）。
- `npx tsc --noEmit` = 0；`npm test` = 802 / 790 / 12（基线 796 / 784 / 12 → **新增失败 0**；12 条既有失败与本次无关）。

### 说明

- 入环记录 `source_type='stock_info'`；**入环门槛唯一判定点在 agent-py**（本仓只做候选聚合与转发）；未改表结构、无迁移。
- **尚未部署**；部署顺序必须**先 agent-py 后 app-api**（详见 agent-py 同批条目）。

---

## [master] 2026-10-06 — 准确性体检修复：event_entities 补列 + 登录后「个股情报」归属双通道

**开发者**: Aria

### 修复

- **event_entities 缺 `impact_sectors` 列（fix1，100% 恢复）**：迁移 `023_event_entities_impact_sectors.sql` 从未在生产库执行（本仓 migrations 为人工 psql、无启动自动执行器）→ 列缺失 → news 通道事件物化全部 `502 column "impact_sectors" does not exist`、`event_entities` 自 2026-09-24 停更。已在生产库执行 `ALTER TABLE event_entities ADD COLUMN IF NOT EXISTS impact_sectors JSONB NOT NULL DEFAULT '[]'::jsonb`（非破坏性）。9/24–10/06 未持久化的历史事件不在库中，无法从库精确补跑，后续每日抓取自动恢复。
- **登录后「个股情报」空数据 —— `user_stocks` 归属读取统一为双通道**：统一账户模型下自选股归属为「`user_id`（主）+ `openid`（兜底）」，但合并账户（`auth/accountMerge.ts`）把自选股写为 `user_id` 有值 + `openid = NULL`，而部分读取端**仅按 openid 过滤** → 命中 0 行；手机号账户（`users.openid IS NULL`、JWT `openid=''`）在 openid-only 读取端更是永远查不到。
  - `src/modules/monitor/controller.ts`：`requireAuth` 由「仅取 `payload.openid`」改为 `id = payload.id ?? payload.openid`（与 `SmsAuthController.resolveAuth` 对齐），返回 `{ id, openid }`。
  - `src/modules/monitor/service.ts`：`getEventsByUserFavorites(userId, openid, ...)`，自选股按 `user_id = $1 OR (user_id IS NULL AND openid = $2)`。
  - `src/modules/insight/internalRouter.ts`：列表/详情 JOIN 改 `us.user_id IN (SELECT id FROM users WHERE openid=$1) OR (us.user_id IS NULL AND us.openid=$1)`。
  - `src/modules/insight/InsightPushService.ts`、`src/core/notification/NotificationService.ts`、`src/modules/push/WechatPushService.ts`、`src/modules/push/MessagePushService.ts`：fan-out（WS / 站内通知 / 微信 / 飞书）的自选股归属同样改双通道。

### 验证

- 新增 `src/modules/monitor/__tests__/controller.spec.ts`（3 例：未登录 401 不触库 / 手机号 token 按 `user_id` 命中 / 旧微信 token 回填），更新 `src/modules/insight/__tests__/internalRouter.spec.ts` 断言；目标 4 个 spec **31/31 通过**，`tsc --noEmit` exit 0。
- 生产库数据修复：`user_stocks` 按 `users.openid` 回填 **5 行**（`d173015e`），全库 `openid IS NULL` 12 → 7（余 7 行属 `users.openid` 本身为空的账户，由代码双通道兜底）；复核 18907076228 命中 5 支自选股、15999539553 命中 6 支（旧口径 0 支）。
- 全量 `npm test` 失败 12 例为**既存基线**（`tests/*.test.ts` 陈旧 import 路径等），与本次无关。

---

## [xusiyun] 2026-10-02 — 重大事件时间线：Calendar 物化方案废弃，改为读时直查

**开发者**: xusiyun

### 重构

- **Calendar 事件改为读时直查（物化方案废弃）**：删除 `modules/event-entities/CalendarEntityMaterializer.ts` 及其单测，把确定性准入（`qualifyCalendarEvent`：`importance='high'` 或 `source='L4'`）内联进 `EventTimelinePublicRouter`；`GET /api/agent/event/timeline` 请求时直查 `market_calendar_events`（与节奏大师同源，`listEvents` 口径），并排除 `event_entities` 中残留的 `source_type='calendar'` 行以防重复。收益：不再依赖物化 cron，calendar 变更实时生效；`event_entities` 不再写入 calendar 行。
- `src/index.ts`：移除 `CalendarEntityCron`（06:40/12:40/18:40）与 `CalendarEntityMaterializer` 导入。
- 口径保持：calendar 直查行不参与传导报告增强查询与 occurred 存在性校验（恒无传导报告，已发生的 calendar 行不展示——未来事件提前可见的原有定位不变）。

### 修复

- `__tests__/event_timeline.spec.ts`：TIMESTAMPTZ=Date 回归用例的夹具由硬编码绝对日期（2026-10-01 / 2026-10-20）改为**相对当前时间的未来 date-only 日期**（今天+7 / 今天+14）。原夹具随时钟推进会过期——date-only 事件次日 0 点起变 occurred，随即命中「occurred 必须有传导报告」准入被排除（2026-10-02 该用例实际失败：夹具 2026-10-01 已变为已发生）。

### 清理（物化废弃后的残留）

- 删除 `scripts/materialize-calendar-entities.ts`：该脚本只服务已废弃的物化流程，且其 `import` 的 `CalendarEntityMaterializer` 已删除——因 `tsconfig.include` 仅覆盖 `src/**/*`，`tsc` 不检查 `scripts/`，属静默失效（运行时必挂）。
- 根 `AGENTS.md`（模块表 / 目录树 / §8 定时任务速查表）与 `README.md`（模块表 / 目录树）：同步「Calendar 物化」→「Calendar 读时直查」，并标注原 `06:40/12:40/18:40` cron 已移除。

### 验证

- `node --import tsx --test src/modules/event-entities/__tests__/event_timeline.spec.ts` → **5 passed / 0 failed**（修复前 4 passed / 1 failed）
- `tsc --noEmit` → exit 0；`node --import tsx --test tests/timelineRouteOrder.test.ts` → 1 passed
- 全仓无 `CalendarEntityMaterializer` / `materializeCalendarRows` 残留引用

---

## [master] 2026-09-27 — 修复「注册已注册手机号显示注册失败」（生产 P0）

**开发者**: Aria

### 修复

- **注册/登录 500 根因（表所有权导致启动迁移静默失败）**：`src/index.ts` 启动期 `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT` 以非 `users` 表 owner 的角色执行时抛 `must be owner of table users`，被 `console.warn` 静默吞掉 → `password_hash` 列永不存在 → 注册/登录命中 `column "password_hash" does not exist`，返回 500「注册失败，请稍后再试」。生产库已补齐该列，并将 15 张表 / 2 个序列所有权转移给应用角色 `aistock`。
- **迁移失败不再静默**：`password_hash` 迁移失败日志由 `console.warn` 升级为 `console.error`；新增 `information_schema.columns` 显式自检，列缺失时打印可直接执行的修复 SQL，避免再次带旧 schema 运行。
- **次生根因（PG `name[]` 未被 node-postgres 解析导致迁移崩溃、外键被丢弃）**：`users 统一账户模型` 迁移用 `array_agg(att.attname ...) AS columns`，返回 PG `name[]`，node-postgres 不解析该 OID 回传原始字符串 → `fk.columns.join is not a function`；崩溃点位于「摘除外键之后、重建之前」，导致 4 张表指向 `users(openid)` 的外键被丢弃且未重建。修复为 `array_agg(att.attname ORDER BY ord.ordinality)::text[]`。
- **外键完整性恢复**：重建被丢弃的 4 个外键（`user_notifications.openid` / `user_subscriptions.user_openid` 沿用 `ON DELETE CASCADE`；`user_stocks.openid` / `user_settings.openid` 为 `NO ACTION`），并经重启迁移端到端验证「发现 → 解析列 → 摘除 → 重建」全链路成功。

### 文档

- `AGENTS.md` §8：新增「启动时 users 账户模型自动迁移」条目，标注应用角色 owner 权限硬要求。
- `README.md` 部署段：新增「运维要求（2026-09-27）」，说明部署前须确保 `aistock` 角色对相关表拥有 owner 权限。
- `project_memory.md`：记录「表所有权 + 启动内联迁移陷阱」与「node-postgres 不解析 `name[]`」两条教训。

### 验证

- 生产重启（2026-09-27 20:08:58）日志：出现 `[DB] users: 摘除引用 openid 的外键 user_notifications(openid); user_settings(openid); user_stocks(openid); user_subscriptions(user_openid)` 与 `[DB] users 统一账户模型 ready`；error.log 不再出现 `f.columns.join is not a function` 及 `must be owner of table ...`。
- 重启后 `pg_constraint` 中指向 `users` 的外键仍为 4 条，`ON DELETE` 语义与修复前一致。
- 注册 SQL 事务回放（`BEGIN … ROLLBACK`）：已注册手机号（无密码）→ 1 行（HTTP 200）；已注册手机号（有密码）→ 0 行（HTTP 409）；全新手机号 → 1 行。
- 线上 HTTP：`POST /api/auth/password/login` 不存在账号 → 401；`POST /api/auth/register` 弱密码 → 400，均无 500。

---

## [feat/auth-hardening] 2026-09-27 — 密码认证加固后续（频控时序 / scrypt 并发 / 防刷原子性）

**开发者**: Aria

### 修复

- **登录/注册频控计数原子性（M1）**：`loginThrottle.redisIncr` 由「`INCR` 后 `count === 1` 再 `EXPIRE`」两条命令改为单条 Lua 脚本原子执行（含 `TTL < 0` 自愈历史无 TTL 键），消除进程中断导致计数键无 TTL、账号永久 429 的缺陷；`redisIncr` 导出并可注入最小客户端接口 `ThrottleRedisClient`，Redis 集成边界首次可单测。
- **scrypt 事件循环阻塞**：`passwordUtils` 的 `hashPassword` / `verifyPassword` / `verifyPasswordConstantTime` 由 `scryptSync` 改为线程池版 `crypto.scrypt`（异步），新增 `MAX_CONCURRENT_SCRYPT = 4` 在途并发上限；`PasswordAuthController` 调用点补 `await`。
- **注册频控配额被误耗**：注册计数由「入口即计数」后移到验证码通过之后，未通过验证码的尝试不再占用配额，杜绝他人用错验证码把目标账号配额打满。
- **测试后门过宽**：`SmsAuthController` / `EmailAuthController` 的 `verifyCode`、`bindWechat` 双身份判定与 `ws/handler.ts` 的 `user_<openid>` 本地联调前缀，统一收紧为仅 `NODE_ENV === 'test'` 生效。

### 重构

- `loginThrottle`：抽出 `isThrottledFor` / `recordAttempt` / `clearCount` 参数化内部函数，六个公开函数改为薄封装；名字/签名/常量/前缀均未变，行为等价。

### 文档

- `src/modules/auth/AGENTS.md`：修正密码登录与频控口径（删除「同 IP」「降级验证码登录」描述），补充注册频控与 `passwordUtils` 异步并发说明。

### 测试

- 新增 M1 Lua 原子性（可注入假客户端）、注册频控（错误验证码不消耗配额 / 通过后超限 429 与复位）、`NODE_ENV=development` 下万能码与 `user_` 前缀被拒等用例；注册频控集成用例改用每次运行唯一账号，消除 Redis TTL 残留污染。定向 auth 68 例全绿，`npx tsc --noEmit` exit 0，全库 `npm test` 保持基线（既有 12 例失败，无新增）。

---

## [junliang] 2026-09-26 — 洞察报告 PDF 改 SSE 流式 + 章节结构化 blocks + stock-trace 事件载荷补齐

**开发者**: 李俊良

### 新增

- `GET /api/cn/favorites/movements/:eventId/report/stream`（SSE）：完整洞察报告改为分块推送，替代原 `report.pdf`。**前置校验（401 未登录 / 404 无归属 / 409 无有效归因 / 502 agent-py 不可用或结构非法）全部在开流前完成，失败返回真实 HTTP 状态码 + JSON**；仅开流后的异常走 `data: {"type":"error"}` 兜底。`REPORT_SECTION_INTERVAL_MS = 80` 控制节间节奏（模板构建是毫秒级的，不加节奏前端会"瞬间铺满"），15s `: keep-alive` 心跳，`finally` 清心跳 + `res.end()`。
- `InsightReportService.fetchSections(data)`：调 agent-py `POST /api/agent/insight-report/sections`（`X-Internal-Token`，10s 超时），含**上游边界归一化**（章节缺 `blocks` 或非数组 → 补 `[]`，`sections` 非数组抛错转 502）。
- `ReportBlock` 判别联合（`kv`/`verdict`/`candidates`/`chain`/`evidence`/`list`）与 `ReportChainStage` / `ReportKvItem` 类型；候选项补 `statusKey`（机器值，供前端做中性弱化判定，避免匹配中文标签、改文案即静默失效）。
- 设计文档 `docs/superpowers/specs/2026-09-25-insight-report-streaming-design.md`（含 §11 blocks 演进 / §12 App 端双通道演进）。
- 测试 `stock-trace/__tests__/eventPayloadFields.spec.ts`（8 例）。

### 变更

- `StockTraceController.report()`（PDF 下载）→ `reportStream()`（SSE）；`src/index.ts` 路由同步更换；`InsightReportService.renderPdf` 删除、改为 `fetchSections`。
- section 事件由 `lines` 改为 **`blocks`** 透传（`data: {"type":"section", index, heading, blocks}`）。
- `StockTraceService`：`listUserEvents` / `listRecentEvents` 的 SELECT 增选 `e.window_end_at`（前端"最近异动时刻"语义真正生效）；`toPublicEvent` 增出 `is_limit_up`、`analysis_status` 由硬编码 `'pending'` 对齐为 `'processing'`；`buildTriggerEvent` 透传 `isLimitUp`。`types.ts` 的 `TriggerEvent` 增可选 `isLimitUp?`。

### 修复

- 测试环境耦合红：`listAnalysisStatus.spec.ts` 的 fixture 注释声明"与 SELECT 列一致"却缺 `window_end_at`；`eventStoreEvidence.spec.ts` 被本机 `.env` 的 `AGENT_PY_URL` 盖过 `PYTHON_AGENT_URL`（读库 base URL 解析顺序为 `AGENT_PY_URL || PYTHON_AGENT_URL`）导致 URL 前缀断言失败 → 改为 `beforeEach` 把两者同时指向测试地址。

### 测试

- `npx tsc --noEmit` **0 错误**；`insightReport.spec.ts` 8 → **11 例**（成功用例断言 `blocks` 原样透传含 `chain.stages[0].stageKey`，新增归一化 3 例——归一化用例最初误写在 controller 层，但该层 `fetchSections` 被整个 mock 掉、测不到，已移到服务层 mock `axios.post`）；stock-trace 相关 spec 全绿。

### 文档

- `modules/stock-trace/AGENTS.md` 新增 09-24 / 09-25 / 09-26 三批更新块。

## [master] 2026-09-26 — 密码注册 / 密码登录 + 登录防刷（含防刷松绑与存量账号首次设置密码）

**开发者**: Aria

### 新增

- `POST /api/auth/register`（手机号 / 邮箱 + 密码注册，注册即登录；原子 upsert `ON CONFLICT ... DO UPDATE SET password_hash = EXCLUDED.password_hash WHERE users.password_hash IS NULL`，已设密码命中 0 行 → 409「该账号已设置密码」）与 `POST /api/auth/password/login`（密码登录，接入 `loginThrottle` 防刷）。
- 登录失败计数 `loginThrottle`（Redis 优先 + 内存 Map 兜底，与 `smsCodeStore` 同策略）：账号维度计数，窗口 900s。
- 密码散列工具 `passwordUtils`（scrypt，零依赖）。
- `src/index.ts`：注册上述路由；幂等迁移 `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`。

### 改进

- **防刷松绑**：`FAIL_MAX` 2 → 10，并**删除 IP 维度**（`isThrottled` / `recordFailure` 去掉 `ip` 入参，收敛为仅账号维度），避免 NAT / 共享出口误伤。
- 密码登录 429 不再返回 `data.fallback`，文案改为「尝试过于频繁，请稍后再试」，不再引导降级验证码登录。
- `GET /users/me` 加性新增 `hasPassword`（`(password_hash IS NOT NULL)`），与 `phoneBound` / `emailBound` 同范式，不破坏既有消费方。

### 测试

- `login-throttle.spec.ts`（3 例，仅账号维度 / 阈值 10）、`password-auth.spec.ts`（9 例，429 无 `fallback` + 新文案）、`me-is-vip.spec.ts`（3 例回归）全绿；`npx tsc --noEmit` exit 0。

## [xusiyun] 2026-09-25 — 重大事件时间线影响板块 + Calendar 物化 + 事件来源名对齐

**开发者**: xusiyun

### 新增

- 新增 `event_entities.impact_sectors` 列（migration 023，`JSONB NOT NULL DEFAULT '[]'`）：时间线展示层「事件关联/预期影响板块」，与 Event Conduction 的 `impact_industries` 语义区分，允许为空。
- 新增 `EventTimelinePublicRouter`：`GET /api/agent/event/timeline`，影响板块优先级为「传导 chain Top3（impactStrength 降序）> `impact_sectors` 列 > 空」；occurred 事件须存在 event_conduction 报告否则排除；标题展示层与传导报告对齐。
- 新增 `CalendarEntityMaterializer`：Calendar 行确定性准入（`qualifyCalendarEvent`）→ Event Entity 物化（幂等 upsert）。
- 新增 `scripts/materialize-calendar-entities.ts`：手动物化脚本（支持 `--dry-run`），部署后不必等 cron。
- `index.ts`：挂载 timeline 路由（须在反代之前）+ 注册 06:40/12:40/18:40 物化 cron。

### 修复

- 事件列表 `source_name` 改用 `resolveArticleSourceName` 域名兜底，与详情(Article)接口一致（此前同一事件列表显示「未知来源」、详情显示媒体名）。
- 补齐 `GET /internal/insight/sources` 路由：此前缺失导致 Python 侧 `collect_ths_original` 恒 404、同花顺原创源静默为空。

### 改进

- `EventEntityService`/`EventEntityInternalRouter`：`impact_sectors` 归一化（`normalizeImpactSectors`）+ upsert CASE 保护（防 Calendar 物化 cron 覆盖预计算结果）+ POST 参数校验（非数组 400）。

### 测试

- `CalendarEntityMaterializer.test.ts`、`__tests__/event_timeline.spec.ts`（4/4 通过：标题对齐、板块优先级、IN 标量参数、传导存在性过滤）。

---

## [changer] 2026-09-22 — 节奏大师·事件前瞻主体化（日历侧）

**开发者**: 37588

### 新增

- 事件日历表新增 `result_source`/`result_attempted_at` 两列：预期差闭环的结果来源标注（自动/人工）与结果尝试时点（日内重试留痕）；存量已落结果的事件按「人工」来源回填一次。
- 新增内部删除接口 `DELETE /internal/calendar/events`：按（日期 + 标题）服务端计算去重键幂等删除，供候选清场 / 误录清理。
- 事件日历网格口径放开：由类型白名单改为**按重要性过滤（≥medium）**，财报 / 种子类事件在日历网格可见；单日显示上限 3 条，超出折叠为「+N」占位（防密集日刷屏）。
- 预期差判定链路支持 `importance=high` 过滤读取，并透传事件原始日期（隔夜事件按展示日与原始日分离）。

### 改进

- 事件标题归一化增强：剥离平台后缀（Moomoo / 东方财富等）与尾部栏目片段，修复标题带不同后缀导致同一事件重复入库的问题；近似重复在同一日期下**读侧合并展示**（保留较高重要性、优先含结果行），历史数据不重写。
- 重大事件保护：已录入 `high` 级别的事件，任何来源（含抓取）不得降级、不得改写其来源（写侧 CASE 保护）。

---

## \[changer\] 2026-09-19 — 板块日 K 接口日期契约双侧兼容（X1）

**开发者**: 37588

### 修复

- `GET /internal/ths/:code/daily` 此前仅接受紧凑 `YYYYMMDD`，Python 侧（节奏大师主线候选）传 ISO 连字符日期时**恒 400**（已用路由测试实测复现 `400 !== 200`），导致 5 个主线候选取数全败、主线不可用。现路由同时接受 `YYYYMMDD` 与 `YYYY-MM-DD`，并在 `ThsBoardService.getBoardDailyRange` 边界统一归一为紧凑格式后再取数（归一放在 service 边界，未来任何调用方传 ISO 也不会再失败）。

### 新增

- 跨语言日期契约测试（`internal.ths.test.ts`）：ISO 入参须 200 且下游取数层收到归一后的 `YYYYMMDD`；紧凑格式行为不变（回归护栏）；非法格式（位数不足）仍 400。

## \[master\] 2026-09-18 — `sector-insight` 报告侧摘要改为 conclusion 优先（不再落到「触发」）
## \[junliang] 2026-09-18 — 修复异动归因卡住（cron 竞态 + outbox 无重试）+ 资金证据结构信息补齐


**开发者**: Aria

### 修复


- `extractTraceSummary` 优先取报告 `conclusion`（agent-py 新增的一句话归因结论），无则回退 trigger headline（无则第一个 stage），取不到仍返回 `null`（不编造）。
- `extractPerSectorTraceEntries` 摘要取源改为 `conclusion` → 顶层 `summary`（旧数据兼容）→ `extractTraceSummary`，修掉此前 `top` 压过 conclusion 的顺序问题；与 agent-py `_trace_summary` 报告侧优先级对齐。
- 根因：`SectorChainResult` 此前无结论字段，报告侧摘要只能落 trigger 段 headline（原因第 1 段），导致三处折叠卡显示的都是「触发」。响应契约未变（结论折进 `trace.summary`），`aistock-app-frontend` 0 改动。

### 测试

- `src/core/routes/__tests__/sectorInsight.spec.ts` +2 例（先红后绿）：conclusion 优先于 trigger / conclusion 空白回退 trigger / conclusion 与顶层 summary 同时存在时 conclusion 赢。
- `node --import tsx --test src/core/routes/__tests__/sectorInsight.spec.ts` 24 pass / 0 fail；`npx tsc --noEmit` exit 0。
- **归因卡住根因：收盘落定与收盘打点同 cron 表达式竞态**（`src/index.ts`）：close 打点（`runPriceMoveDetect('close')`）与收盘落定（`StockTraceService.settleActiveEvents`）曾同为 `5 15 * * 1-5` 并发。落定仅一两条 UPDATE（很快），打点要遍历自选股 + 采快照（数秒），于是落定插进打点中途把当日 active 事件关闭并入队，打点随后为同一标的**又建一条事件** → 该事件永远停在 `active`、无 job / 无 outbox；前端同日聚合取最新且 `processing` 不算"不可归因" → 卡片恒显"归因分析中"（2026-09-18 蓝盾光电 300862、海正生材 688203 实测）。**判别特征**：同标的当日出现两条 15:05 事件；events 有 active 行但 jobs 无对应 `(event_id, trigger_revision)`；outbox 无行。
- **修复方式**：落定并入 close 打点的 `finally` 串行 `await`，保证"先建齐当日事件、再落定"的时序；独立落定 cron 由 `5 15` 后移到 `10 15` 作兜底（`settleActiveEvents` 幂等，可重复调用）。
- **outbox 发布失败无任何重试入口**（`src/index.ts` 新增每分钟 `StockTraceOutboxCron`）：`stock_trace_outbox` 行 `status='pending'` + `last_error_code='Error'`（Redis 命令失败的 `error.name`）+ `attempt_count` 停住后，因 `publishPending` 只在 enqueue / 快照采集完成等事件路径被顺带调用，该行再无重试入口、可永久滞留（2026-08-25 已复现过一次，当时靠人工重发）。新增周期冲刷后实测自动补发成功。

### 改进

- **capital 证据补齐结构信息**（`StockTraceSnapshotService`）：抽出导出纯函数 `toCapitalSourceRecord`（对齐 `toInsightArticleSourceRecord` 约定），透出原先被丢弃的 `orders`（超大单/大单/中单/小单）与 `windows`（1/5/10/20 日拆解），正文改为 `截至 {tradeDate}：主力净流入…；分单结构…`。原因：agent-py 侧资金维度降级为条件准入层后，只有"价格读不出的增量信息"才可能被置 supported/weak，否则恒为 insufficient；正文标注 `trade_date` 用于时效分档判定。
- **清理陈旧能力标记**（`StockTraceResultService`）：删除 `missingCapabilities: ['capital_flow_disabled']` 硬编码（`runRuleFallback` / `acceptExternalResult` 共 4 处）与 `ValidationInput.missingCapabilities` 字段——资金流数据已实际采集，该标记会使 sector/market 的 `missing_counter_evidence` 反证校验被永久跳过。配套 agent-py 侧提示词与 validator 镜像同一规则，避免"未引用反证的 supported 候选"被拒后 `processing_status` 变 `partial`（→ 无 artifact → 报告端点 409）。
- `InsightReportService` 文件注释口径同步为"分层候选"。

### 文档

- `src/modules/stock-trace/AGENTS.md`：登记 cron 竞态与 outbox 滞留的根因、判别特征与修复；登记 capital 降级口径、证据结构补齐与陈旧能力标记清理。

### 测试

- `__tests__/snapshot.spec.ts`：新增 capital 映射用例（orders/windows/trade_date/正文标注）。
- `__tests__/result-validator.spec.ts`：删除 `capital_flow_disabled` 例外用例，新增 market 层反证不可绕过用例。


---

## \[changer\] 2026-09-18 — 节奏日历网格增加交割日标记

**开发者**: 37588

### 修复

- 节奏日历网格此前只下发宏观事件，导致状态卡上出现的交割日在日历中缺失（同一窗口两处口径不一致）：网格改为合并规则计算出的交割日并放开交割日类型；财报与种子事件仍不下发（量大、噪音高）。

### 改进

- 每个日期的日历可见事件恒下发事件列表字段（无事件为空数组），并同步模块接口说明。

## \[master\] 2026-09-16 — 磁盘治理 + API 暴露面安全加固 + 部署脚本修复

**开发者**: Aria

### 安全加固（响应老师「API 被外部盗用」）

- `src/index.ts`：监听地址 `0.0.0.0` → `127.0.0.1`。此前 app-api 以公网直连方式暴露 `56790`，OCR(OpenAI 视觉)/个股中长线分析(QWEN LLM)/批量刷新等高成本接口在 index.ts 原全无鉴权，外部可直连白嫖烧钱——老师说法有据。现仅经 Caddy 反代 `gupiao-api.yaozhineng.com → 127.0.0.1:56790` 对外；确需直连可用 `HOST` env 显式覆盖。
- 新增 `src/shared/utils/requireLogin.ts`：Express 登录守卫中间件（JWT **或** `X-Internal-Token` 二选一放行，复用 extract→verify→isTokenRevoked）。挂载到 `admin/trigger-price-update`(原完全无校验)、`profit-forecast/batch`、`ocr`、`performance-reports/refresh`、`capital-flow/batch-prefetch`、`:symbol/analysis`(GET+POST)、`:symbol/mid-long/:timeframe`(POST)、`trend-score/refresh`、`trend-score/batch`。
- 生产内部 token 核实为强随机值（非默认），历史是否真被外部盗刷需 Caddy 访问日志事后验证（配置片段已提供）。

### 磁盘治理（复盘 9 月磁盘满事故）

- 根因：磁盘 100% → PG/Redis 停机 → 登录/识图全挂。实测 pm2 日志仅 32K 非主因；真大头是**已下线十倍股模块遗留的废弃表 `tenx_scores`（11GB，app-api 源码 0 引用）**。
- 运维（服务器 `docker exec`）：`DROP TABLE IF EXISTS tenx_scores CASCADE`，表已删除，磁盘 106G→95G used、可用 7.5G→19G（94%→84%）。
- `trend_scores`（4.7GB）为活跃在用（analysis-agent/internal 读取 dim_scores/description/ai_conclusion），按要求未改动；其 `raw_data` 列经核查只写不读，留作后续可选优化。

### 修复

- `deploy/deploy.sh`：重启名 `aistock-api`→`aistock-app-api`（旧名命中空名致安全修复无法生效、误启重复实例）。

### 测试

- 新增 `src/shared/utils/__tests__/requireLogin.spec.ts`（6 用例：内部 token 放行/不匹配 401/无凭据 401/有效 JWT 放行注入 user/伪造 401/过期 401 全绿）；`npx tsc --noEmit` 0 errors。

### 待办（管理员 root）

- Caddy 访问日志开启（防/留痕外部盗用；配置片段见 CHANGELOG 下发给运维），部署需 `git pull && pm2 restart aistock-app-api` 使 loopback 与鉴权生效。

***
## \[changer\] 2026-09-15 — Event Entity 端点落地 + design-debate R2 收口

**开发者**: 37588

### 新增

- `/internal/event-entities` 端点：`migration 019`（`event_entities` 权威表：event_id PK 不可变随机 ID、canonical_event_key 唯一幂等、event_status display-only 快照、时间三件套 TIMESTAMPTZ）+ `EventEntityService`（确定性 `computeEventStatus` 纯函数、`normalizeTitle`/`canonicalKey`、`upsertEventEntity` ON CONFLICT、`listEventEntities`）+ `EventEntityInternalRouter`（POST 物化 / GET 列表，信封恒 code:200，独立 internal token）+ `index.ts` 挂载。
- 表达式索引 `(date(event_start_time AT TIME ZONE 'Asia/Shanghai'), event_status)`，查询过滤与其逐字一致走索引。

### 修复

- **R2 G1（design-debate）**：`isDateOnly` 兼容 pg 读回 JS `Date`（上海时区墙钟判定）——裸 `pg.Pool` 读回 TIMESTAMPTZ 为 Date 对象，原字符串正则使读时重算的 date-only 分支成为死代码，当天事件白天误判 `occurred`；现签名放宽 `string | Date | null`。
- **R2 G2**：`normalizeTitle` 保护数字小数点（`数字.数字` 形态）——「1.5万亿」与「15万亿」不再误并同一 canonical_key。
- **R2 G3**：日期过滤由 `to_char(CAST(... AS date))` 改为 `date(...) >= $N::date`，与索引表达式一致走索引。

### 测试

- `tests/event-entities.service.test.ts`：9 用例（status 四边界 + Date 输入回归 + normalizeTitle 噪声/小数点 + canonicalKey 确定性），9/9 通过；`tsc --noEmit` / `npm run build` 0 错误。
- 本地真实 HTTP 联调通过（信封 code:200 / 幂等重放 / 当日 ongoing 边界 /「1.5万亿」≠「15万亿」/ scheduled+occurred 双态）。

### 状态

- 本地验收通过；待组长 merge 后对生产库 `psql -f` 应用 019 迁移，agent-py `EVENT_ENTITY_ENABLED` 翻 True 走生产联调。

---

## \[changer\] 2026-09-10 — 指数日 K 接口区间语义回归测试

**开发者**: 37588

### 测试

- 为指数日 K 接口补充区间语义回归：只传结束日期时，接口返回**不晚于该日期的最近 N 根**行情；结束日期落在非交易日时同样不返回空，而是回落为最近可用行情。
- 该语义是节奏大师收盘基准“当日行情是否就绪”判定的前提，加测试锁定以防后续改动悄悄翻转行为。
- **仅新增测试**，服务端生产逻辑零改动。

### 状态

- 本地代码验收通过（**待生产验证**）：该测试文件 8/8 通过，类型检查 0 错误。

---
## \[changer\] 2026-09-05 — 指数日 K 接口透传 vol/amount（修复量能伪分支）

**开发者**: 37588

### 修复

- `modules/quote/TushareKlineService.ts`：`getIndexKLine` 行规范化提取为纯函数 `normalizeIndexKLineRow` 并**加性透传 `vol`/`amount`**（Tushare index_daily 原始单位 vol=手、amount=千元；缺失如实为 null，不误填 0）。此前 service 层 map 丢弃量能字段，`GET /internal/index/:code/kline` 返回行恒为 null，导致 Python 节奏大师量能维度缺失、成交额分支退化为 `>0亿` 伪分支（2026-09-05 生产核实）。
- `core/routes/internal.ts` `/internal/index/:code/kline` 的"加性透传 vol/amount"注释与实现现已一致，路由逻辑零改动。

### 测试

- 新增 `src/modules/quote/__tests__/TushareKlineService.spec.ts`（3 用例：vol/amount 透传、缺失→null、无 pct_chg 由 pre_close 推算）；`internal.index-kline.test.ts` 6 用例回归全绿；`npx tsc --noEmit` 0 errors。

***

## \[changer\] 2026-09-04 — 修复 attributionChainRouter TS2742 编译错误

**开发者**: 37588

### 修复

- `src/core/routes/attributionChainRouter.ts`：`export const attributionChainRouter = Router()` 补显式类型注解为 `export const attributionChainRouter: Router = Router()`（对齐仓库既有 router 声明惯例），消除 TS2742（pnpm 隔离 `@types/express-serve-static-core` 下推断类型不可移植）；`npx tsc --noEmit` 0 errors。

***

## \[changer] 2026-09-04 — 节奏日历聚合自然日模式（含周末）

**开发者**: 37588

### 新增

- `modules/calendar/publicRouter.ts` GET `/api/agent/rhythm-master/calendar` 新增 `naturalDays=N` 查询模式：返回最近 N **自然日**网格（含周末/节假日），逐日 `{date, refresh_slot:'after_close', level, score, basis_date, position_band, events}`；周末/无档 `level=null` 灰格如实展示但 events 仍按自然日关联（macro，含 US 隔夜顺延后的反应日）；dates 降序（新→老），与 `loadMacroEventsByDate`（from=dates\[last]/to=dates\[0]）方向一致

### 修复

- `modules/calendar/publicRouter.ts` naturalDays 分支日期生成改用上海本地日期格式化（`shanghaiTime`），消除 `toISOString()` 的 UTC 漂移（东八 00:00-08:00 窗口日期偏移一天，导致周末/今日归属错标）

### 文档

- `modules/calendar/AGENTS.md`：补充 naturalDays 模式契约说明；既有 `days=` 交易日模式保持不变（向后兼容）

## \[feat/fear-greed-node] 2026-09-03 — 修复 sectors 软失败入缓存冻结 + 统一降级返回结构

**开发者**: superpowers-implementer（评审修复）

### 修复

- `src/modules/fear-greed/FearGreedService.ts` `getSectorBoardData`：仅 `availability:true` 的健康结果写入 10 分钟缓存；双源软失败（`availability:false`，非异常）不再写缓存——此前会把降级结果冻结 10 分钟、前端建议一直卡在静态 fallback，现在失败数据直接透传、下次请求自然重试；同时增加可选 `loaders` 参数（默认 `defaultLoaders`）便于测试注入 stub

- `src/modules/fear-greed/sectorBoard.ts`：新增统一兜底 `unavailableBoard()`（EMPTY\_BOARD + tradeDate 填当日），`buildSectorBoardData` 软失败路径复用

- `src/modules/fear-greed/controller.ts` `sectors` catch：删除硬编码空结构，改经 service 复用 `unavailableBoard()`，两层降级 tradeDate 语义一致（填当日）

### 测试

- `tests/fear-greed.sector-cache.test.ts`（新增）：软失败不写缓存（随后健康调用真正重取）/ 10 分钟内命中缓存不重取 / TTL 过期重取 / 失败体 `availability:false` 且 `source:''`，共 4 用例；用 `node:test` `mock.timers(apis:['Date'])` 控制时间免真实等待

***

## \[feat/fear-greed-node] 2026-09-03 — 新增 GET /api/fear-greed/sectors（板块行情榜，配置方向数据源）

**开发者**: 林晓研

### 新增

- `GET /api/fear-greed/sectors`：返回当日板块 top 涨幅/主力净流入/跌幅/净流出榜（camel 契约）；主源东财概念板块 clist（`EmSnapshotService.getConceptFlow`），腾讯板块榜兜底（`TencentSnapshotService.fetchTencentSectors`），独立 10 分钟缓存；失败返回 `availability:false` 不阻塞主数据（`sectorBoard.ts` + `FearGreedService.getSectorBoardData` + `controller.sectors`）

### 测试

- `tests/fear-greed.sector-board.test.ts`：东财四榜/腾讯兜底/双源失败降级 3 用例

***

## \[feat/fear-greed-node] 2026-08-24 — 综合指数双层百分位排名（展开被压缩的分布）

**开发者**: 林晓研

### 重构

- `src/modules/fear-greed/indicators.ts`：新增纯函数 `compositeOfRawAvgs`——对逐日 rawAvg（各指标百分位等权平均）序列再做百分位排名，返回 `{ composite, scores }`（scores 与输入同序，`composite = scores[0]` 即最新日在其余历史日中的排名；样本 <30 时退回 rawAvg 防抖）

- `src/modules/fear-greed/calculator.ts`：`computeJq` 综合指数从「平均直出」改为双层百分位：`rawAvg = average(各指标当日百分位)` → `composite = percentileRank(rawAvg)`。背景：9 指标等权平均后方差被压缩（σ/√9），直出指数天然收窄到 \[33,67]（中性附近失真）；二次百分位后历史最恐惧日 → ≈0、最贪婪日 → ≈100，分布自动覆盖 0-100，无需手工调参

### 验证

- `tests/fear-greed.indicators.test.ts`：新增 `compositeOfRawAvgs` 用例（压缩序列 \[46,54] 中历史极值日被展开到 ≈0/≈100、composite==scores\[0]、空序列中性 50）

- `tests/fear-greed.calculator.test.ts`：补充集成断言 composite == history.scores\[0] 且历史两端覆盖 ≤10/≥90（2/5 新增；全套 5/5 通过）

***

## \[changer] 2026-09-02 — 节奏日历聚合接口扩展逐日建议仓位（position\_band）

**开发者**: changer-collab

### 新增

- `publicRouter.ts` GET `/api/agent/rhythm-master/calendar` SQL 级 JSONB 投影追加 `position_band`（`content->'rhythm_card'->'position_band'`，向后兼容：旧行/缺失返回 null）；`mergeRhythmCalendarDays` 透传 `RhythmPositionBand`——供前端详情页顶部日期条与首页近 5 日节奏卡展示建议仓位

### 文档

- `src/modules/calendar/AGENTS.md`：职责与接口表补充日历聚合行 + `position_band` 契约

## \[changer] 2026-09-02 — 节奏大师事件日历稳定排序（锚点单一来源）

**开发者**: changer-collab

### 改进

- `listEvents` 排序改为 `ORDER BY event_date ASC, event_time ASC NULLS LAST, title ASC`（三键稳定排序；与 internalRouter GET /events 的 date 主键 JS 稳定排序共同构成 rhythm `high_events`/`next_event_anchor` 的单一来源）（`MarketCalendarEventService.ts`）

### 测试

- `internalRouter.test.ts`：SQL 排序契约正则 + GET /events 下发顺序 HTTP 实测（同日期保留 DB 行次序）2 用例

### 文档

- AGENTS.md：关键契约追加 listEvents 排序契约行

## \[master] 2026-09-01 — Spec B 个股 K 线数据源（验证环个股粒度接入）

**开发者**: Aria

### 改进

- `src/core/routes/internal.ts`：GET `/internal/quote/:symbol/kline` 新增可选区间参数 `start_date`/`end_date`（YYYYMMDD）——存在时按区间过滤 rows、days 忽略（有边界时 `getKLine(limit=0)` 拉全量再按区间过滤，对齐 index 端点 H9 语义）；响应 rows 加性透传 `vol`/`amount`

- 供 agent-py `prediction_validator._fetch_kline_window` stock 分支拉取 \[due-20, due+10] 窗口

### 测试

- `tsc --noEmit` 通过

***

## \[changer] 2026-08-31 — 预测验证写入改造（TradingVane 研报借鉴 v2 A1/A3）

**开发者**: changer-collab

### 改进

- `appendVerification` 改顶层 `verification` 列 jsonb 按 horizon 原子合并写（`|| jsonb_build_object + COALESCE`，防并发读改写覆盖其他档位）（`PredictionRecordService.ts`）

- PUT /internal/predictions/:id/verification 契约放宽：`type=early_exit` 时 result 可缺省（早退标记 entry 不参与 status=verified 判定；`VALID_RESULTS` 迁入 service 避免循环依赖）（`internalRouter.ts`）

- 透传验证 entry 扩展字段（methodology\_version/baseline\_neutral/target\_type 等，A3 命中率统计口径依赖，此前被截断）（`internalRouter.ts` + `PredictionVerificationEntry` 索引签名）

### 测试

- `internalRouter.test.ts` 新增 entry 扩展字段透传回归；`prediction-record-service.spec.ts` 原子合并写/early\_exit 不置 verified/全 verified 翻牌

### 文档

- AGENTS.md：Internal API 表 PUT 行 + prediction\_records 说明块更新

## \[master] 2026-08-31 — 短信验证码接入阿里云"号码认证·短信认证"（真实下发）

**开发者**: Aria

### 新增

- `SmsService.sendViaAliyun` 由占位改为真实调用 `dypnsapi.SendSmsVerifyCode`（`src/core/sms/SmsService.ts`）：用 RAM 凭证 +「恒创联众」签名 + 预置模板，把本地生成的验证码经 `TemplateParam` 下发到手机（阿里云作发信通道，不在服务商侧自动生成）；`send` 新增 `scenario` 场景参数（`login`/`bind`），按场景选模板（登录 100001 / 绑定 100004）；新增 `resolveTemplate` 依场景解析模板 code

- `sendSms` 支持可选 `body.scenario`（`src/modules/auth/SmsAuthController.ts`），`bind` 走绑定模板

### 改进

- 依赖：`package.json` 新增 `@alicloud/openapi-core`（dypnsapi 依赖其 `$OpenApiUtil.Config`）

- `.env.production`：追加 `SMS_PROVIDER=aliyun` + RAM AccessKey/Secret + `SMS_SIGN_NAME=恒创联众` + `SMS_TEMPLATE_CODE=100001` + `SMS_TEMPLATE_BIND=100004`（该文件被 git 忽略，已在服务器直接修改并 `pm2 restart --update-env` 生效）；`.env.example` 补充说明

### 测试

- `tsc --noEmit` 通过；sms-auth 8 个测试全过（dev 分支不受影响，未真发短信）

***

## [junliang] 2026-08-30 — 涨停雷达并入 stock-trace 链路（统一事件与归因）

**开发者**: Aria

### 变更
- `InsightService.runCycle` 命中自选股不再建 `watchlist_insight_events`（存量保留），改拉腾讯行情构造 `PriceFact` 走 `StockTraceService.processPriceFact(security, fact, { immediateEnqueue: true })`——建 `stock_trace_events` mv 事件并**盘中立即归因**；行情缺失或涨跌幅 <7% 的命中跳过（当日由午尾盘打点兜底）。
- `StockTraceService.processPriceFact` 新增可选第三参 `{ immediateEnqueue }`：true 时创建分支在 COMMIT 前入队（既有 publishPending 发布），默认 false 保持"事件落定后统一归因"策略。
- `StockTraceSnapshotService` 快照采集新增 **insight_article 证据域**：读当日 `watchlist_insight_sources` 命中该股的同花顺涨停雷达文章（标题/正文/URL/关键词），并入 enriched/corrected 快照供五层归因参考；候选层仍强制五层不变。
- 归因链路统一为 stock-trace 五层候选；"同股同向已归因（文章盘中触发）则午尾盘打点跳过"由 revision 幂等机制天然实现。

### 测试
- `processPriceFactImmediate.spec.ts`（immediateEnqueue 三场景）、`insightArticleEvidence.spec.ts`（insight_article 映射/复用）、`radarToStockTrace.spec.ts` + `runCycleEnqueue.spec.ts` 更新（runCycle 命中走 stock-trace）。

---

## [junliang] 2026-08-30 — 实时价格检测默认停用（自选股洞察仅保留午尾盘打点+涨停雷达）

**开发者**: Aria

### 变更
- `src/index.ts`：`PriceTriggerDetector.start()` 启动条件由默认开启改为 **opt-in**（`STOCK_TRACE_TRIGGER_ENABLED === 'true'` 才启动）。盘中假动作多（每 5 秒轮询产生 9:15/9:16 等盘中任意时间戳事件），自选股洞察仅保留午尾盘打点（11:30/15:05 cron）与涨停雷达（runInsightCycle 10 分钟轮询）。
- 手动触发接口保留：`POST /internal/stock-trace/detect`（绕过交易时段强制检测）、`POST /internal/stock-trace/jobs/publish`，作应急调试用。

---

## [changer] 2026-08-30 — 节奏日历聚合接口 + 报告 TTL 参数化（design-debate）

**开发者**: changer-collab

### 新增

- `GET /api/agent/rhythm-master/calendar?days=N` 节奏日历热力图聚合接口（契约 #7）：最近 N 个交易日（默认 60，≤60）after\_close 收盘基准档位；SQL 级 JSONB 投影 level/score/basis\_date；`(report_date AT TIME ZONE 'Asia/Shanghai')::date` 对齐上海日期；level 可空契约；纯函数 `mergeRhythmCalendarDays`（`publicRouter.ts`）

### 改进

- 报告持久化 TTL 按 report\_type 参数化：rhythm\_master=90 天（支撑日历窗口），其余类型维持 7 天；upsert SQL 双改（INSERT+DO UPDATE）`make_interval(days => $10)`（`internal.ts` `getReportTtlDays`）

### 测试

- `internal.report-type.test.ts`（TTL 90/7）、`calendar.rhythm-calendar.test.ts`（merge 补位/透传）

### 文档

- `README.md` 路由表 + internal 表同步

***

## \[junliang] 2026-08-27 — 个股异动溯源只读端点（阶段 2.2 读层）

**开发者**: Aria

### 新增

- `src/modules/stock-trace/internalRouter.ts`：只读端点 `GET /internal/stock-trace/events?openid=&symbol=&limit=`（复用 `StockTraceService.listUserEvents` 后按 symbol 内存过滤；openid 必填 400、symbol 可选——为空返回该用户全部异动溯源、limit 默认 50 上限 100）——供 agent-py 对话 `stock_trace_lookup` 读层 skill 使用；另加 `queryStr`/`errMsg` 帮助函数

### 测试

- `src/modules/stock-trace/__tests__/internalRouter-events.spec.ts`：openid 缺失 400（不触库）、列表 limit 透传、symbol 过滤

***

## \[junliang] 2026-08-27 — 洞察只读端点（阶段 2.1 读层）

**开发者**: Aria

### 新增

- `src/modules/insight/internalRouter.ts`：只读端点 `GET /internal/insight/events?openid=&symbol=&limit=`（自选股洞察列表，openid 归属过滤、symbol 可选、limit 默认 50 上限 100）+ `GET /internal/insight/events/:eventId?openid=`（详情，openid 归属校验无归属 404 + 最新证据包）——供 agent-py 对话读层 skill 使用

### 测试

- `src/modules/insight/__tests__/internalRouter.spec.ts`：openid 缺失 400、列表过滤、详情归属 404

***

## \[junliang] 2026-08-27 — 预测公开统计按验证口径版本过滤（阶段 0）

**开发者**: Aria

### 改进

- `src/modules/prediction/publicRouter.ts`：新增 `CURRENT_METHODOLOGY_VERSION='2.0'` 常量 + `versionOk` 版本判定（旧记录无 `methodology_version` 兼容视为 2.0）；`bucketStats`/`computeStats` 命中率按版本过滤（3.0 记录隔离防混桶），档位进度 `verifiedHorizonCount` 全量（版本无关）

### 测试

- `src/modules/prediction/publicRouter.test.ts`：版本过滤用例（2.0 计入 / 3.0 隔离 / 无版本兼容）+ 门禁断言 `hitRate === bucketStats.combined.hitRate`

## \[master] 2026-08-27 — 财报披露更新：disclosure\_date 权威发现源 + 预披露提醒 + 四源增量架构

**开发者**: Aria

### 重构

- `src/modules/monitor/PerformanceReportAutoUpdateService.ts`：放弃"候选池"方案（旧方案拉研报+自选股候选名单逐只查三接口，候选数×3 次调用，且依赖研报导致正式财报滞后——多氟多 8.18 披露 8.21 才发现），改为**按日期增量发现、各类型只查自己的发现源**：

  - 业绩正式报告（formal）：`disclosure_date.actual_date`=昨日 全市场发现 → 对命中股票逐只拉 `income` 明细（income 不能批量只能按股，故只在 discovery 命中时拉）

  - 业绩预告（express←forecast）：`forecast.ann_date`=昨日 批量发现（行内自带净利润范围+摘要）

  - 业绩快报（express←express\_vip）：`express_vip(end_date=最近两个报告期)` 全量分页，客户端过滤 `ann_date`=昨日（快报无法按 ann\_date 批量）

  - 研报评级（rating）：`report_rc.report_date`=昨日 批量发现

  - 各源 INSERT+通知，已存在（symbol+report\_type+ann\_date）跳过，通知 sourceKey 幂等；昨日四源均无新增时用前 2 个自然日窗口重扫补漏

  - `disclosure_date.pre_date` 额外推送"预计披露日"前瞻提醒（仅订阅者，sourceKey 按 symbol+end\_date 幂等，occurredAt=pre\_date）

### 新增

- `src/modules/quote/TushareService.ts`：新增 `getDisclosureDate`（`disclosure_date` 接口，可无 ts\_code 全市场按 pre\_date/actual\_date/end\_date 批查）、`getForecastByAnnDate`（`forecast` 按公告日批查）、`getExpressVip`（`express_vip` 按报告期全量分页）

### 验证

- 关键事实（实测）：`forecast`/`report_rc`/`disclosure_date` 可按日期全市场批查；`express_vip` 按 end\_date 全量（不按 ann\_date）；`income`/`cashflow`/`balancesheet`/`express` 必须传 ts\_code。快报(express)与预告(forecast)目标公司基本不重叠（银行/券商常发快报但从不发预告），两者都需要

- 实测：`disclosure_date actual_date=20260826` → 738 条，`pre_date=20260828` → 725 条（均未披露）；`npx tsc --noEmit` 通过

***

## \[xusiyun] 2026-08-27 — 文章接口完整发布前回归测试（35 用例全覆盖）

**开发者**: Siyun

### 测试

- `src/core/routes/__tests__/event_article.spec.ts`：扩展至 **35 条**本地 mock 回归用例，覆盖 `GET /api/agent/event/:eventId/article` 所有正常/异常/降级路径（不连库、不部署、不入生产库）：

  - **匹配规则**：财联社 newsId→payload.id 精确 / 非财联社 url 精确 / title 归一化及互为子串模糊匹配 / newsId 解析失败回落 url

  - **正文形态**：空字符串 / null / payload 缺失 / payload 非对象 / content 非字符串（String 化）/ events 缺失或非数组 / events 含 null 子项

  - **数据缺失**：source 空 / event\_scrape 不存在 / 非财联社无命中 / content 整行为 null

  - **多条记录**：多 event\_scrape 跨日合并匹配 / 同一事件多份取最新 / events 内多事件不被无关项误匹配（newsId 精确）

  - **日期**：PG Date 对象 / 'YYYY-MM-DD' / 时区 ISO / String(Date) / 非法日期跳过 SQL / 跨月 / 跨年 shift ∓1 天

  - **SQL 异常**：event\_scrape / event\_conduction 查询异常仍正确 500；非法日期空窗口不构造 SQL

  - **实时兜底**：mock ClsStockNewsService.getNewsFulltext 覆盖抓取成功 / 抛异常降级 / 返回空 content 降级

  - **SQL 修复回归**：无 `= ANY($n)`、日期参数全标量、占位符数===参数数（42P18）；无 RangeError/Invalid time value

- 回归确认：`event_conduction.spec.ts` 23 条用例全部通过；前端 `vue-tsc --noEmit` 零错误

- 验证方式变更：既有 D 场景原本会触发真实 `getNewsFulltext` 网络调用，现改为 mock，消除测试不确定性

***

## \[xusiyun] 2026-08-27 — 文章接口本地验证测试（42P18 / DATE / 匹配规则）

**开发者**: Siyun

### 测试

- `src/core/routes/__tests__/event_article.spec.ts`：为 `GET /api/agent/event/:eventId/article` 新增 10 条本地 mock 验证用例（monkey-patch pool.query，不发真实 DB 连接，无需生产部署即可回归）：

  - 财联社事件命中 event\_scrape.payload.content → hasContent=true

  - 非财联社事件按 url 精确命中 → hasContent=true

  - event\_scrape.payload.content 为空 → hasContent=false 降级（不 500）

  - event\_scrape 无命中 + 实时兜底失败 → hasContent=false（不 500）

  - report\_date 为 Date 对象 / 字符串 → normalizeArticleDate 均正常输出，无 Invalid Date / RangeError

  - source 为空 → hasContent=false；eventId 不存在 → 404

  - title 归一化匹配（含空白差异）

  - SQL 回归：event\_scrape 用 IN 标量展开、参数为标量（修复 42P18）

- 回归确认：`event_conduction.spec.ts` 23 条用例全部通过

***

## \[xusiyun] 2026-08-27 — 事件原文接口修复 PostgreSQL 42P18（event\_scrape 匹配参数）

**开发者**: Siyun

### 修复

- `src/core/routes/internal.ts`：`GET /api/agent/event/:eventId/article` 中 event\_scrape 匹配查询，将 `= ANY($2)` 数组参数改为 IN 标量参数展开（`$1,$2,...`）。node-postgres 将 JS 字符串数组作为单个参数传给 `= ANY()` 时服务端无法推断参数类型（42P18），必然 500；改为标量参数后类型由 date 列推断，同时移除无用的 eventId 参数（event\_scrape 按 report\_date 分区，SQL 仅需 scrapeDates）

***

## \[master] 2026-08-25 — 短信服务生产接入骨架（本期不真发）

**开发者**: Aria

### 变更

- `src/core/sms/SmsService.ts`：生产接入骨架——从环境变量读取并校验短信配置（`SMS_PROVIDER=aliyun|tencent` + 凭证/签名/模板/region），`send` 按 dev（日志回显+测试码）/ 生产（未配置抛明确错误、已配置走渠道分发）分流

- 阿里云 / 腾讯云渠道接入点（`sendViaAliyun` / `sendViaTencent`）已留 TODO 与官方 SDK 接入注释；本期不真发（需企业签名 + 验证码模板审核，见设计 §9），配置后仍抛"渠道未启用"由前端展示明确错误

- `.env.example`：补充短信配置项注释说明

***

## \[master] 2026-08-25 — 短信验证码登录 + 手机/微信统一账户模型（双向绑定）

**开发者**: Aria

### 背景

- 此前仅支持微信测试号登录，用户以 openid 为唯一标识；新增「手机号 + 短信验证码登录」，且手机号账户与微信账户可双向绑定，保留原微信登录信息

### 数据库（幂等迁移，启动时执行，index.ts ensureSchema 风格）

- `users`：主键从 openid 切换为不可变 `id`（UUID，存量行回填 `gen_random_uuid()`）；`openid` 改可空并建非空唯一索引；新增可空唯一 `phone`；预留 `unionid`

- 迁移前先摘除引用 `users(openid)` 的外键（user\_notifications/user\_subscriptions/user\_stocks），重建主键后按原 ON DELETE 语义还原

- `user_stocks`：新增可空 `user_id` 列；放宽 `openid` 非空；分别建 `(openid,symbol)` / `(user_id,symbol)` 部分唯一索引；回填老微信自选股到对应 `user_id`

### 新增

- `src/core/sms/SmsService.ts` + `src/core/sms/smsCodeStore.ts`：验证码生成/存储（Redis 优先 + 内存兜底，5 分钟 TTL、单次消费防重放、60s 同号限流 3 次）、SmsService 发送抽象（dev 日志回显 + 固定测试码 `SMS_DEV_TEST_CODE`=123456，生产预留接入真实服务商）

- `src/modules/auth/SmsAuthController.ts`：`POST /api/auth/sms/send` 发码、`POST /api/auth/sms/login` 手机号登录（无账户自动创建，`ON CONFLICT (phone)` 原子处理并发首登，Web 端同设 httpOnly Cookie）、`POST /api/auth/bind/phone` 绑手机、`POST /api/auth/bind/wechat` 绑微信（手机+验证码证明归属）

- `src/modules/auth/__tests__/sms-auth.spec.ts`：8 条用例覆盖发码/限流/登录/绑定/冲突 409/未登录 401

### 变更

- `src/shared/utils/jwt.ts`：JWT payload 增加 `id`（兼容旧 openid token，鉴权信任 JWT）

- `src/modules/auth/controller.ts`、`scanLoginController.ts`：微信登录/扫码登录适配统一账户模型（UPSERT 返回 id、JWT 带 id、扫码登录设 httpOnly Cookie）

- `src/modules/auth/userController.ts`：requireAuth 用 JWT `id` 定位用户（旧 token 回退 openid），`/users/me` 查库返回 id/phone

### 冲突策略（设计 §5）

- phone/openid 已属其他 id → 409 拒绝 + 引导文案，不做自动合并；老微信用户正路：先微信登录一次再绑手机号，即可保留原微信数据

***

## \[junliang] 2026-08-24 — 归因校验规则放宽 + 异动列表按最近触发时间排序

**开发者**: Aria

### 改进

- `src/modules/stock-trace/StockTraceResultService.ts`：归因校验放宽（2026-08-21 决策）——sector/market 候选未声称驱动（非 supported）或资金流数据缺失（`capital_flow_disabled`）时不强制反证，避免板块候选已明确"非主要驱动"仍被窗口内反向小板块事实阻塞

- `src/modules/stock-trace/StockTraceService.ts`：movements 列表（`listUserEvents`/`listRecentEvents`）新增返回 `window_end_at`，供前端按"最近触发时间"排序展示，长窗口事件不再按首次触发沉底

### 测试

- `src/modules/stock-trace/__tests__/result-validator.spec.ts`：校验单测同步——supported 需反证、非 supported 不阻塞、capital\_flow\_disabled 跳过反证

***

## \[master] 2026-08-24 — 涨跌停微观指标改为 daily 自行推导（替代 limit\_list\_d）

**开发者**: 林晓研

### 重构

- `src/modules/fear-greed/calculator.ts`：涨跌停微观数据源从 `limit_list_d`（limit\_status 字段需 2000 积分，当前账号被置空）改为 **Tushare** **`daily`** **全市场按日推导**：

  - 涨停封板 = 收盘价达涨停价（按板块 10%/20%/30% 阈值，不含 ST 5%）

  - 炸板 = 盘中触涨停价但收盘未封

  - 跌停 = 收盘价达跌停价

  - 连板高度 = 按全窗口封板序列回放（连续封板累加、断板归 1）

- `src/modules/fear-greed/calculator.ts`：新增 `LimitCache` 接口与 `deriveDailyLimit`/`fetchLimitData`（增量缓存 + 连板回放）；`computeJq` 增加 `limitCache` 参数

- `src/modules/fear-greed/FearGreedService.ts`：新增 `limit_daily` 表（seal\_count/break\_count/down\_count/seal\_codes JSONB，供连板回放）+ `limitCache` 实现

- `src/index.ts`：启动时后台预热恐贪指数（首跑需逐日拉取全市场 daily \~500 交易日，避免首个 HTTP 请求超时）

### 验证

- 真实数据推导数量合理：涨停 42-89 只/日、炸板 19-61、跌停 13-143（8/19 大跌日 143 跌停）

- `tests/fear-greed.calculator.test.ts`：mock daily 增加按日分支、新增 limit 缓存用例（5/5 通过）

***

## \[master] 2026-08-24 — 修复恐贪指数被中性兜底指标稀释导致数值虚高

**开发者**: 林晓研

### 修复

- `src/modules/fear-greed/calculator.ts`：综合指数等权平均前先过滤**无真实数据**的指标（`history.scores` 为空的兜底中性项）。此前 `limit_list_d` 权限缺失时 4 个微观指标（封板率/炸板率/涨跌停比/连板高度）恒为中性 50，会把恐惧市（宏观指标约 15 分）的综合指数稀释到 \~30，与市场实际恐贪水平（7-8）偏差过大

- 过滤后综合指数仅由有数据的指标构成（如微观不可用时退化为 5 个宏观指标等权），与历史序列已有的过滤逻辑保持一致；全数据缺失时兜底 50

***

## \[feat/fear-greed-micro] 2026-08-24 — 恐贪指数支持每日3次 intraday 快照 + 历史快照接口

**开发者**: 林晓研

### 新增

- `src/modules/fear-greed/FearGreedService.ts`：`getHistory(days)` 返回结构扩展为 `{ index_key, dates, composite, snapshots }`，其中 `snapshots` 为每日 3 次（pre/noon/post）intraday 快照，供前端绘制盘中粒度短热度线

- `src/modules/fear-greed/FearGreedService.ts`：`buildDashboard()` 新增 `historySnapshots` 字段，调用 `getHistory(60)` 返回近 3 个月快照集合，供前端图表直接消费（无需额外 API 调用）

### 变更

- `src/modules/fear-greed/FearGreedService.ts`：`refreshJq(timeSlot)` 接受 `'pre' | 'noon' | 'post'` 参数并透传到 `getLatestJq(true, timeSlot)`，确保各时段 cron 落库到对应 `time_slot`

- `src/index.ts`：`runFearGreedRefresh(label, timeSlot)` 接受 timeSlot 参数，3 个 cron 任务分别传入 `'pre'` / `'noon'` / `'post'`，使盘前/正午/盘后快照正确分桶存储

***

## \[feat/fear-greed-micro] 2026-08-24 — 恐贪指数盘前/正午/盘后三次定时刷新

**开发者**: 林晓研

### 新增

- `src/index.ts`：新增 3 个 cron 定时任务（周一至周五，跳过节假日）——盘前 09:15、正午 11:30、盘后 15:30 各调用 `refreshJq()` 重新采集 + 计算 + 落库 + 更新缓存，替代原仅按需计算的模式

***

## \[feat/fear-greed-micro] 2026-08-24 — 恐贪算法增强：新增涨跌停微观结构指标

**开发者**: 林晓研

### 新增

- `src/modules/fear-greed/calculator.ts`：新增 4 个涨跌停微观结构指标（封板率 seal\_rate / 炸板率 break\_rate / 涨跌停比 limit\_ratio / 连板高度 streak），数据源 Tushare `limit_list_d`；合成指数由 5 宏观指标扩展为 9 指标（5 宏观 + 4 微观）等权平均

- `tests/fear-greed.calculator.test.ts`：mock `limit_list_d` API 响应，断言更新为 10 指标

### 变更

- `src/modules/fear-greed/calculator.ts`：`limit_list_d` 不可用时 4 个微观指标降级为中性值（score=50），不影响主流程；composite 合成改为 9 指标平均

## \[master] 2026-08-24 — 报告导出会员解锁 + 分时 K 线数据源修复

**开发者**: NanyuDeer

### 新增

- `users` 表与 `GET /api/users/me` 新增 `is_vip` 会员标记（默认 false，反向兼容），供报告导出会员解锁；新增 `src/modules/auth/__tests__/me-is-vip.spec.ts`。

- 分钟级（klt<100）K 线改走腾讯 `kline/mkline` 接口：`TencentKlineService.buildMinuteUrl/arrayRowsToKLine`，controller 分时路由切腾讯，保证 mini 分时图数据非空；新增 `src/modules/quote/__tests__/tencent-kline-minute.spec.ts`。

***

## \[master] 2026-08-21 — 修复风口龙头板块实时行情显示昨日数据

**开发者**: Aria

### 修复

- `src/modules/monitor/RotationBoardStore.ts`：

  - 根因：`fetchBoardRealtime` 用 `last.js` 的"最后两根"推导，但 `last.js` 盘中最后 bar 是**昨日**（`today` 字段仅标注日期，不含当根实时 bar），导致板块一直显示昨日的涨跌幅/成交额。

  - 新增 `TODAY_URL`（同花顺 `bk_<code>/01/today.js` 当日实时 JSONP）与 `parseTodayRealtime`（解析 `{"1":日期,"11":现价,"19":成交额(元)}`）。

  - 重写 `fetchBoardRealtime`：并行拉 `last.js`（昨收=日期严格早于今日的最后一条 close）与 `today.js`（今日实时价 + 成交额），`change_pct=(现价-昨收)/昨收*100`。

- 验证：881175 医疗服务 today.js 解析得 date=20260821、现价 20597.772、成交额 46533482000、当日涨跌幅 -3.87%；`npx tsc --noEmit` 无错误。

***

## \[master] 2026-08-21 — 异动归因改为落定后触发一次

**开发者**: Aria

### 改进

- `src/modules/stock-trace/StockTraceService.ts`：

  - `processPriceFact` create/revision 分支**移除即时** **`StockTraceJobService.enqueue`**（盘中只采集快照 + 实时推送，不再每次 revision 都跑 LLM 归因）；

  - 反向落定：关闭相反方向 active 事件的 UPDATE 加 `RETURNING`，在同一事务内对落定事件 `enqueueFinalAnalysis`；

  - `startRecovery` close UPDATE 加 `RETURNING`，恢复窗口到期落定后触发一次最终归因；

  - 新增私有 `enqueueFinalAnalysis`（无 client 时自建短事务保证 job+outbox 原子）与 `triggerFinalAttribution`（入队后 `publishPending`）；

  - 新增公开 `settleActiveEvents()`：强制落定当日仍 active 的事件并触发最终归因，返回落定数。

- `src/index.ts`：新增 15:05 工作日 cron 调用 `StockTraceService.settleActiveEvents()` 作收盘兜底（防 5 分钟恢复窗口在收盘前未到期而漏归因）。

- 幂等：`UNIQUE(event_id, trigger_revision, analysis_version, job_kind)` + `SELECT FOR UPDATE`，同一事件只入队一个最终归因 job；Python consumer `SNAPSHOT_NOT_READY` pending reclaim 适配落定即入队。

### 测试

- 新增 `__tests__/final-attribution.spec.ts`（5 例：落定归因一次 / 无落定不入队 / 收盘兜底 / 兜底空跑 / enqueue 幂等）。

- 验证：`npx tsc --noEmit` 通过；stock-trace 39 例全绿。

***

## \[master] 2026-08-21 — 恐贪指数接口漏挂修复（温度计恒为默认值12、点击无页面）

**开发者**: Aria

### 修复

- 根因：`/api/fear-greed` 路由在 `src/index.ts` **从未挂载**，`ensureFearGreedSchema()` 也从未调用——controller 已实现但未接线，前端请求 404 退化为默认值12。

- `src/modules/fear-greed/controller.ts`：新增导出 `fearGreedRouter`（GET `/dashboard`、`/indexes`、`/history`、POST `/refresh` 公开路由）。

- `src/index.ts`：挂载 `app.use('/api/fear-greed', fearGreedRouter)`（publicRouter 之后）；`start()` 建表块新增 `ensureFearGreedSchema()` 调用（仿 feishu 模式，失败仅 warn 不阻断启动）。

- 验证：`npx tsc --noEmit` 退出码 0。

***

## \[master] 2026-08-20 — 收盘复盘改进方案：东财快照源接入 quick 链路（EM 主源 + 腾讯兜底）

**开发者**: Aria

### 新增

- `src/modules/quote/EmSnapshotService.ts`：封装东方财富实时快照数据源（免逆向）。

  - `getLimitPools`：push2ex `getTopicZTPool`/`getTopicDTPool`(sort=zdp)/`getTopicZBPool`(sort=zbc)，连板取 ZT 池 `lbc` 最大值；三池独立 `Promise.allSettled`，partial 时字段为 null

  - `getConceptFlow`：push2 `clist m:90+t:3` 概念资金流，本地按涨跌幅/净额各自独立排序（gainers/losers/inflows/outflows）

  - `getIndustryMainForce`：push2 `clist m:90+t:2` 行业主力净额求和作为全市场主力净流入（元）

  - 复用 `eastmoneyThrottler`/`sessionFetch`/`EASTMONEY_UT`（缺失时内置 POC 实测 token `7eea3edca…`）

### 改进

- `src/modules/quote/TencentSnapshotService.ts` `buildQuickSnapshot` 改为 **EM 主源 + 腾讯近似兜底**：

  - limits 主源=东财精确池，兜底=腾讯阈值近似

  - sectors 主源=东财概念资金流（含资金流排序），兜底=腾讯板块排行（仅涨跌）

  - main\_force 主源=东财行业主力净额（`eastmoney:industry_main_force`），兜底=腾讯行业板块求和近似

  - 并行 `Promise.allSettled` 单项失败不阻断；`coverage.has_limit_pool` 东财非 unavailable 即 true

- `src/modules/quote/MarketSnapshotService.ts`：`QuickCloseMarketSnapshot.limits.broken_count/highest_board` 放宽为 `number | null`；`main_force.source` 增加 `eastmoney:industry_main_force`

### 之前

- `TencentSnapshotService.buildQuickSnapshot` 补齐编排缺口 #3：用 Tushare 前日填充 `previous_daily`，缺前日即抛硬门槛（fail-loud，与 full 对齐）

### 测试

- 新增 `tests/EmSnapshotService.test.ts`（聚合/partial/排序/求和/空行 5 用例）

- `tests/TencentSnapshotService.test.ts` 新增 EM 主源优先用例 + 既有 build 用例注入 EM 不可用 mock

- **26/26 passed**，`npx tsc --noEmit` 0 错误；冒烟实测东财 79 涨停/12 跌停/46 炸板/连板 4 + 创新药净流入 62.6 亿

### 文档

- `docs/superpowers/specs/2026-08-20-ths-snapshot-source-swap-design.md` 新增"落地状态（Phase 2 生产接入完成）"

### 说明

- 仍为混合方案：指数/宽度/成交额固定腾讯（用户决策），previous\_daily 用 Tushare；仅当日 breadth/turnover 为近似

***

## \[junliang] 2026-08-20 — 价格异动触发口径统一相对昨收 + 涨停雷达解析涨停复盘增强

**开发者**: Aria

### 改进

- `src/modules/insight/PriceMoveService.ts`：午/尾盘打点触发口径统一为相对昨收涨跌幅 ≥7%（`THRESHOLD_PCT`，与实时检测链 `PRICE_TRIGGER_PERCENT=7` 一致）；`extractPrices` 解析 昨收价/涨跌幅/今开价；`moveBps`（相对今开）不再参与触发判定，仅入库作辅助展示（区分开盘/盘中异动）；`backfillByKline` 改取前一根日 K 收盘作昨收

- `src/modules/insight/controller.ts` + `src/db/migrations/017_watchlist_price_move.sql`：快照表新增 `change_pct` 列（含存量表 ALTER IF NOT EXISTS 兼容），列表/详情 SELECT 带出 `snap.change_pct`

- `src/modules/insight/LimitUpRadarCrawler.ts` + `InsightService.ts`：涨停雷达增强——涨停复盘类汇总文章（标题无主体股票）从正文"涨停/涨超/封板/一字"语境提取个股（`parseLimitUpSymbolsFromSummary`，排除跌停/跌幅语境，`SUMMARY_CONTEXT_RANGE=50`），命中自选股逐只建事件，防"涨停个股过多汇总进复盘文章"导致漏检

- `src/modules/stock-trace/StockTraceService.ts` / `StockTraceResultService.ts` / `controller.ts` / `types.ts`：列表/最近事件 `analysis_status` 派生（有效 artifact→completed / result rejected|failed→unavailable / 其他→processing）+ `primary_cause` 短语展示；结果表新增 `primary_phrase` 列（LLM 生成 ≤24 字归因短语）；当前版本归因失败时回退最近有效 artifact

### 修复

- `src/modules/quote/TencentQuoteService.ts`：行情缓存键按 level 区分前缀（`quoteCacheConfig(level)`），修复 activity 打点命中 core 缓存缺"今开价"→ moveBps 恒 null → 异动静默不触发（北方长龙 08-20 -9.8% 案例）

- `src/modules/stock-trace/PriceTriggerDetector.ts`：实时检测行情从 core 改为 activity 级别——core 字段集无"昨收价"，`previousClose` 恒 undefined，实时检测从未真正触发

### 测试

- `src/modules/insight/__tests__/limitUpRadarCrawler.spec.ts`：`parseLimitUpSymbolsFromSummary` 4 例（涨停/涨超/跌停/跌幅/涨幅居前语境）

- `src/modules/insight/__tests__/runCycleEnqueue.spec.ts`：涨停复盘汇总文章建事件入队 1 例

- `src/modules/insight/__tests__/priceMoveService.spec.ts` / `priceEventService.spec.ts`：extractPrices 返回结构（含 prevClose/changePct）、快照新增 changePct

- `src/modules/stock-trace/__tests__/listAnalysisStatus.spec.ts`：analysis\_status 派生（新增）

### 文档

- `src/modules/insight/AGENTS.md` / `quote/AGENTS.md` / `stock-trace/AGENTS.md`：触发口径统一、缓存键 level 区分、涨停复盘解析增强

### 验证

- insight 模块 71 用例全过；stocktrace 相关测试通过；`npx tsc --noEmit` 0 错误

***

## \[master] 2026-08-20 — 修复「未识别到语音」根因 2：V3 流式输入多帧响应，必须等最终帧

**开发者**: Aria

### 修复

- 根因（线上真实语音抓包实证）：V3 `bigmodel_nostream` 流式输入对 3s 语音返回 13 个 full server response 帧——前 12 帧是中间结果（`text:""`、duration 递增），第 13 帧才是最终结果（text 非空 + `result.utterances`）。原代码收到第一个 0x9 帧即 resolve → 取到空文本 → App「未识别到语音」。

- `src/modules/agent/VolcAsrService.ts`：onmessage 改为「聚合文本 + 等最终帧」——中间帧不结算；最终帧标记 = `result.utterances` 存在 或 text 非空；onclose 兜底用已聚合文本。

- 测试：新增「流式多帧」+「仅中间帧后关闭」2 用例；23/23 通过。

- 服务器：真实中文语音端到端复测识别成功（`{"text":"晚上好，欢迎收看收盘播报。今日沪深核心指数同步下跌。"} ms=1392`）。纯后端修复，App 无需重新打包。

***

## \[master] 2026-08-19 — 修复 App「未识别到语音」：App 假 pcm（实为 AMR-WB）→ 后端转码接入

**开发者**: Aria

### 修复

- 根因（线上诊断日志取证）：App 端 `format:'pcm'` 在 HTML5+ Android 产出「假 .pcm 实为 AMR-WB」（`magic=#!AMR-WB`；HTML5+ Android 只原生支持 amr/aac/3gp），V3 只支持 pcm/opus/mp3，按 pcm 解析 amr 数据 → 空文本 →「未识别到语音」。

- 新增 `src/modules/agent/audioTranscode.ts`：`isAmr`（#!AMR 头判断）+ `transcodeToPcm16k`（ffmpeg-static stdin→stdout 转 PCM s16le 16k 单声道）。

- `src/modules/agent/asrController.ts`：Deps 新增 `transcodeAmrToPcm`；recognize 对 amr 输入先转码再识别（转码失败 502 透出 stderr）。

- 依赖：新增 `ffmpeg-static@5.3.0`；新增 `pnpm-workspace.yaml`（pnpm 11 `allowBuilds.ffmpeg-static: true`，保证 install 自动下载 ffmpeg 二进制；pnpm 11 不再读 package.json 的 `pnpm.onlyBuiltDependencies`）。

- 测试：audioTranscode.spec.ts（isAmr 6 用例）+ asrController.spec.ts 新增 2 用例；21/21 通过。

- 服务器：ffmpeg 7.0.2 就位；端到端冒烟 `SMOKE PASS`（amr→pcm 转码 8ms → V3 识别返回）。

- 配套前端（aistock-app-frontend）：App 录音改回 `amr+8k`。

***

## \[master] 2026-08-19 — 火山 ASR 升级 V3「豆包流式语音识别大模型」

**开发者**: Aria

### 变更

- `src/modules/agent/VolcAsrService.ts` 整体重写为 V3（账号开通的是「豆包流式语音识别模型 2.0-小时版」，旧 V2 `/api/v2/asr` 未开通 → 403）：

  - 接口 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream`；鉴权 `X-Api-App-Key`/`X-Api-Access-Key`/`X-Api-Resource-Id`/`X-Api-Request-Id`/`X-Api-Sequence(-1)`（移除 V2 的 Authorization header）

  - 选项 `cluster` → `resourceId`（默认 `volc.seedasr.sauc.duration`）；请求体必填 `request.model_name='bigmodel'`

  - 音频仅支持 pcm/wav/ogg/mp3（不支持 amr）、rate 必须 16000；响应帧 `[header][seq][size][payload]`（size\@8、payload\@12），`result` 为对象 `{text}`

- `src/modules/agent/asrController.ts`：`AsrCredentials.cluster` → `resourceId`；`createDefaultAsrDeps` 读 `VOLC_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration'`（默认值兜底，无需改 .env）

- 测试：VolcAsrService.spec.ts 重写为 V3（parseFrame 按发送帧布局、audio sequence 从 payload 读）、asrController.spec.ts 改 credentials；13/13 通过

- 配套前端（aistock-app-frontend）：App 录音格式 amr+8k → pcm+16k

***

## \[master] 2026-08-19 — 火山 ASR V2 鉴权与错误帧解析修复（线上诊断驱动）

**开发者**: Aria

### 修复

- `src/modules/agent/VolcAsrService.ts`：

  - WebSocket 建连补 `Authorization: Bearer; {token}` header（**分号**分隔，官方 Token 鉴权格式；不加 → 401 missing Authorization，`Bearer `     空格 → invalid auth token）

  - onmessage 处理 `SERVER_ERROR_RESPONSE(0xF)` 错误帧（原只认 0x9 成功帧，403 错误帧被丢弃 → 识别等到 10s 超时，App 显示「语音识别超时」）

  - 帧 size 偏移按类型区分：成功帧 0x9 size\@4；错误帧 0xF 实测 `[header 4B][backend_code 4B][size 4B][payload]` size\@8（曾统一读 offset4 读到 backend\_code 45000030 误判粘包跳过）

- 根因：火山账号未开通「流式语音识别」资源，返回 403 type=15 错误帧；错误帧被忽略 → 超时。代码修复后错误毫秒级透出：`[resource_id=volc.streamingasr.common.cn] requested resource not granted`（剩余 403 需火山控制台开通资源）

- 测试：VolcAsrService.spec.ts 新增「错误帧 type=0xF 透出 message」用例（按实测帧布局构造），7/7 通过

***

## \[master] 2026-08-19 — 修复火山 ASR 在服务器 Node20 下 502（全局 WebSocket 缺失）

**开发者**: Aria

### 修复

- `src/modules/agent/VolcAsrService.ts`：默认 WS 客户端由「Node 22+ 内置全局 `new WebSocket(url)`」改为 npm `ws` 包（与 volcenginePodcast.service.ts TTS 同库，规避 Node 版本依赖）；新增最小接口 `VolcAsrWsLike`（onopen/onmessage/onclose/onerror/send/close），`wsFactory` 类型对齐。

- 根因：服务器 pm2 将 aistock-app-api 跑在 Node v20.20.2（全局 WebSocket=undefined），每次识别抛 ReferenceError → 502「语音识别服务异常」（前端未 parse res.data 吞成笼统文案，配套前端修复见 aistock-app-frontend）。

***

## \[master] 2026-08-19 — /api/agent/asr 改 multer multipart（配合 App 端 uni.uploadFile 直传根治）

**开发者**: Aria

### 改进

- `src/index.ts`：`/api/agent/asr` 由 `express.raw(audio/amr)` 改为 `multer.memoryStorage().single('file')`（multipart 字段 `file`，5mb）。

- `src/modules/agent/asrController.ts`：`recognize` 从 `req.file.buffer` 取音频（替代 req.body Buffer）。

- 依赖：新增 multer\@2.2.0、@types/multer\@2.2.0。

***

## \[master] 2026-08-19 — 趋势股评分 K 线改用腾讯前复权，消除除权除息假跳变

**开发者**: Aria

### 修复

- `src/modules/monitor/TrendScoreService.ts`：新增 `parseTencentKlineToTrendKline`（兼容 TencentKlineService.getKLine 对象格式与原始行数组，日期转 YYYYMMDD、OHLC 与 Tushare 一致）与 `fetchAdjustedTrendKline`（腾讯日K fqt=1 前复权，近120日）；`calcTechnicalDim` 新增 klineOverride 参数，评分 K 线展示优先用前复权数据，获取失败回退 Tushare 不复权；修复源杰科技等除权股不复权价格断裂假跳变（2026-05-18 除权后 40% → 前复权 -1.6%）。

- `tests/TrendScoreKlineAdjusted.test.ts`：新增 3 个测试用例（含除权标记行数组格式、非法行处理、getKLine 对象格式）。

### 文档

- `src/modules/monitor/AGENTS.md`：补充趋势股评分 K 线前复权说明。

***

## \[master] 2026-08-19 — 风口龙头板块净流入彻底下线，改用同花顺实时成交额

**开发者**: Aria

### 改进

- `src/modules/monitor/WindLeaderAnalyzerService.ts`：删除东财派生板块资金流（getMoneyflowCntThs/getMoneyflowIndDc 及导入、相关类型）；板块级别 net\_inflow 字段、AI prompt 的「板块净流入」行、ruleBasedAnalysis 的 amountTrend 全部移除；板块资金评分回退为「频次60%+平均涨幅25%+最新涨幅15%」。保留个股级资金流不受影响。

- `src/modules/monitor/WindLeaderService.ts`：板块类型移除 net\_inflow，新增 amount（板块当日成交额·元）；getAnalysis 实时增强：经 RotationBoardStore.fetchBoardRealtime（同花顺 d.10jqka.com.cn/v6/line/bk\_<code>/01/last.js）以盘中实时涨幅/成交额覆盖静态快照。

- `src/modules/monitor/RotationBoardStore.ts`：新增 fetchBoardRealtime 板块实时盘口读取（30s 内存缓存 TTL）。

***

## \[master] 2026-08-19 — 自选股排序：sort\_order 字段 + 排序保存接口

**开发者**: Aria

### 新增

- `src/modules/auth/userController.ts`：

  - `user_stocks` 幂等迁移新增 `sort_order` 字段；列表查询改按 `sort_order ASC, created_at DESC` 排序。

  - `addFavorites` 新添加股票 `sort_order` 置为当前最大值 +1。

  - 新增 `saveFavoritesOrder`：按传入 symbols 顺序批量更新 `sort_order`，仅更新该用户自选内的代码。

- `src/index.ts`：注册 `PUT /api/users/me/favorites/order` 路由。

***

## \[feat/fear-greed-node] 2026-08-18 — 恐贪指数服务：Python FastAPI 迁移为 Node/TS 并入 app-api

**开发者**: 林晓研

### 新增

- `src/modules/fear-greed/indicators.ts`：恐贪指数纯函数（clamp / percentileRank / pctRankOrNeutral / labelOf / levelOf / sparkline）

- `src/modules/fear-greed/calculator.ts`：韭圈儿 6 指标计算（波动率 / 北向资金偏离 / 上涨占比 / IF 升贴水 / 股债回报差 / 融资买入），前 5 等权合成综合指数

- `src/modules/fear-greed/FearGreedService.ts`：编排服务（内存 30 分钟缓存 + PG 快照表 fear\_greed\_snapshot / breadth\_daily + Redis 缓存 + 上证指数序列对齐）

- `src/modules/fear-greed/controller.ts`：dashboard / indexes / history / refresh 四个路由处理器

- `tests/fear-greed.indicators.test.ts`、`tests/fear-greed.calculator.test.ts`：单元测试（node --import tsx --test）

- `src/index.ts`：注册 `/api/fear-greed/*` 路由、每日 16:30 cron 自动刷新、启动时幂等建表

### 重构

- 原独立 Python FastAPI 服务（aistock-fear-greed）迁移为 Node/TS 模块并入 app-api，路由契约保持 `/api/fear-greed/*` 不变；Web demo 与 agent-py services/ 已清理

***

## \[master] 2026-08-17 — 交易日历公开接口（非交易日过滤支撑）

**开发者**: Aria

### 新增

- `src/shared/utils/TradingCalendarService.ts`：

  - 新增 `getNextTradingDay(date)`：返回严格晚于指定日期的下一个交易日，与既有 `getPreviousTradingDay` 对称

  - 新增 `getRecentTradingDays(date, count)`：返回截至指定日期（含当天）最近 count 个交易日，供首页"市场洞见"取日期标签

- `src/core/routes/internal.ts`：`publicRouter`（挂 `/api/agent`）新增 3 个公开接口——

  - `GET /api/agent/trading-calendar/previous?date=YYYY-MM-DD` → 前一交易日

  - `GET /api/agent/trading-calendar/next?date=YYYY-MM-DD` → 下一交易日

  - `GET /api/agent/trading-calendar/recent?date=YYYY-MM-DD&count=N` → 最近 N 个交易日数组

  - 以服务端休市日历（周末 + 官方节假日）为权威，供 App 前端"前一天/后一天"跳档跳过非交易日、市场洞见取最近交易日

### 同批随带

- `src/modules/monitor/WindLeaderService.ts`、`src/modules/monitor/IndustryKGService.ts`、`src/modules/monitor/AGENTS.md`：风口龙头批次遗留随带改动

### 验证

- `npx tsc --noEmit` 0 错误；休市日历覆盖 2024–2026 年，超范围接口返回 500

## \[changer] 2026-08-17 — ASR 音频格式 wav → amr（对齐 App 端录音格式契约）

**开发者**: 37588

### 背景

App Android 真机语音输入失败根因定位为：uni-app App 端 Android 不真正支持 `wav` 录音（HTML5+ `plus.audio.getRecorder` 生成无效文件），故前端录音改为 `amr`。后端火山 V2 ASR 需同步把音频协议 `format`/`rate` 对齐才能识别。

### 修复

- `src/modules/agent/VolcAsrService.ts`：全量请求 `audio: { format:'wav', rate:16000 }` → `{ format:'amr', rate:8000 }`（AMR-NB 窄带固定 8k）；注释「mp3/wav 均可」→「amr/mp3/wav 均可」

- `src/index.ts`：`express.raw` 消费 `type:'audio/wav'` → `'audio/amr'`；注释同步

- `src/modules/agent/asrController.ts`：头注释 body 描述 `wav` → `amr`

- 测试同步期望：`volcAsrService.spec.ts` 断言 `format:'amr'`/`rate:8000`；`asrController.spec.ts` 请求 `Content-Type: audio/amr`

### 验证

- `volcAsrService.spec.ts` + `asrController.spec.ts` 定向 12/12 通过（RED→GREEN）

- `npx tsc --noEmit` 无报错

### 配套（前端 app-frontend，同批）

- `speechInput.ts` 录音启动 `format:'amr',sampleRate:8000`，上传 `Content-Type: audio/amr`（见 frontend changelog）

### 待真机验证

- 部署后端后 App 真机语音输入，确认 `/agent/asr` 收到 amr 并返回 `{ text }`

***

## \[master] 2026-08-17 — 风口龙头：短线榜排序口径（上榜次数-热度）+ 最近交易日窗口修复

**开发者**: Aria

### 修复

- `src/modules/monitor/WindLeaderAnalyzerService.ts`：

  - `applyDualRankings` 短线榜排序由 `short_term_days → freq20` 改为**上榜次数 freq20 → 热度 short\_heat（存于 ai\_analysis）** 降序。原 `short_term_days` 是 HotSectorAnalysis 顶层不存在字段（实际在 ai\_analysis 内），比较恒为 0，短线榜实际只按 freq20 排序且与前端口径不一致；现显式读 `ai_analysis.short_heat`，与前端 leaders 页"上榜次数-热度"口径统一

  - `getLatestDailyMap` 最近交易日回溯窗口 3 天 → **10 天**：分析在凌晨运行，周一/长假后首个交易日可能位于 3 个日历日之外（如 2026-08-17 周一凌晨只回溯 17/16/15 均非交易日），导致 moneyflow 日期回退到当天返回空 → 所有板块 net\_inflow=0、MA60 缺失（日志：`资金流向数据获取成功: 0条`）。10 天可覆盖周末 + 长假

- `tests/WindLeaderCycle.test.ts`：短线榜测试改为断言 freq20→short\_heat 降序；顺带修正 `deriveCycle({})` 陈旧断言（四态化后兜底为 none 非 short）

### 验证

- WindLeaderCycle 8/8 通过；`npx tsc --noEmit` 0 错误；用线上数据模拟新排序验证顺序符合"上榜次数-热度"

***

## \[changer] 2026-08-16 — 修复 Chat WS 桥接帧类型：文本帧被转成二进制帧导致对话回答为空

**开发者**: 37588

### 背景

H5 对话页 AI 回答为空。定位到 chat-bridge 上游文本帧（agent-py `send_json`）经 `clientWs.send(data)` 转发时，因 `ws` 库 message 回调 data 恒为 Buffer，被默认按二进制帧发送 → 浏览器端 `JSON.parse(Blob)` 失败，所有 WS 事件被静默丢弃。

### 修复

- `src/core/ws/chat-bridge.ts`：上游 → 前端转发显式保留帧类型 `clientWs.send(data, { binary: isBinary })`（文本帧保持文本帧、二进制帧保持二进制帧）

- 测试：`chat-bridge.spec.ts` 新增 2 个帧类型回归用例（上游文本帧 → 客户端 `isBinary=false`；上游二进制帧 → 客户端 `isBinary=true`），断言失败时 finally 关闭连接防 afterEach 挂起

### 验证

- `chat-bridge.spec.ts` 定向 8/8 通过（修复前文本帧用例 RED 失败：`true !== false`）

- `npx tsc --noEmit` 无报错

***

## \[changer] 2026-08-15 — 预测验证 v2 支撑端点（指数日 K + 游标分页）

**开发者**: changer-collab

### 新增

- `GET /internal/index/:code/kline`：指数日 K 端点（Tushare index\_daily，显式 ts\_code 不经 getStockIdentity——`000001` 会被误判为深市个股），预测验证 v2 窗口判定的历史数据源；支持 `days`（1-200）参数，指数映射 000001/000300/000688/399001/399006

- `TushareKlineService.getIndexKLine`：指数日线拉取（index\_daily + 统一字段映射，经 tushare 节流器）

- `GET /internal/predictions` 游标分页：`before_id` 参数（pending/listByStatus 均支持，按 id 倒序），防全量扫描

### 改进

- `PredictionRecordService.listPending`/`listByStatus` 支持 `beforeId` 游标参数；非法游标忽略回退全量

***

## \[changer] 2026-08-15 — ASR 录音格式 mp3 → wav（对齐前端录音 + 火山识别）

**开发者**: 37588

### 背景

App 真机录音 mp3 不可靠（部分 Android ROM 缺编码器 start 抛错），前端录音改 wav + 16kHz；后端 ASR 链路同步对齐。

### 修复

- `src/modules/agent/VolcAsrService.ts`：火山 full request `audio.format` 'mp3' → 'wav'（rate 16000/bits 16/channel 1 不变，wav 需 pcm\_s16le 与 16k 匹配）

- `src/index.ts`：`/api/agent/asr` express.raw type 'audio/mpeg' → 'audio/wav'

- `src/modules/agent/asrController.ts`：接口注释同步

- 测试：`volcAsrService.spec.ts`（format 断言 wav）、`asrController.spec.ts`（Content-Type audio/wav）

### 验证

- `tsx --test` 定向 12/12 通过、`tsc --noEmit` 无报错

***

## \[changer] 2026-08-14 — 预测记录支持越年近似档标记

**开发者**: changelog

### 新增

- `POST /internal/predictions` 接受可选 `due_dates_approximate`（string\[]，越年近似档名列表），合并进 prediction jsonb（skip\_reason 先例，免 DB 迁移）

- 公开统计新增 `approximateHorizonCount`：越年近似档照常验证但 hit/miss 不计入命中率分母（分桶避免统计失真）

### 改进

- internalRouter 校验 `due_dates_approximate` 类型（非数组 / 含非 string 元素 → 400）

***

## \[changer] 2026-08-14 — 大盘溯源影响持续性预判记录支持状态追踪与按需补偿

**开发者**: changelog

### 新增

- 预判记录支持"已跳过"状态与原因（无效/无法生成的预判显式落库，不再混入进行中）

- 公开列表支持按溯源报告定向查询（`source_id=review:YYYY-MM-DD`），大盘溯源页预判卡片数据源切换为预判记录

- 按需补偿接口：手动触发当日预判生成（仅限当日 + 频率限制 + 已验证记录拒绝覆盖 + 90s 超时，转发至推理服务）

### 改进

- 统计口径：已跳过记录单独计数（skippedCount），不计入进行中/已结束

***

## \[master] 2026-08-14 — 修复风口龙头接口 long\_leader 恒为 null（getAnalysis 读时枚举字段遗漏）

**开发者**: Aria

### 修复

- `src/modules/monitor/WindLeaderService.ts`：

  1. `getAnalysis` 返回对象补充 `long_leader: sector.long_leader || null`——此前读数据时显式枚举字段构造返回对象，遗漏新增的 long\_leader，导致接口返回恒为 null（数据文件 hot-sectors.json 中实际已有值）
  2. `WindLeaderSector` 接口补充 `long_leader?: WindLeaderStock | null`

### 测试

- `src/modules/monitor/__tests__/windLeaderLongLeader.spec.ts` 追加 `getAnalysis preserves long_leader field in response sectors` 用例（mock fs 读文件），现 5/5 通过

***

## \[master] 2026-08-14 — 风口龙头板块新增 long\_leader（长期趋势龙头）字段

**开发者**: Aria

### 新增

- `src/modules/monitor/WindLeaderAnalyzerService.ts`：

  1. 新增导出函数 `queryTopTrendScore(codes)`：查 `trend_scores` 表最新评分日中成分股代码集合内 score 最高、非 D 评级、未被 60 日均线剔除（ma60\_excluded != true）的股票；返回 `SelectedStock`（reason\_tag=评级、source='trend\_score'），DB 错误/无命中返回 null（回退路径）
  2. `HotSectorAnalysis` 接口新增 `long_leader: SelectedStock | null`
  3. 主循环板块分析新增第 10 步：行业板块（881xxx）用 `getBoardTopStocks(20,'industry')` 成分股代码、概念板块用概念成分股代码，调 `queryTopTrendScore` 取趋势龙头；无命中回退 `finalMainStocks` 评分最高者

### 测试

- 新增 `src/modules/monitor/__tests__/windLeaderLongLeader.spec.ts`：4 用例覆盖空数组/DB 命中/SQL 过滤条件（MAX(score\_date)、排除 D、ma60\_excluded）/无命中/DB 错误回退

***

## \[changer] 2026-08-13 — 深度分析报告详情查询接口

**开发者**: 37588

### 新增

- 深度分析报告详情查询接口（`/report/chat/:reportId`）：登录用户按报告编号查询本人的深度分析报告；服务端验签 + 归属校验 + 有效期过滤，不存在/非本人/已过期返回空数据，不泄露报告存在性

### 测试

- 鉴权（无/非法令牌 401）、归属与过期过滤、空数据语义、路由优先级（不被通用报告端点抢占）、异常降级用例

> 代码验收通过（待生产验证）。

***

## \[master] 2026-08-14 — 修复风口龙头股爬取把新闻链接当龙头（玻璃基板"概念细分|…"）+ 行业板块龙头股缺失

**开发者**: 37588

### 修复

- `src/modules/monitor/WindLeaderAnalyzerService.ts`：

  1. 新增 `isValidStockCode()`（仅接受 A 股代码段 60/68/00/30/43/83/87/92，排除日期型 2026xx 与同花顺板块代码 881/884/885/886xxx）、`isValidStockName()`（长度 2\~12，排除 | 分隔符与"概念/细分/新增"等描述词）、`extractStockCodeFromHref()`（排除 news. 域名链接后提取合法代码）
  2. 龙头股爬取策略 1/3/4 全部改用严格校验：同花顺概念页新闻链接 `news.10jqka.com.cn/20260805/c678696112.shtml` 的日期 `202608` 不再被误当股票代码、新闻标题不再被当股票名（此前污染 leading\_stock，如玻璃基板显示"概念细分|玻璃基板新增…细分方向"）
  3. `extractLeadingStock` fallback 回退到 main\_stocks 评分最高者补全 code/价格/涨幅（行业板块 881xxx 无概念页龙头结构时必走此分支）
  4. 行业板块（881xxx）主循环补充自身成分股进 main\_stocks（此前 strongly\_related 为空导致 main\_stocks 恒空）
  5. `identifyHotConcepts` 领涨股补充按板块类型分流（行业板块用 industry 成分股接口）

### 测试

- 新增 `src/modules/monitor/__tests__/windLeaderStockValidation.spec.ts` 6 用例（合法代码/日期误判/板块代码误判/新闻标题拒收/新闻链接提取）全过

> 验证：`npx tsc --noEmit` 0 错误；新增 6 测试全过；`npm run build` 成功。

***

## \[master] 2026-08-14 — 知识图谱修复：专家修正表 + AI prompt 改进 + 缓存 TTL 修复 + 风口行业板块修复

**开发者**: 37588

### 修复

- `src/modules/monitor/IndustryKGService.ts`：

  1. 新增 `EXPERT_INDUSTRY_RELATIONS` 专家人工修正表（约 90 个热门行业权威上下游，按行业名精确匹配；上游=原材料/零部件/设备/能源供应方，下游=应用/渠道/终端；不收录并列、细分-父级、服务外包关系）
  2. 新增 `applyExpertEdges()`：覆盖专家表行业的全部 AI 边，替换为权威上下游；幂等，缓存加载与重新生成统一走这里
  3. `buildAIEdges(industries, force?)`：force 时跳过 ai\_edges 缓存；AI 边生成/加载后统一过专家表
  4. `rebuild(force?)`：AI 生成失败时用专家表兜底
  5. `initialize()`：修复缓存 TTL bug——full\_graph.json 过期判断改用缓存内部 `updateTime`（此前文件 mtime 被龙头股后台加载重写刷新，15 天 TTL 永不触发）
  6. `aiGenerateChainBatch` prompt 大改：明确 881xxx 二级/884xxx 三级行业概念、严禁把并列/细分-父级/服务外包当上下游、增加半导体/生物制品正确示例

- `src/modules/monitor/WindLeaderAnalyzerService.ts`：风口榜单行业板块（881xxx）新增 `isIndustryBoardCode()` + `mapIndustryToChain()`——行业板块不走"概念→行业"映射（此前找不到概念 fallback 随机行业排名导致 related 错乱、上下游为空），改从知识图谱直接取该行业上下游（`getUpstreamDownstreamByName`，失败容错返回空）；主循环两处调用点按板块类型分流

### 文档

- `src/modules/monitor/AGENTS.md`：补充 IndustryKGService 专家修正表/TTL 修复/AI prompt 层级约束，以及风口行业板块 mapIndustryToChain 说明

> 验证：`npx tsc --noEmit` 0 错误；专家表覆盖逻辑本地脚本断言 6/6 通过（贵金属错误边电力/民爆移除、新增上游工业金属+下游饰品/半导体等；生物制品错误边动物保健/原料药移除、保留医院等下游）。

***

## \[changer] 2026-08-12 — Phase 5 删会话联动删 checkpointer thread

**开发者**: 37588

### 新增

- `src/modules/chat/agentThreadClient.ts`：`deleteChatThread(sessionId)`——调用 agent-py `DELETE /api/agent/internal/chat/threads/:session_id`（X-Internal-Token；AbortController 3s 超时；非 2xx 抛错；env：`AGENT_PY_URL || PYTHON_AGENT_URL || http://localhost:8080`）

***

## \[junliang] 2026-08-06 — 自选股洞察：事件归属锚定标题主体股票 + 归因回写修复

**开发者**: Aria

***

## \[master] 2026-08-06 — 风口龙头 v4-flash 思考关闭不可靠的兜底：JSON 截断重试 + 数据异常提示

**开发者**: Aria

### 修复

- `src/modules/insight/InsightService.ts`：自选股事件匹配锚定标题主体股票（"XX触及涨停"），详情页推荐/相关股票链接不再创建事件（修复事件挂错标的，如汇金通被挂到中国电建）；单篇详情抓取失败仅记日志跳过不中断整轮

- `src/modules/insight/LimitUpRadarCrawler.ts`：新增 `parseTitleStockName`（提取标题主体股票并去除括号代码）；详情页为 UTF-8，fetchDetail 显式指定编码；列表分页按 articleId 去重（CDN 缓存抖动）

- `src/db/migrations/016_watchlist_insights.sql`：`watchlist_insight_results.confidence` 由 VARCHAR(8) 扩为 VARCHAR(16)（'unconfirmed' 11 字符超长导致结果回写 500）

- `src/shared/utils/crawler.ts`：`fetchHtml` 支持 `encoding` 参数（'gbk'|'utf-8'，默认 gbk），修复详情页乱码

### 测试

- `src/modules/insight/__tests__/limitUpRadarCrawler.spec.ts`：新增 5 个 `parseTitleStockName` 用例（含涨停复盘类标题返回 null）

***

- `WindLeaderAnalyzerService.aiAnalyzeSector`：v4-flash 深度思考无法 100% 关闭——长 prompt + 异常数据（领涨股涨幅0/涨跌家数0）时模型仍会思考，耗尽 max\_tokens 导致 content 为空或 JSON 截断（`Unterminated string in JSON`）→ ① max\_tokens 提档 \[2000,6000] ② JSON 截断/解析失败也触发提高 max\_tokens 重试（原仅 content 空才重试）③ 请求超时 60s→90s

- `buildAiPrompt`：提示词增加"输入数据可能存在异常，请忽略并直接基于现有数据判断，不要质疑数据"（模型曾因异常数据陷入深度思考）

***

## \[master] 2026-08-06 — 风口龙头 AI 关闭深度思考：deepseek-v4-flash 直接输出 JSON

**开发者**: Aria

### 修复

- `WindLeaderAnalyzerService.aiAnalyzeSector`：DeepSeek V4 系列（v4-flash/v4-pro）默认开启深度思考，`max_tokens` 被 `reasoning_content` 耗尽导致 `content` 为空（服务器实测）→ 对 deepseek 模型请求体附加 `reasoning_effort:"none"` 显式关闭思考，模型直接输出 JSON（服务器实测有效，不换模型）

- AI 输出健壮性：`long_term_days`/`short_term_days` clamp 到 schema 范围（0~~90 / 0~~30），防 LLM 越界值（实测模型输出过 120 天）

***

## \[master] 2026-08-06 — 风口龙头 AI 推理模型兜底：content 空自动提高 max\_tokens 重试

**开发者**: Aria

### 修复

- `WindLeaderAnalyzerService.aiAnalyzeSector`：服务器日志定位到 `content=""` 但 `reasoning_content` 有内容——`AI_MODEL` 配置的是推理模型（deepseek-reasoner/v4 推理版），token 消耗在思考过程、最终答案为空 → 新增重试：content 空且存在 reasoning\_content 时提高 max\_tokens（1200→4000）重试一次；请求超时 45s→60s。仍失败则降级规则引擎（已按月分档+标签区分）

- 更优解：服务器 `AI_MODEL` 直接改用非推理模型 `deepseek-chat`（curl 实测直接输出 content）

***

## \[master] 2026-08-06 — 风口龙头双链修复：AI 截断降级 + 规则引擎月度分档 + 标签区分

**开发者**: Aria

### 修复

- `WindLeaderAnalyzerService.aiAnalyzeSector`：`max_tokens` 500→1200（14 字段+80 字理由的中文 JSON 在 500 token 下被截断 → `JSON.parse` 报 `Unexpected end of JSON input` → 全部板块走规则引擎，长线全 45 天、标签全"资金"；服务器实测 DeepSeek API 正常，确认为截断问题）

- `WindLeaderAnalyzerService.ruleBasedAnalysis`：长线持续天数由固定 45 天改为按月分档（30/60/90 天，对应 1/2/3 个月）；`logic_type` 按板块名关键词区分（政策/业绩/资金/无支撑），避免降级时全部为"资金"

### 改进

- `src/modules/chat/sessionController.ts` `remove`：PG 删除 `chat_sessions` 成功后 `await deleteChatThread(sessionId)`（`__threadClientDependencies` 注入点供测试 stub）；失败仅 warning 不阻断，仍返回 200（"永不 500"）

### 测试

- `src/modules/chat/__tests__/session.spec.ts` +2（联动调用触发 / 联动失败仍 200）

> 验证：tsc --noEmit 0 错误；chat 定向 18/18。配套 agent-py Phase 5（窗口+零 LLM 摘要 / 删 thread / busy\_timeout）。代码验收通过（待生产验证），待组长 merge 后部署验证。

***

## \[changer] 2026-08-12 — 问题 19 修复：user\_profile 缓存失效连接对齐 agent-py 真实 Redis

**开发者**: 37588

### 修复

- `src/modules/user/profileController.ts`：新增 `resolveAgentCacheRedisUrl()`——缓存失效连接默认值原写死 `redis://127.0.0.1:6379/1`（无密码），生产 Redis requirepass + agent-py 画像缓存实际在 db15 → `NOAUTH` 失效从未执行（DELETE 后 300s 内旧画像仍生效，删除权失效窗口，Phase 4 生产验证 D3 实证）。现改为：`AGENT_PROFILE_CACHE_REDIS_URL` 显式覆盖优先；未配置则从本服务 `REDIS_URL` 派生（保留 auth/host/port，仅把 db 段替换为 `AGENT_PROFILE_CACHE_DB`=15，与 agent-py 缓存真实位置对齐）；无 `REDIS_URL` 兜底 `redis://127.0.0.1:6379/15`。`_agentCacheRedisFactory.current` 改为运行时调用

### 新增

- 测试：`src/modules/user/__tests__/profile.spec.ts` +4 用例（显式 env 优先 / REDIS\_URL 派生替换 db / 无 db 段追加 / 无配置兜底），18/18 通过

### 文档

- `src/modules/user/AGENTS.md`：硬约束"跨库缓存失效"更新为 db15 + 派生逻辑描述（原 db=1 描述过时）

> 待部署：push → PR → merge → 服务器 `git pull` + `tsc` build + `pm2 restart` → 重跑 D3（DELETE 后立即对话应回通用档）。

***

## \[changer] 2026-08-11 — P1 JWT 撤销与演进（token-revocation）

**开发者**: 37588

### 新增

- `src/shared/utils/tokenBlacklist.ts`：`revokeToken`（按 jti 写 `token_blacklist:{jti}`，TTL=剩余寿命 clamp \[1,7天]，返回 `{ok, persisted}`）、`isTokenRevoked`（读侧 fail-open + 读异常 WARN 非静默）、`extractTokenFromRequest`（Bearer 优先 Cookie 兜底）、`REVOKED_MESSAGE`

- 测试：`src/shared/utils/__tests__/cacheService.spec.ts`（5）、`tokenBlacklist.spec.ts`（8）、`src/modules/auth/__tests__/logout.spec.ts`（5）

### 改进

- `src/shared/utils/CacheService.ts`：`set/put/refresh` 返回 `Promise<boolean>`（Redis 持久写落地状态）；`token_blacklist:` 键豁免 `LOCAL_CACHE_MAX_SIZE` 通用淘汰（仅 TTL 自然过期）；Redis 不可用一次性 WARN；`__cacheServiceDependencies` 测试注入点

- `src/shared/utils/jwt.ts`：`JwtPayload.jti?` + `signJwt` 自动生成 `jti`（UUID；显式 jti 优先）；`verifyJwt` 零改动（无 jti 在途旧 token 零拒绝）

- `src/modules/auth/controller.ts` logout：按 jti 撤销——`persisted=false` → 200 + `data.degraded:true`；`ok=false` → 500；无 jti 旧 token → 200 + `data.legacy:true` + WARN；无效/无 token 幂等 200；token 来源与 requireAuth 对齐；所有分支删 Cookie（`setLogoutCookie` 私有辅助）

- 鉴权入口读侧黑名单（8 处）：chat/sessionUsageController、sessionController、usageController、auth/userController、feishuAuthController、monitor/controller（requireAuth 验签后 `isTokenRevoked` 401）+ insight/controller、stock-trace/controller（`openidFromRequest` 改 async + 黑名单，7/7 调用点 await）

- `src/modules/agent/agent.proxy.ts` chat 三路径 + `src/core/ws/chat-bridge.ts`：验签后查黑名单——命中 HTTP 401（上游零调用）/ WS close(4401)（不建上游连接）

### 文档

- `AGENTS.md`：§5 关键约束表新增 JWT 撤销行 + §7.5 身份契约段 token-revocation 注

> 硬约束：写侧 never-silent（撤销未持久化显式 `degraded` / 500）、读侧 fail-open（黑名单只含被撤销凭证，读失败不影响合法用户，WARN 非静默）。
> **部署前置（上线前必须执行）**：`pm2 list` 确认 app-api 单实例；若多实例须升级黑名单为 Redis 必须项（见 roadmap §5）。

***

## \[changer] 2026-08-11 — P0 身份鉴权（Phase 1a）

**开发者**: 37588

### 新增

- `src/core/ws/chat-bridge.ts`：接管 `/api/agent/ws/chat` upgrade——验签 query token（无 token 放行 user\_id=None；非法/过期 close(4401)），作为 WS 客户端连 agent-py（带 X-Internal-Token），双向转发并覆写消息体 user\_id（客户端自报失效）

- `src/core/ws/__tests__/chat-bridge.spec.ts`（6 用例）、`src/shared/utils/__tests__/jwt.spec.ts`（7 用例）

### 修复

- `src/shared/utils/jwt.ts`：verifyJwt 畸形输入 fail-closed（签名长度预检 + try/catch 返回 null，不抛 ERR\_CRYPTO\_TIMING\_SAFE\_EQUAL\_LENGTH）

- `src/core/ws/handler.ts`：改 noServer + 按 path 精确分发（ws\@8 双 {server,path} 实例对不匹配 path abortHandshake(400) 互斥）

### 改进

- `src/modules/agent/agent.proxy.ts`：chat 三路径（/chat/message、/chat/stream/messages、/chat/stream/updates）Authorization Bearer JWT 校验（非法/过期 401）+ 覆写 body user\_id；非 chat 路径行为零变化

- `src/index.ts`：挂载 chat 桥接 + createAgentProxy 传 jwtSecret

> 部署注意：Caddy `/api/agent/ws/*` 已指向 app-api（管理员 2026-08-11），本改动部署后 WS 恢复 + HTTP 面鉴权生效；前端发版须在其后。

***

## \[changer] 2026-08-10 — B2.1 历史预测跟踪公开查询接口（/api/predictions）

**开发者**: 37588

### 新增

- `src/modules/prediction/publicRouter.ts`：`GET /api/predictions`（列表 + 命中率统计 + 分页，status=all|pending|verified）、`GET /api/predictions/:id`（详情）；公开接口无需 X-Internal-Token；`__predictionPublicDependencies` 测试注入点；`toItem` 中 `id` Number() 归一（pg BIGSERIAL 返回 string）

- `src/modules/prediction/publicRouter.test.ts`：路由层 6 用例（400×2 / 列表统计 / hitRate null / 详情 / 404，mock Service 不触达 PG）

- `src/modules/prediction/PredictionRecordService.ts`：`list` / `listAllForStats` / `getById` 三个查询方法

### 改进

- `src/index.ts`：挂载 `/api/predictions`（404 catch-all 之前）

### 测试

- `publicRouter.test.ts` 6/6；`npx tsc --noEmit` 0 错误；真实联调 curl 列表/详情/400/404 全部正确

***

## \[changer] 2026-08-10 — B2 预测能力落库接口（prediction\_records）

### 新增

- `src/core/routes/internal.ts`：`POST /internal/predictions`（upsert，`(source_type, source_id)` 唯一索引 + ON CONFLICT DO UPDATE）、`GET /internal/predictions?status=pending`、`PUT /internal/predictions/:id/verification`（appendVerification 全档位覆盖自动置 verified）

- `src/modules/prediction/PredictionRecordService.ts`：create / listPending / appendVerification

### 改进

- `src/index.ts`：启动时自动建表 `prediction_records`（status 仅 {pending, verified}）

