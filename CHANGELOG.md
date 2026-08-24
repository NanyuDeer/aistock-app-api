# Changelog — aistock-app-api

> 所有修改记录按时间倒序排列。每条记录标注分支、时间、开发者。

## [feat/fear-greed-micro] 2026-08-24 — 恐贪算法增强：新增涨跌停微观结构指标

**开发者**: 林晓研

### 新增
- `src/modules/fear-greed/calculator.ts`：新增 4 个涨跌停微观结构指标（封板率 seal_rate / 炸板率 break_rate / 涨跌停比 limit_ratio / 连板高度 streak），数据源 Tushare `limit_list_d`；合成指数由 5 宏观指标扩展为 9 指标（5 宏观 + 4 微观）等权平均
- `tests/fear-greed.calculator.test.ts`：mock `limit_list_d` API 响应，断言更新为 10 指标

### 变更
- `src/modules/fear-greed/calculator.ts`：`limit_list_d` 不可用时 4 个微观指标降级为中性值（score=50），不影响主流程；composite 合成改为 9 指标平均

---

## [master] 2026-08-21 — 修复风口龙头板块实时行情显示昨日数据

**开发者**: Aria

### 修复
- `src/modules/monitor/RotationBoardStore.ts`：
  - 根因：`fetchBoardRealtime` 用 `last.js` 的"最后两根"推导，但 `last.js` 盘中最后 bar 是**昨日**（`today` 字段仅标注日期，不含当根实时 bar），导致板块一直显示昨日的涨跌幅/成交额。
  - 新增 `TODAY_URL`（同花顺 `bk_<code>/01/today.js` 当日实时 JSONP）与 `parseTodayRealtime`（解析 `{"1":日期,"11":现价,"19":成交额(元)}`）。
  - 重写 `fetchBoardRealtime`：并行拉 `last.js`（昨收=日期严格早于今日的最后一条 close）与 `today.js`（今日实时价 + 成交额），`change_pct=(现价-昨收)/昨收*100`。
- 验证：881175 医疗服务 today.js 解析得 date=20260821、现价 20597.772、成交额 46533482000、当日涨跌幅 -3.87%；`npx tsc --noEmit` 无错误。

---

## [master] 2026-08-21 — 异动归因改为落定后触发一次

**开发者**: Aria

### 改进
- `src/modules/stock-trace/StockTraceService.ts`：
  - `processPriceFact` create/revision 分支**移除即时 `StockTraceJobService.enqueue`**（盘中只采集快照 + 实时推送，不再每次 revision 都跑 LLM 归因）；
  - 反向落定：关闭相反方向 active 事件的 UPDATE 加 `RETURNING`，在同一事务内对落定事件 `enqueueFinalAnalysis`；
  - `startRecovery` close UPDATE 加 `RETURNING`，恢复窗口到期落定后触发一次最终归因；
  - 新增私有 `enqueueFinalAnalysis`（无 client 时自建短事务保证 job+outbox 原子）与 `triggerFinalAttribution`（入队后 `publishPending`）；
  - 新增公开 `settleActiveEvents()`：强制落定当日仍 active 的事件并触发最终归因，返回落定数。
- `src/index.ts`：新增 15:05 工作日 cron 调用 `StockTraceService.settleActiveEvents()` 作收盘兜底（防 5 分钟恢复窗口在收盘前未到期而漏归因）。
- 幂等：`UNIQUE(event_id, trigger_revision, analysis_version, job_kind)` + `SELECT FOR UPDATE`，同一事件只入队一个最终归因 job；Python consumer `SNAPSHOT_NOT_READY` pending reclaim 适配落定即入队。

### 测试
- 新增 `__tests__/final-attribution.spec.ts`（5 例：落定归因一次 / 无落定不入队 / 收盘兜底 / 兜底空跑 / enqueue 幂等）。
- 验证：`npx tsc --noEmit` 通过；stock-trace 39 例全绿。

---

## [master] 2026-08-21 — 恐贪指数接口漏挂修复（温度计恒为默认值12、点击无页面）

**开发者**: Aria

### 修复
- 根因：`/api/fear-greed` 路由在 `src/index.ts` **从未挂载**，`ensureFearGreedSchema()` 也从未调用——controller 已实现但未接线，前端请求 404 退化为默认值12。
- `src/modules/fear-greed/controller.ts`：新增导出 `fearGreedRouter`（GET `/dashboard`、`/indexes`、`/history`、POST `/refresh` 公开路由）。
- `src/index.ts`：挂载 `app.use('/api/fear-greed', fearGreedRouter)`（publicRouter 之后）；`start()` 建表块新增 `ensureFearGreedSchema()` 调用（仿 feishu 模式，失败仅 warn 不阻断启动）。
- 验证：`npx tsc --noEmit` 退出码 0。

---

## [master] 2026-08-20 — 收盘复盘改进方案：东财快照源接入 quick 链路（EM 主源 + 腾讯兜底）

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
  - main_force 主源=东财行业主力净额（`eastmoney:industry_main_force`），兜底=腾讯行业板块求和近似
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
- 仍为混合方案：指数/宽度/成交额固定腾讯（用户决策），previous_daily 用 Tushare；仅当日 breadth/turnover 为近似

---

## [junliang] 2026-08-20 — 价格异动触发口径统一相对昨收 + 涨停雷达解析涨停复盘增强

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
- `src/modules/stock-trace/__tests__/listAnalysisStatus.spec.ts`：analysis_status 派生（新增）

### 文档
- `src/modules/insight/AGENTS.md` / `quote/AGENTS.md` / `stock-trace/AGENTS.md`：触发口径统一、缓存键 level 区分、涨停复盘解析增强

### 验证
- insight 模块 71 用例全过；stocktrace 相关测试通过；`npx tsc --noEmit` 0 错误

---

## [master] 2026-08-20 — 修复「未识别到语音」根因 2：V3 流式输入多帧响应，必须等最终帧

**开发者**: Aria

### 修复
- 根因（线上真实语音抓包实证）：V3 `bigmodel_nostream` 流式输入对 3s 语音返回 13 个 full server response 帧——前 12 帧是中间结果（`text:""`、duration 递增），第 13 帧才是最终结果（text 非空 + `result.utterances`）。原代码收到第一个 0x9 帧即 resolve → 取到空文本 → App「未识别到语音」。
- `src/modules/agent/VolcAsrService.ts`：onmessage 改为「聚合文本 + 等最终帧」——中间帧不结算；最终帧标记 = `result.utterances` 存在 或 text 非空；onclose 兜底用已聚合文本。
- 测试：新增「流式多帧」+「仅中间帧后关闭」2 用例；23/23 通过。
- 服务器：真实中文语音端到端复测识别成功（`{"text":"晚上好，欢迎收看收盘播报。今日沪深核心指数同步下跌。"} ms=1392`）。纯后端修复，App 无需重新打包。

---

## [master] 2026-08-19 — 修复 App「未识别到语音」：App 假 pcm（实为 AMR-WB）→ 后端转码接入

**开发者**: Aria

### 修复
- 根因（线上诊断日志取证）：App 端 `format:'pcm'` 在 HTML5+ Android 产出「假 .pcm 实为 AMR-WB」（`magic=#!AMR-WB`；HTML5+ Android 只原生支持 amr/aac/3gp），V3 只支持 pcm/opus/mp3，按 pcm 解析 amr 数据 → 空文本 →「未识别到语音」。
- 新增 `src/modules/agent/audioTranscode.ts`：`isAmr`（#!AMR 头判断）+ `transcodeToPcm16k`（ffmpeg-static stdin→stdout 转 PCM s16le 16k 单声道）。
- `src/modules/agent/asrController.ts`：Deps 新增 `transcodeAmrToPcm`；recognize 对 amr 输入先转码再识别（转码失败 502 透出 stderr）。
- 依赖：新增 `ffmpeg-static@5.3.0`；新增 `pnpm-workspace.yaml`（pnpm 11 `allowBuilds.ffmpeg-static: true`，保证 install 自动下载 ffmpeg 二进制；pnpm 11 不再读 package.json 的 `pnpm.onlyBuiltDependencies`）。
- 测试：audioTranscode.spec.ts（isAmr 6 用例）+ asrController.spec.ts 新增 2 用例；21/21 通过。
- 服务器：ffmpeg 7.0.2 就位；端到端冒烟 `SMOKE PASS`（amr→pcm 转码 8ms → V3 识别返回）。
- 配套前端（aistock-app-frontend）：App 录音改回 `amr+8k`。

---

## [master] 2026-08-19 — 火山 ASR 升级 V3「豆包流式语音识别大模型」

**开发者**: Aria

### 变更
- `src/modules/agent/VolcAsrService.ts` 整体重写为 V3（账号开通的是「豆包流式语音识别模型 2.0-小时版」，旧 V2 `/api/v2/asr` 未开通 → 403）：
  - 接口 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream`；鉴权 `X-Api-App-Key`/`X-Api-Access-Key`/`X-Api-Resource-Id`/`X-Api-Request-Id`/`X-Api-Sequence(-1)`（移除 V2 的 Authorization header）
  - 选项 `cluster` → `resourceId`（默认 `volc.seedasr.sauc.duration`）；请求体必填 `request.model_name='bigmodel'`
  - 音频仅支持 pcm/wav/ogg/mp3（不支持 amr）、rate 必须 16000；响应帧 `[header][seq][size][payload]`（size@8、payload@12），`result` 为对象 `{text}`
- `src/modules/agent/asrController.ts`：`AsrCredentials.cluster` → `resourceId`；`createDefaultAsrDeps` 读 `VOLC_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration'`（默认值兜底，无需改 .env）
- 测试：VolcAsrService.spec.ts 重写为 V3（parseFrame 按发送帧布局、audio sequence 从 payload 读）、asrController.spec.ts 改 credentials；13/13 通过
- 配套前端（aistock-app-frontend）：App 录音格式 amr+8k → pcm+16k

---

## [master] 2026-08-19 — 火山 ASR V2 鉴权与错误帧解析修复（线上诊断驱动）

**开发者**: Aria

### 修复
- `src/modules/agent/VolcAsrService.ts`：
  - WebSocket 建连补 `Authorization: Bearer; {token}` header（**分号**分隔，官方 Token 鉴权格式；不加 → 401 missing Authorization，`Bearer ` 空格 → invalid auth token）
  - onmessage 处理 `SERVER_ERROR_RESPONSE(0xF)` 错误帧（原只认 0x9 成功帧，403 错误帧被丢弃 → 识别等到 10s 超时，App 显示「语音识别超时」）
  - 帧 size 偏移按类型区分：成功帧 0x9 size@4；错误帧 0xF 实测 `[header 4B][backend_code 4B][size 4B][payload]` size@8（曾统一读 offset4 读到 backend_code 45000030 误判粘包跳过）
- 根因：火山账号未开通「流式语音识别」资源，返回 403 type=15 错误帧；错误帧被忽略 → 超时。代码修复后错误毫秒级透出：`[resource_id=volc.streamingasr.common.cn] requested resource not granted`（剩余 403 需火山控制台开通资源）
- 测试：VolcAsrService.spec.ts 新增「错误帧 type=0xF 透出 message」用例（按实测帧布局构造），7/7 通过

---

## [master] 2026-08-19 — 修复火山 ASR 在服务器 Node20 下 502（全局 WebSocket 缺失）

**开发者**: Aria

### 修复
- `src/modules/agent/VolcAsrService.ts`：默认 WS 客户端由「Node 22+ 内置全局 `new WebSocket(url)`」改为 npm `ws` 包（与 volcenginePodcast.service.ts TTS 同库，规避 Node 版本依赖）；新增最小接口 `VolcAsrWsLike`（onopen/onmessage/onclose/onerror/send/close），`wsFactory` 类型对齐。
- 根因：服务器 pm2 将 aistock-app-api 跑在 Node v20.20.2（全局 WebSocket=undefined），每次识别抛 ReferenceError → 502「语音识别服务异常」（前端未 parse res.data 吞成笼统文案，配套前端修复见 aistock-app-frontend）。

---

## [master] 2026-08-19 — /api/agent/asr 改 multer multipart（配合 App 端 uni.uploadFile 直传根治）

**开发者**: Aria

### 改进
- `src/index.ts`：`/api/agent/asr` 由 `express.raw(audio/amr)` 改为 `multer.memoryStorage().single('file')`（multipart 字段 `file`，5mb）。
- `src/modules/agent/asrController.ts`：`recognize` 从 `req.file.buffer` 取音频（替代 req.body Buffer）。
- 依赖：新增 multer@2.2.0、@types/multer@2.2.0。

---

## [master] 2026-08-19 — 趋势股评分 K 线改用腾讯前复权，消除除权除息假跳变

**开发者**: Aria

### 修复
- `src/modules/monitor/TrendScoreService.ts`：新增 `parseTencentKlineToTrendKline`（兼容 TencentKlineService.getKLine 对象格式与原始行数组，日期转 YYYYMMDD、OHLC 与 Tushare 一致）与 `fetchAdjustedTrendKline`（腾讯日K fqt=1 前复权，近120日）；`calcTechnicalDim` 新增 klineOverride 参数，评分 K 线展示优先用前复权数据，获取失败回退 Tushare 不复权；修复源杰科技等除权股不复权价格断裂假跳变（2026-05-18 除权后 40% → 前复权 -1.6%）。
- `tests/TrendScoreKlineAdjusted.test.ts`：新增 3 个测试用例（含除权标记行数组格式、非法行处理、getKLine 对象格式）。

### 文档
- `src/modules/monitor/AGENTS.md`：补充趋势股评分 K 线前复权说明。

---

## [master] 2026-08-19 — 风口龙头板块净流入彻底下线，改用同花顺实时成交额

**开发者**: Aria

### 改进
- `src/modules/monitor/WindLeaderAnalyzerService.ts`：删除东财派生板块资金流（getMoneyflowCntThs/getMoneyflowIndDc 及导入、相关类型）；板块级别 net_inflow 字段、AI prompt 的「板块净流入」行、ruleBasedAnalysis 的 amountTrend 全部移除；板块资金评分回退为「频次60%+平均涨幅25%+最新涨幅15%」。保留个股级资金流不受影响。
- `src/modules/monitor/WindLeaderService.ts`：板块类型移除 net_inflow，新增 amount（板块当日成交额·元）；getAnalysis 实时增强：经 RotationBoardStore.fetchBoardRealtime（同花顺 d.10jqka.com.cn/v6/line/bk_<code>/01/last.js）以盘中实时涨幅/成交额覆盖静态快照。
- `src/modules/monitor/RotationBoardStore.ts`：新增 fetchBoardRealtime 板块实时盘口读取（30s 内存缓存 TTL）。

---

## [master] 2026-08-19 — 自选股排序：sort_order 字段 + 排序保存接口

**开发者**: Aria

### 新增
- `src/modules/auth/userController.ts`：
  - `user_stocks` 幂等迁移新增 `sort_order` 字段；列表查询改按 `sort_order ASC, created_at DESC` 排序。
  - `addFavorites` 新添加股票 `sort_order` 置为当前最大值 +1。
  - 新增 `saveFavoritesOrder`：按传入 symbols 顺序批量更新 `sort_order`，仅更新该用户自选内的代码。
- `src/index.ts`：注册 `PUT /api/users/me/favorites/order` 路由。

---

## [feat/fear-greed-node] 2026-08-18 — 恐贪指数服务：Python FastAPI 迁移为 Node/TS 并入 app-api

**开发者**: 林晓研

### 新增
- `src/modules/fear-greed/indicators.ts`：恐贪指数纯函数（clamp / percentileRank / pctRankOrNeutral / labelOf / levelOf / sparkline）
- `src/modules/fear-greed/calculator.ts`：韭圈儿 6 指标计算（波动率 / 北向资金偏离 / 上涨占比 / IF 升贴水 / 股债回报差 / 融资买入），前 5 等权合成综合指数
- `src/modules/fear-greed/FearGreedService.ts`：编排服务（内存 30 分钟缓存 + PG 快照表 fear_greed_snapshot / breadth_daily + Redis 缓存 + 上证指数序列对齐）
- `src/modules/fear-greed/controller.ts`：dashboard / indexes / history / refresh 四个路由处理器
- `tests/fear-greed.indicators.test.ts`、`tests/fear-greed.calculator.test.ts`：单元测试（node --import tsx --test）
- `src/index.ts`：注册 `/api/fear-greed/*` 路由、每日 16:30 cron 自动刷新、启动时幂等建表

### 重构
- 原独立 Python FastAPI 服务（aistock-fear-greed）迁移为 Node/TS 模块并入 app-api，路由契约保持 `/api/fear-greed/*` 不变；Web demo 与 agent-py services/ 已清理

---

## [master] 2026-08-17 — 交易日历公开接口（非交易日过滤支撑）

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

## [changer] 2026-08-17 — ASR 音频格式 wav → amr（对齐 App 端录音格式契约）

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

---

## [master] 2026-08-17 — 风口龙头：短线榜排序口径（上榜次数-热度）+ 最近交易日窗口修复

**开发者**: Aria

### 修复
- `src/modules/monitor/WindLeaderAnalyzerService.ts`：
  - `applyDualRankings` 短线榜排序由 `short_term_days → freq20` 改为**上榜次数 freq20 → 热度 short_heat（存于 ai_analysis）** 降序。原 `short_term_days` 是 HotSectorAnalysis 顶层不存在字段（实际在 ai_analysis 内），比较恒为 0，短线榜实际只按 freq20 排序且与前端口径不一致；现显式读 `ai_analysis.short_heat`，与前端 leaders 页"上榜次数-热度"口径统一
  - `getLatestDailyMap` 最近交易日回溯窗口 3 天 → **10 天**：分析在凌晨运行，周一/长假后首个交易日可能位于 3 个日历日之外（如 2026-08-17 周一凌晨只回溯 17/16/15 均非交易日），导致 moneyflow 日期回退到当天返回空 → 所有板块 net_inflow=0、MA60 缺失（日志：`资金流向数据获取成功: 0条`）。10 天可覆盖周末 + 长假
- `tests/WindLeaderCycle.test.ts`：短线榜测试改为断言 freq20→short_heat 降序；顺带修正 `deriveCycle({})` 陈旧断言（四态化后兜底为 none 非 short）

### 验证
- WindLeaderCycle 8/8 通过；`npx tsc --noEmit` 0 错误；用线上数据模拟新排序验证顺序符合"上榜次数-热度"

---

## [changer] 2026-08-16 — 修复 Chat WS 桥接帧类型：文本帧被转成二进制帧导致对话回答为空

**开发者**: 37588

### 背景
H5 对话页 AI 回答为空。定位到 chat-bridge 上游文本帧（agent-py `send_json`）经 `clientWs.send(data)` 转发时，因 `ws` 库 message 回调 data 恒为 Buffer，被默认按二进制帧发送 → 浏览器端 `JSON.parse(Blob)` 失败，所有 WS 事件被静默丢弃。

### 修复
- `src/core/ws/chat-bridge.ts`：上游 → 前端转发显式保留帧类型 `clientWs.send(data, { binary: isBinary })`（文本帧保持文本帧、二进制帧保持二进制帧）
- 测试：`chat-bridge.spec.ts` 新增 2 个帧类型回归用例（上游文本帧 → 客户端 `isBinary=false`；上游二进制帧 → 客户端 `isBinary=true`），断言失败时 finally 关闭连接防 afterEach 挂起

### 验证
- `chat-bridge.spec.ts` 定向 8/8 通过（修复前文本帧用例 RED 失败：`true !== false`）
- `npx tsc --noEmit` 无报错

---

## [changer] 2026-08-15 — 预测验证 v2 支撑端点（指数日 K + 游标分页）

**开发者**: changer-collab

### 新增
- `GET /internal/index/:code/kline`：指数日 K 端点（Tushare index_daily，显式 ts_code 不经 getStockIdentity——`000001` 会被误判为深市个股），预测验证 v2 窗口判定的历史数据源；支持 `days`（1-200）参数，指数映射 000001/000300/000688/399001/399006
- `TushareKlineService.getIndexKLine`：指数日线拉取（index_daily + 统一字段映射，经 tushare 节流器）
- `GET /internal/predictions` 游标分页：`before_id` 参数（pending/listByStatus 均支持，按 id 倒序），防全量扫描

### 改进
- `PredictionRecordService.listPending`/`listByStatus` 支持 `beforeId` 游标参数；非法游标忽略回退全量

---

## [changer] 2026-08-15 — ASR 录音格式 mp3 → wav（对齐前端录音 + 火山识别）

**开发者**: 37588

### 背景
App 真机录音 mp3 不可靠（部分 Android ROM 缺编码器 start 抛错），前端录音改 wav + 16kHz；后端 ASR 链路同步对齐。

### 修复
- `src/modules/agent/VolcAsrService.ts`：火山 full request `audio.format` 'mp3' → 'wav'（rate 16000/bits 16/channel 1 不变，wav 需 pcm_s16le 与 16k 匹配）
- `src/index.ts`：`/api/agent/asr` express.raw type 'audio/mpeg' → 'audio/wav'
- `src/modules/agent/asrController.ts`：接口注释同步
- 测试：`volcAsrService.spec.ts`（format 断言 wav）、`asrController.spec.ts`（Content-Type audio/wav）

### 验证
- `tsx --test` 定向 12/12 通过、`tsc --noEmit` 无报错

---

## [changer] 2026-08-14 — 预测记录支持越年近似档标记

**开发者**: changelog

### 新增
- `POST /internal/predictions` 接受可选 `due_dates_approximate`（string[]，越年近似档名列表），合并进 prediction jsonb（skip_reason 先例，免 DB 迁移）
- 公开统计新增 `approximateHorizonCount`：越年近似档照常验证但 hit/miss 不计入命中率分母（分桶避免统计失真）

### 改进
- internalRouter 校验 `due_dates_approximate` 类型（非数组 / 含非 string 元素 → 400）

---

## [changer] 2026-08-14 — 大盘溯源影响持续性预判记录支持状态追踪与按需补偿

**开发者**: changelog

### 新增
- 预判记录支持"已跳过"状态与原因（无效/无法生成的预判显式落库，不再混入进行中）
- 公开列表支持按溯源报告定向查询（`source_id=review:YYYY-MM-DD`），大盘溯源页预判卡片数据源切换为预判记录
- 按需补偿接口：手动触发当日预判生成（仅限当日 + 频率限制 + 已验证记录拒绝覆盖 + 90s 超时，转发至推理服务）

### 改进
- 统计口径：已跳过记录单独计数（skippedCount），不计入进行中/已结束

---

## [master] 2026-08-14 — 修复风口龙头接口 long_leader 恒为 null（getAnalysis 读时枚举字段遗漏）
**开发者**: Aria

### 修复
- `src/modules/monitor/WindLeaderService.ts`：
  1. `getAnalysis` 返回对象补充 `long_leader: sector.long_leader || null`——此前读数据时显式枚举字段构造返回对象，遗漏新增的 long_leader，导致接口返回恒为 null（数据文件 hot-sectors.json 中实际已有值）
  2. `WindLeaderSector` 接口补充 `long_leader?: WindLeaderStock | null`

### 测试
- `src/modules/monitor/__tests__/windLeaderLongLeader.spec.ts` 追加 `getAnalysis preserves long_leader field in response sectors` 用例（mock fs 读文件），现 5/5 通过

---

## [master] 2026-08-14 — 风口龙头板块新增 long_leader（长期趋势龙头）字段
**开发者**: Aria

### 新增
- `src/modules/monitor/WindLeaderAnalyzerService.ts`：
  1. 新增导出函数 `queryTopTrendScore(codes)`：查 `trend_scores` 表最新评分日中成分股代码集合内 score 最高、非 D 评级、未被 60 日均线剔除（ma60_excluded != true）的股票；返回 `SelectedStock`（reason_tag=评级、source='trend_score'），DB 错误/无命中返回 null（回退路径）
  2. `HotSectorAnalysis` 接口新增 `long_leader: SelectedStock | null`
  3. 主循环板块分析新增第 10 步：行业板块（881xxx）用 `getBoardTopStocks(20,'industry')` 成分股代码、概念板块用概念成分股代码，调 `queryTopTrendScore` 取趋势龙头；无命中回退 `finalMainStocks` 评分最高者

### 测试
- 新增 `src/modules/monitor/__tests__/windLeaderLongLeader.spec.ts`：4 用例覆盖空数组/DB 命中/SQL 过滤条件（MAX(score_date)、排除 D、ma60_excluded）/无命中/DB 错误回退

---

## [changer] 2026-08-13 — 深度分析报告详情查询接口
**开发者**: 37588

### 新增
- 深度分析报告详情查询接口（`/report/chat/:reportId`）：登录用户按报告编号查询本人的深度分析报告；服务端验签 + 归属校验 + 有效期过滤，不存在/非本人/已过期返回空数据，不泄露报告存在性

### 测试
- 鉴权（无/非法令牌 401）、归属与过期过滤、空数据语义、路由优先级（不被通用报告端点抢占）、异常降级用例

> 代码验收通过（待生产验证）。

---

## [master] 2026-08-14 — 修复风口龙头股爬取把新闻链接当龙头（玻璃基板"概念细分|…"）+ 行业板块龙头股缺失
**开发者**: 37588

### 修复
- `src/modules/monitor/WindLeaderAnalyzerService.ts`：
  1. 新增 `isValidStockCode()`（仅接受 A 股代码段 60/68/00/30/43/83/87/92，排除日期型 2026xx 与同花顺板块代码 881/884/885/886xxx）、`isValidStockName()`（长度 2~12，排除 | 分隔符与"概念/细分/新增"等描述词）、`extractStockCodeFromHref()`（排除 news. 域名链接后提取合法代码）
  2. 龙头股爬取策略 1/3/4 全部改用严格校验：同花顺概念页新闻链接 `news.10jqka.com.cn/20260805/c678696112.shtml` 的日期 `202608` 不再被误当股票代码、新闻标题不再被当股票名（此前污染 leading_stock，如玻璃基板显示"概念细分|玻璃基板新增…细分方向"）
  3. `extractLeadingStock` fallback 回退到 main_stocks 评分最高者补全 code/价格/涨幅（行业板块 881xxx 无概念页龙头结构时必走此分支）
  4. 行业板块（881xxx）主循环补充自身成分股进 main_stocks（此前 strongly_related 为空导致 main_stocks 恒空）
  5. `identifyHotConcepts` 领涨股补充按板块类型分流（行业板块用 industry 成分股接口）

### 测试
- 新增 `src/modules/monitor/__tests__/windLeaderStockValidation.spec.ts` 6 用例（合法代码/日期误判/板块代码误判/新闻标题拒收/新闻链接提取）全过

> 验证：`npx tsc --noEmit` 0 错误；新增 6 测试全过；`npm run build` 成功。

---

## [master] 2026-08-14 — 知识图谱修复：专家修正表 + AI prompt 改进 + 缓存 TTL 修复 + 风口行业板块修复
**开发者**: 37588

### 修复
- `src/modules/monitor/IndustryKGService.ts`：
  1. 新增 `EXPERT_INDUSTRY_RELATIONS` 专家人工修正表（约 90 个热门行业权威上下游，按行业名精确匹配；上游=原材料/零部件/设备/能源供应方，下游=应用/渠道/终端；不收录并列、细分-父级、服务外包关系）
  2. 新增 `applyExpertEdges()`：覆盖专家表行业的全部 AI 边，替换为权威上下游；幂等，缓存加载与重新生成统一走这里
  3. `buildAIEdges(industries, force?)`：force 时跳过 ai_edges 缓存；AI 边生成/加载后统一过专家表
  4. `rebuild(force?)`：AI 生成失败时用专家表兜底
  5. `initialize()`：修复缓存 TTL bug——full_graph.json 过期判断改用缓存内部 `updateTime`（此前文件 mtime 被龙头股后台加载重写刷新，15 天 TTL 永不触发）
  6. `aiGenerateChainBatch` prompt 大改：明确 881xxx 二级/884xxx 三级行业概念、严禁把并列/细分-父级/服务外包当上下游、增加半导体/生物制品正确示例
- `src/modules/monitor/WindLeaderAnalyzerService.ts`：风口榜单行业板块（881xxx）新增 `isIndustryBoardCode()` + `mapIndustryToChain()`——行业板块不走"概念→行业"映射（此前找不到概念 fallback 随机行业排名导致 related 错乱、上下游为空），改从知识图谱直接取该行业上下游（`getUpstreamDownstreamByName`，失败容错返回空）；主循环两处调用点按板块类型分流

### 文档
- `src/modules/monitor/AGENTS.md`：补充 IndustryKGService 专家修正表/TTL 修复/AI prompt 层级约束，以及风口行业板块 mapIndustryToChain 说明

> 验证：`npx tsc --noEmit` 0 错误；专家表覆盖逻辑本地脚本断言 6/6 通过（贵金属错误边电力/民爆移除、新增上游工业金属+下游饰品/半导体等；生物制品错误边动物保健/原料药移除、保留医院等下游）。

---

## [changer] 2026-08-12 — Phase 5 删会话联动删 checkpointer thread
**开发者**: 37588

### 新增
- `src/modules/chat/agentThreadClient.ts`：`deleteChatThread(sessionId)`——调用 agent-py `DELETE /api/agent/internal/chat/threads/:session_id`（X-Internal-Token；AbortController 3s 超时；非 2xx 抛错；env：`AGENT_PY_URL || PYTHON_AGENT_URL || http://localhost:8080`）

---

## [junliang] 2026-08-06 — 自选股洞察：事件归属锚定标题主体股票 + 归因回写修复

**开发者**: Aria

---

## [master] 2026-08-06 — 风口龙头 v4-flash 思考关闭不可靠的兜底：JSON 截断重试 + 数据异常提示

**开发者**: Aria

### 修复
- `src/modules/insight/InsightService.ts`：自选股事件匹配锚定标题主体股票（"XX触及涨停"），详情页推荐/相关股票链接不再创建事件（修复事件挂错标的，如汇金通被挂到中国电建）；单篇详情抓取失败仅记日志跳过不中断整轮
- `src/modules/insight/LimitUpRadarCrawler.ts`：新增 `parseTitleStockName`（提取标题主体股票并去除括号代码）；详情页为 UTF-8，fetchDetail 显式指定编码；列表分页按 articleId 去重（CDN 缓存抖动）
- `src/db/migrations/016_watchlist_insights.sql`：`watchlist_insight_results.confidence` 由 VARCHAR(8) 扩为 VARCHAR(16)（'unconfirmed' 11 字符超长导致结果回写 500）
- `src/shared/utils/crawler.ts`：`fetchHtml` 支持 `encoding` 参数（'gbk'|'utf-8'，默认 gbk），修复详情页乱码

### 测试
- `src/modules/insight/__tests__/limitUpRadarCrawler.spec.ts`：新增 5 个 `parseTitleStockName` 用例（含涨停复盘类标题返回 null）

---

- `WindLeaderAnalyzerService.aiAnalyzeSector`：v4-flash 深度思考无法 100% 关闭——长 prompt + 异常数据（领涨股涨幅0/涨跌家数0）时模型仍会思考，耗尽 max_tokens 导致 content 为空或 JSON 截断（`Unterminated string in JSON`）→ ① max_tokens 提档 [2000,6000] ② JSON 截断/解析失败也触发提高 max_tokens 重试（原仅 content 空才重试）③ 请求超时 60s→90s
- `buildAiPrompt`：提示词增加"输入数据可能存在异常，请忽略并直接基于现有数据判断，不要质疑数据"（模型曾因异常数据陷入深度思考）

---

## [master] 2026-08-06 — 风口龙头 AI 关闭深度思考：deepseek-v4-flash 直接输出 JSON

**开发者**: Aria

### 修复
- `WindLeaderAnalyzerService.aiAnalyzeSector`：DeepSeek V4 系列（v4-flash/v4-pro）默认开启深度思考，`max_tokens` 被 `reasoning_content` 耗尽导致 `content` 为空（服务器实测）→ 对 deepseek 模型请求体附加 `reasoning_effort:"none"` 显式关闭思考，模型直接输出 JSON（服务器实测有效，不换模型）
- AI 输出健壮性：`long_term_days`/`short_term_days` clamp 到 schema 范围（0~90 / 0~30），防 LLM 越界值（实测模型输出过 120 天）

---

## [master] 2026-08-06 — 风口龙头 AI 推理模型兜底：content 空自动提高 max_tokens 重试

**开发者**: Aria

### 修复
- `WindLeaderAnalyzerService.aiAnalyzeSector`：服务器日志定位到 `content=""` 但 `reasoning_content` 有内容——`AI_MODEL` 配置的是推理模型（deepseek-reasoner/v4 推理版），token 消耗在思考过程、最终答案为空 → 新增重试：content 空且存在 reasoning_content 时提高 max_tokens（1200→4000）重试一次；请求超时 45s→60s。仍失败则降级规则引擎（已按月分档+标签区分）
- 更优解：服务器 `AI_MODEL` 直接改用非推理模型 `deepseek-chat`（curl 实测直接输出 content）

---

## [master] 2026-08-06 — 风口龙头双链修复：AI 截断降级 + 规则引擎月度分档 + 标签区分

**开发者**: Aria

### 修复
- `WindLeaderAnalyzerService.aiAnalyzeSector`：`max_tokens` 500→1200（14 字段+80 字理由的中文 JSON 在 500 token 下被截断 → `JSON.parse` 报 `Unexpected end of JSON input` → 全部板块走规则引擎，长线全 45 天、标签全"资金"；服务器实测 DeepSeek API 正常，确认为截断问题）
- `WindLeaderAnalyzerService.ruleBasedAnalysis`：长线持续天数由固定 45 天改为按月分档（30/60/90 天，对应 1/2/3 个月）；`logic_type` 按板块名关键词区分（政策/业绩/资金/无支撑），避免降级时全部为"资金"

### 改进
- `src/modules/chat/sessionController.ts` `remove`：PG 删除 `chat_sessions` 成功后 `await deleteChatThread(sessionId)`（`__threadClientDependencies` 注入点供测试 stub）；失败仅 warning 不阻断，仍返回 200（"永不 500"）

### 测试
- `src/modules/chat/__tests__/session.spec.ts` +2（联动调用触发 / 联动失败仍 200）

> 验证：tsc --noEmit 0 错误；chat 定向 18/18。配套 agent-py Phase 5（窗口+零 LLM 摘要 / 删 thread / busy_timeout）。代码验收通过（待生产验证），待组长 merge 后部署验证。

---

## [changer] 2026-08-12 — 问题 19 修复：user_profile 缓存失效连接对齐 agent-py 真实 Redis
**开发者**: 37588

### 修复
- `src/modules/user/profileController.ts`：新增 `resolveAgentCacheRedisUrl()`——缓存失效连接默认值原写死 `redis://127.0.0.1:6379/1`（无密码），生产 Redis requirepass + agent-py 画像缓存实际在 db15 → `NOAUTH` 失效从未执行（DELETE 后 300s 内旧画像仍生效，删除权失效窗口，Phase 4 生产验证 D3 实证）。现改为：`AGENT_PROFILE_CACHE_REDIS_URL` 显式覆盖优先；未配置则从本服务 `REDIS_URL` 派生（保留 auth/host/port，仅把 db 段替换为 `AGENT_PROFILE_CACHE_DB`=15，与 agent-py 缓存真实位置对齐）；无 `REDIS_URL` 兜底 `redis://127.0.0.1:6379/15`。`_agentCacheRedisFactory.current` 改为运行时调用

### 新增
- 测试：`src/modules/user/__tests__/profile.spec.ts` +4 用例（显式 env 优先 / REDIS_URL 派生替换 db / 无 db 段追加 / 无配置兜底），18/18 通过

### 文档
- `src/modules/user/AGENTS.md`：硬约束"跨库缓存失效"更新为 db15 + 派生逻辑描述（原 db=1 描述过时）

> 待部署：push → PR → merge → 服务器 `git pull` + `tsc` build + `pm2 restart` → 重跑 D3（DELETE 后立即对话应回通用档）。

---

## [changer] 2026-08-11 — P1 JWT 撤销与演进（token-revocation）
**开发者**: 37588

### 新增
- `src/shared/utils/tokenBlacklist.ts`：`revokeToken`（按 jti 写 `token_blacklist:{jti}`，TTL=剩余寿命 clamp [1,7天]，返回 `{ok, persisted}`）、`isTokenRevoked`（读侧 fail-open + 读异常 WARN 非静默）、`extractTokenFromRequest`（Bearer 优先 Cookie 兜底）、`REVOKED_MESSAGE`
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

---

## [changer] 2026-08-11 — P0 身份鉴权（Phase 1a）
**开发者**: 37588

### 新增
- `src/core/ws/chat-bridge.ts`：接管 `/api/agent/ws/chat` upgrade——验签 query token（无 token 放行 user_id=None；非法/过期 close(4401)），作为 WS 客户端连 agent-py（带 X-Internal-Token），双向转发并覆写消息体 user_id（客户端自报失效）
- `src/core/ws/__tests__/chat-bridge.spec.ts`（6 用例）、`src/shared/utils/__tests__/jwt.spec.ts`（7 用例）

### 修复
- `src/shared/utils/jwt.ts`：verifyJwt 畸形输入 fail-closed（签名长度预检 + try/catch 返回 null，不抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH）
- `src/core/ws/handler.ts`：改 noServer + 按 path 精确分发（ws@8 双 {server,path} 实例对不匹配 path abortHandshake(400) 互斥）

### 改进
- `src/modules/agent/agent.proxy.ts`：chat 三路径（/chat/message、/chat/stream/messages、/chat/stream/updates）Authorization Bearer JWT 校验（非法/过期 401）+ 覆写 body user_id；非 chat 路径行为零变化
- `src/index.ts`：挂载 chat 桥接 + createAgentProxy 传 jwtSecret

> 部署注意：Caddy `/api/agent/ws/*` 已指向 app-api（管理员 2026-08-11），本改动部署后 WS 恢复 + HTTP 面鉴权生效；前端发版须在其后。

---

## [changer] 2026-08-10 — B2.1 历史预测跟踪公开查询接口（/api/predictions）

**开发者**: 37588

### 新增
- `src/modules/prediction/publicRouter.ts`：`GET /api/predictions`（列表 + 命中率统计 + 分页，status=all|pending|verified）、`GET /api/predictions/:id`（详情）；公开接口无需 X-Internal-Token；`__predictionPublicDependencies` 测试注入点；`toItem` 中 `id` Number() 归一（pg BIGSERIAL 返回 string）
- `src/modules/prediction/publicRouter.test.ts`：路由层 6 用例（400×2 / 列表统计 / hitRate null / 详情 / 404，mock Service 不触达 PG）
- `src/modules/prediction/PredictionRecordService.ts`：`list` / `listAllForStats` / `getById` 三个查询方法

### 改进
- `src/index.ts`：挂载 `/api/predictions`（404 catch-all 之前）

### 测试
- `publicRouter.test.ts` 6/6；`npx tsc --noEmit` 0 错误；真实联调 curl 列表/详情/400/404 全部正确

---


## [changer] 2026-08-10 — B2 预测能力落库接口（prediction_records）

### 新增
- `src/core/routes/internal.ts`：`POST /internal/predictions`（upsert，`(source_type, source_id)` 唯一索引 + ON CONFLICT DO UPDATE）、`GET /internal/predictions?status=pending`、`PUT /internal/predictions/:id/verification`（appendVerification 全档位覆盖自动置 verified）
- `src/modules/prediction/PredictionRecordService.ts`：create / listPending / appendVerification

### 改进
- `src/index.ts`：启动时自动建表 `prediction_records`（status 仅 {pending, verified}）
