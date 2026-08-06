# Changelog — aistock-app-api

> 所有修改记录按时间倒序排列。每条记录标注分支、时间、开发者。

## [master] 2026-08-06 — 风口龙头双链修复：AI 截断降级 + 规则引擎月度分档 + 标签区分

**开发者**: Aria

### 修复
- `WindLeaderAnalyzerService.aiAnalyzeSector`：`max_tokens` 500→1200（14 字段+80 字理由的中文 JSON 在 500 token 下被截断 → `JSON.parse` 报 `Unexpected end of JSON input` → 全部板块走规则引擎，长线全 45 天、标签全"资金"；服务器实测 DeepSeek API 正常，确认为截断问题）
- `WindLeaderAnalyzerService.ruleBasedAnalysis`：长线持续天数由固定 45 天改为按月分档（30/60/90 天，对应 1/2/3 个月）；`logic_type` 按板块名关键词区分（政策/业绩/资金/无支撑），避免降级时全部为"资金"

### 改进
- `buildAiPrompt`：`long_term_days` 引导按月分档输出（1/2/3 个月→30/60/90 天）
- `aiAnalyzeSector`：失败诊断增强——先读原始响应体再 JSON.parse，失败日志含 HTTP 状态与响应前 300 字符

---

## [master] 2026-08-05 — ChatAgent P10 会话维度（线 4）后端

**开发者**: Aria

计划：`D:\ai_stock_app\docs\superpowers\plans\2026-08-05-chat-agent-p10-session-dimension.md`（T1）

### 新增
- `src/core/routes/internal.ts`：`GET /internal/usage/sessions?user_id=`（X-Internal-Token）按 session_id 聚合 chat_token_usage（turn_count/total_tokens/prompt_tokens/completion_tokens/last_used_at，pg SUM/COUNT 统一 `Number()` 数值化；user_id 缺失/空→400；无记录 items 空数组）
- `src/modules/chat/sessionUsageController.ts`（新增）：`GET /api/chat/usage/sessions`（聚合 + LEFT JOIN chat_sessions 补标题，JOIN 不到为空串，按 last_used_at DESC）+ `GET /api/chat/usage/sessions/:id`（单会话最近 20 条明细，`WHERE user_id=$1 AND session_id=$2` 归属校验防越权）；鉴权 = JWT openid（Authorization Bearer + Cookie 兜底）
- `src/index.ts`：注册 2 条公开路由（静态 `/sessions` 先于参数化 `/sessions/:id`）

### 测试
- `src/core/routes/__tests__/internal_session_usage.spec.ts`（新增，4 用例）+ `src/modules/chat/__tests__/sessionUsage.spec.ts`（新增，5 用例）；定向 `npx tsx --test` 9/9 通过，`npx tsc --noEmit` 0 错误

> 遗留：前端会话列表用量展示（线 6）未做（2026-08-05 用户指示本次只做线 4）；6 项 Minor 收尾清单见 `docs/superpowers/plans/chat-agent-roadmap.md` §6.6；app-api `AGENTS.md` §7.1/§7.5 API 表补 3 端点待做。

---

## [master] 2026-08-06 — moneyflow 资金流合并 + Tushare 请求字段对齐 + 无效接口改替代数据源

**开发者**: Aria

### 重构
- `TushareService.ts`：合并资金流数据源，删除 `getMoneyflowByDate`/`getMoneyflow`/`MoneyflowRow`；`getMoneyflowThsByDate` 请求字段升级为原版 `moneyflow` 完整分项（buy/sell × sm/md/lg/elg + net_mf_amount/net_mf_vol），`WindLeaderAnalyzerService.fetchTushareEnhancement` 只保留单一 `moneyflowThsMap`
- 资金流 `mf_5day`（5日主力净额）：原版接口无此字段，新增 `getMoneyflowThs5dMap`（moneyflow_ths 接口 `net_d5_amount`，需 6000 积分），在风口与 TenxScore 预加载处回填；moneyflow_ths 输出仅含 net_amount/net_d5_amount/buy_lg|md|sm_amount(+_rate)，无 buy_elg/sell_* 分项，仅作补充

### 修复
- 对照 Tushare 官方文档核对全部接口请求字段，修复 5 处不一致：`limit_step`（改用 nums，`MarketSnapshotService.computeHighestBoard` 同步）、`stk_surv`（surv_date/rece_org，TenxScore 调研统计同步）、`broker_recommend`（无评级字段移除）、`limit_cpt_list`（days/cons_nums/up_nums）、`hk_hold`（删不存在的 amount）
- `daily_basic` 无 `is_st` 字段 → `getStStatus` 改用 `stock_basic` 的 name 判断 ST（ST/*ST/S*ST/SST 前缀）
- `stk_holdertype` 接口不存在 → 删除 getInstitutionalHold；机构持股比例改用 `top10_holders` 实测 `holder_type` 字段（机构类白名单/非机构黑名单：一般企业/自然人/国资局），TenxScore 市场认可度评分权重恢复（机构 25% + 北向 15%）
- `stk_analyst`/`major_news` 不可用 → `getAnalystRating` 仅走 `report_rc`（rating/org_name 均有评级字段）
- `net_mf_ratio` 两个接口均不存在（此前风口因子5恒为常数5分、TenxScore 1g 净占比恒为0）→ 新增 `calcMainForceNetRatio` 用金额分项推导主力（大单+特大单）净流入占比，替换两处消费点

---

## [master] 2026-08-05 — cls_news 缺失修复：telegraph 分页上限不足

**开发者**: Aria

### 修复
- `src/modules/monitor/ClsStockNewsService.ts`：`fetchTelegraphByDate` 的 `MAX_PAGES` 由 10 提高到 50（约 500 条）。财联社电报约 3 分钟/条，晚间触发（20:30 review_full / 手动 review_quick）时最新电报晚于 dateEnd(16:00) 被跳过，需翻页跨越数小时才能到 08:30-16:00 窗口；原 MAX_PAGES=10（100 条）翻不到 → items 空 → total=0 → cls_news 缺失

---

## [master] 2026-08-05 — moneyflow 接口字段错配修复 + main_force NaN 防护

**开发者**: Aria

### 修复
- `src/modules/quote/TushareService.ts`：`getMoneyflowThs`/`getMoneyflowThsByDate` 由 `moneyflow_ths` 接口改为原版 `moneyflow` 接口。原实现请求的字段（`buy_elg_amount`/`sell_lg_amount`/`sell_elg_amount`/`net_mf_amount`）是原版 `moneyflow` 的字段名，但 `moneyflow_ths` 实际只有 `buy_lg_amount`（大单净流入）/`net_amount`/`net_d5_amount` 等，导致除 `buy_lg_amount` 外全部 undefined → `computeMainForceNetYuan` 得 NaN 被 JSON 序列化为 null（quick 快照 `main_force=available+null` 根因）
- `src/modules/quote/MarketSnapshotService.ts`：`computeMainForceNetYuan` 加 `Number(x)||0` 防护避免 NaN；新增 `hasCompleteMainForceFields` 字段完整性检查
- `src/modules/quote/TencentSnapshotService.ts`：`hasMainForce` 与 `assembleSnapshot` 的 main_force 分支改为「有数据且字段完整」才用 Tushare 精确值，否则降级概念板块近似（partial+approximate）或 unavailable，不再返回 available+null

### 测试
- `tests/TencentSnapshotService.test.ts`：新增 2 个回归用例（字段不完整降级 conceptFlow、`hasCompleteMainForceFields` 判定）

---

## [master] 2026-08-05 — internal/trend/top 回退 parseJsonb + StockInfoService 测试修正

**开发者**: Aria

### 修复
- `src/core/routes/internal.ts`：`/internal/trend/top` 的 `dimScores` 从 `parseJsonb(r.dim_scores)` 回退为 `JSON.parse(r.dim_scores as string || '[]')`，移除 parseJsonb import
- `tests/StockInfoService.test.ts`：修正 import 路径（`src/core/db` → `src/db`、`src/modules/crawler/StockInfoService` → `src/services/StockInfoService`）；删除重复的推送过滤边界断言（中性/利空/重大利空/窗口外用例，已由专门测试覆盖）

---

## [changer] 2026-08-05 — ChatAgent P9 会话管理 + P10 线 2 计费（用户维度）

**开发者**: Aria

计划：`D:\ai_stock_app\docs\superpowers\plans\2026-08-05-chat-agent-p9-session-management.md`、`D:\ai_stock_app\docs\superpowers\plans\2026-08-05-chat-agent-p10-user-billing-backend.md`

### 新增
- `src/index.ts`：启动时自动建表 `chat_sessions`（P9 会话元数据：id VARCHAR(64) PK、user_id=JWT openid、title 默认'新会话'、last_message_at、created_at，索引 idx_chat_sessions_user(user_id, last_message_at DESC)）与 `chat_token_usage`（P10 线 2 用户维度计费：BIGSERIAL PK、user_id、session_id 预留、prompt/completion/total_tokens、question、created_at，索引 idx_chat_token_usage_user + idx_chat_token_usage_session）
- `src/modules/chat/sessionController.ts`（新增）：`POST /api/chat/sessions`（幂等 upsert，title=question 前 30 字；同 id 重复上报仅刷新 last_message_at，id 已归属他人→409）、`GET /api/chat/sessions`（当前用户最近 50 会话）、`DELETE /api/chat/sessions/:id`（id+归属双条件防越权）；鉴权 = JWT openid（Authorization Bearer + Cookie 兜底）
- `src/modules/chat/usageController.ts`（新增）：`GET /api/chat/usage/summary` 当前用户累计 token 用量（prompt/completion/total_tokens + turn_count，无记录全 0）
- `src/core/routes/internal.ts`：`POST /internal/usage/records`（Python ws.py 计费回调；user_id 必填非空、token 字段非负整数，成功 `{code:200,data:{id}}`）+ `GET /internal/usage/summary?user_id=`（SUM/COUNT 聚合，无记录全 0）

### 测试
- `src/modules/chat/__tests__/session.spec.ts`（新增）+ `usageSummary.spec.ts`（新增）+ `src/core/routes/__tests__/internal_token_usage.spec.ts`（新增）

### 文档
- `README.md`：API 路由表 + Internal API 表补 chat 会话/用量端点，补充两张新表说明
- `AGENTS.md`：§2 业务模块表 + §3 目录结构 + §7.1 Internal API 表 + 新增 §7.5 Chat 会话与用量公开接口

---

## [changer] 2026-08-04 — ChatAgent P6 退役清理（market-trace-qa 代理契约）

**开发者**: Aria

计划：`D:\ai_stock_app\docs\superpowers\plans\2026-08-04-chat-agent-p6-retirement.md`

### 测试
- `src/modules/agent/__tests__/agent.proxy.spec.ts`：删除 3 条 market-trace-qa 代理契约测试（118 行，Python `POST /market-trace-qa/message` 端点已退役）；其余 `/chat/*`、`/ws` 代理契约测试与 `createAgentProxy` 保留
- `tests/marketTraceQaInternalRoutes.test.ts`：保留（`GET /internal/analysis-reports/:type/:date` 读取契约，`load_validated_trace`/`trace_loader` 消费），文件头注释同步更新

### 测试
- `npx tsc --noEmit` 0 errors；定向测试（agent.proxy.spec + marketTraceQaInternalRoutes）29/29 通过

---

## [changer] 2026-08-04 — ChatAgent P5 两个 internal 端点（kline + index/quotes）

**开发者**: Aria

计划：`D:\ai_stock_app\docs\superpowers\plans\2026-08-04-chat-agent-p5-capability.md`

### 新增
- `src/core/routes/internal.ts`：`GET /internal/quote/:symbol/kline`（Tushare 日 K 线，days≤120/klt=101/fqt∈{0,1,2}，复用 TushareKlineService，双键兼容映射——服务实际返回中文键）
- `src/core/routes/internal.ts`：`GET /internal/index/quotes`（A 股指数快照，6 位纯数字代码/逗号分隔/上限 MAX_SYMBOLS，复用 IndexQuoteController，驼峰输出，腾讯源失败单指数 → null 不整体 500）
- `src/modules/quote/indexController.ts`：抽取 `fetchCnIndexQuotesData(symbols)` 供 public + internal 复用（public `/api/cn/index/quotes` 响应体字节不变）

### 测试
- 新建 `src/core/routes/internal.kline.test.ts`（5 用例）+ `internal.index-quotes.test.ts`（6 用例），共 11/11 通过
- 既有 internal 路由测试 42/42 无回归；`npx tsc --noEmit` 0 errors

### 文档
- `AGENTS.md`：§7.1 Internal API 表补 2 端点

---

## [feat/market-trace-improvement] 2026-08-03 — 播报功能优化（文本存库 + 音频缓存 + 限长1分钟）

**开发者**: Aria

### 改进
- `src/core/routes/internal.ts`：POST /api/agent/brief/generate-podcast 文本限长 2000→250 字（约1分钟）；请求先按 cache_key upsert 进 podcast_cache 表（ON CONFLICT 更新 text），音频生成成功回填 audio_path，失败标记 status='failed' 返回降级文本；音频命中缓存直接复用 audio_url，不重复调用火山 TTS

### 新增
- `src/index.ts` + `docs/sql/podcast_cache.sql`：podcast_cache 表（cache_key UNIQUE、text、audio_path、status、error_message、expires_at 7天），03:00 清理任务扩展为删除过期行 + 对应 podcast-{key}.mp3

### 测试
- `tests/internalRoutes.test.ts`：新增 3 个 generate-podcast 校验测试（空文本 / 超250字 / 空 key 均返回 400），42/42 PASS

---

## [changer] 2026-08-03 — P3-fix-3 大盘数据正确性最小补丁 + P2 遗留

**开发者**: Aria

计划：`D:\ai_stock_app\docs\superpowers\plans\2026-08-03-p3-fix-3-market-data-correctness.md`

### 新增
- `src/shared/utils/TradingCalendarService.ts`：新增 `getPreviousTradingDay(date)` — 严格早于指定日期的最近交易日（与时刻无关；返回点归一化 08:00 上海=UTC 午夜），last-close 回退用
- `src/modules/quote/MarketSnapshotService.ts`：`getLastCloseSnapshot` 目标日改 `getPreviousTradingDay(now)`（消除 15:00–15:30 空窗 409；目标日数据缺失仍诚实 409）
- `src/modules/quote/TencentSnapshotService.ts`：`buildQuickSnapshot` 先算 tradeDate → `isTradingDayYyyymmdd` 校验（非交易日抛 market_not_closed，映射 409，消除"伪当日"）→ 15:30 时钟门禁
- `src/core/routes/internal.ts`：`VALID_REPORT_TYPES` 增加 `chat_analysis`（P2 遗留，与 P3-fix-3 一并提交）

### 测试
- `tests/TradingCalendarService.test.ts` 新建 5 用例（周一 15:10 / 周末白天 / 凌晨 03:00 / 长假回溯 / 覆盖外失败关闭）
- `tests/MarketSnapshotService.test.ts` +2（三墙钟场景回退、目标日日线不完整 409）
- `tests/TencentSnapshotService.test.ts` +1（非交易日 15:30 后拒绝，红线）
- `src/core/routes/__tests__/internal_chat_analysis.spec.ts` 新增（P2 遗留）

### 文档
- `AGENTS.md`：§7.1 Internal API 表 +3 行 market 端点（quick 非交易日 409 / close 15:30 门禁 / last-close 严格早于今天）

### 验证
- `npx tsc --noEmit` 0 错误；定向 3 文件 44/45（唯一失败为既有陈旧断言，归基线）
- 全量 182 tests：172 pass / 10 fail，失败集 ⊆ 基线（7002295 worktree 对比），新增失败清零
- SDD 审查：T1-T3 逐 Task Approved + 最终整分支审查 Ready to merge Yes

---

## [master] 2026-08-02 — M4 名称解析端点 GET /internal/stock/resolve

**开发者**: Aria

### 新增
- `src/core/routes/internal.ts`：新增 `GET /internal/stock/resolve?name=<名称>` 端点（200 `{code,data:{name,symbol}}` / 400 缺 name / 404 未命中 / 502 服务异常），遵循内部 API 风格，供 Python ChatAgent M1 resolve_symbol 调用
- `src/modules/monitor/HotKeywordDetectorService.ts`：新增导出 `resolveStockName(name)`（stockNameMap 精确 + sortedNames includes 模糊，未命中返回 null），不改既有导出接口

### 测试
- `tests/internalRoutes.test.ts`：新增 3 用例（茅台→200+symbol=600519 / 不存在名称→404 / 缺 name→400）

### 文档
- `README.md`：补充本机已装 PostgreSQL/Redis 时双击 `start-dev.bat` 一键启动说明

---

## [master] 2026-08-01 — 异动监控新增手动触发检测端点

**开发者**: Aria

### 新增
- `src/modules/stock-trace/controller.ts`：新增 `detect` 静态方法，调 `PriceTriggerDetector.runOnceForce()`
- `src/index.ts`：注册 `POST /api/cn/favorites/movements/detect`（在 `:eventId` 路由之前，避免 detect 被当作 eventId）

### 改进
- `src/modules/stock-trace/PriceTriggerDetector.ts`：抽出 `detect()` 私有方法供 `runOnce` 和 `runOnceForce` 共用；`runOnce` 保持交易时段检查（定时轮询用）；新增 `runOnceForce` 绕过 `isAShareTradingTime`（手动触发用）

---

## [master] 2026-08-01 — 通用播报生成 API + alert 报告按 symbol 查询端点

**开发者**: Aria

### 新增
- `src/core/routes/internal.ts`：`POST /api/agent/brief/generate-podcast`（publicRouter，单主播朗读 text，key 做缓存幂等，文件名 `podcast-{safeKey}.mp3`，复用 `synthesizeBroadcast` 合成）
- `src/core/routes/internal.ts`：`GET /api/agent/report/alert/:symbol/:date`（publicRouter，按 user_id=symbol 查询当日 alert 报告，与通用 `/report/:intent/:date` 路径段数不同不会冲突）

---

## [master] 2026-08-01 — Stock Trace get/analysis/evidence 未登录降级修复

**开发者**: NanyuDeer

### 修复
- `src/modules/stock-trace/controller.ts`：`get`/`analysis`/`evidence`/`markRead` 接口移除 `if (!openid) return 401`，改为未登录降级（与 `list` 接口一致，符合"登录非必须"约束）。根因：未登录用户在 monitor 页面看到异动卡片（list 降级成功），但点击卡片进入溯源详情时 get/analysis 返回 401，导致前端 DEV 模式回退到 mock 数据
- `src/modules/stock-trace/StockTraceService.ts`：新增 `getRecentEvent(eventId)` 方法，不经过 `stock_trace_user_events` 关联表，直接查全局事件（返回格式与 `getUserEvent` 一致，`read_at` 固定 null）

---

## [master] 2026-08-01 — Stock Trace PRD 对齐：sendInitialPush 补齐 trigger_reason

**开发者**: NanyuDeer

### 改进
- `src/modules/stock-trace/StockTraceService.ts`：`sendInitialPush` 插入 `stock_trace_push_records` 时补齐 `trigger_reason='event_created'` 字段（PRD/SPEC 要求 initial push 记录触发原因，便于查询推送历史时区分触发来源）

---

## [master] 2026-08-01 — StockTraceService.ensureSchema 权限容错

**开发者**: Aria

### 修复
- `src/modules/stock-trace/StockTraceService.ts`：`ensureSchema` 的 `ALTER TABLE stocks ADD COLUMN list_date` 用 try/catch 包住 — aistock 用户无 stocks 表 owner 权限（owner=root）时跳过，不阻塞后续 `stock_trace_*` 表的创建；`schemaPromise` 失败时重置为 null，允许下次调用重试，避免进程启动时权限问题永久阻塞所有 stock-trace 链路

### 改进
- `.gitignore`：添加 `.worktrees/` 忽略规则

---

## [changer] 2026-07-31 — 个股异动 Trace 触发（StockTraceTriggerService + 交易日历补齐）

**开发者**: 37588

### 新增
- `src/modules/crawler/services/StockTraceTriggerService.ts`：个股 Trace 触发 relay，转发到 Python `POST /api/agent/trace/stock/trigger`（fail-closed：token/URL 未配置静默 skipped；90s 超时；绝不抛异常，不影响通知主流程）
- `scripts/export-historical-close-snapshots.ts`：历史收盘快照导出脚本（配合 2024/2025 交易日历）
- `src/modules/crawler/__tests__/stockTraceTrigger.spec.ts`：StockTraceTriggerService 单元测试

### 改进
- `src/modules/crawler/StockInfoPushService.ts`：通知完成后按 symbol 去重触发个股 Trace（倒序取每 symbol 首次 judgement，`traceId = stock-info:<judgementId>`）
- `src/shared/utils/TradingCalendarService.ts`：补齐 2024 / 2025 年 A 股休市日历（历史快照导出需要）

## [master] 2026-07-31 — 火山引擎 TTS 多账号轮换池
**开发者**: ARIA

### 新增
- `src/core/services/volcenginePodcast.service.ts`：新增 `readVolcenginePodcastAccounts()` 读取 `VOLC_PODCAST_ACCOUNTS` JSON 数组（兼容 app_id/access_token/secret_key 字段名）；新增 `VolcenginePodcastPool` 类实现 round-robin 轮换 + 失败自动切换下一个账号重试，全部失败才报错

### 修改
- `src/core/routes/internal.ts`：`synthesizeBroadcast` 改用账号池获取凭证，替代单账号固定读取

---

## [changer] 2026-07-30 — 新增 TencentSnapshotService + /market/quick-snapshot 路由
**开发者**: Aria

### 新增
- `src/modules/quote/MarketSnapshotService.ts`：扩展 `CloseMarketSnapshot` schema，新增 `MarketBreadth`、`QuickSnapshotCoverage` 接口和 `snapshot_kind` / `coverage_info` / `market_breadth` 可选字段；导出 `isAtOrAfterClose`
- `src/modules/quote/TencentSnapshotService.ts`：新增 `TencentSnapshotService`，15:30 收盘后基于腾讯实时行情构建简版收盘快照（6 大指数 + 全市场宽度 + 概念板块资金流），分级失败策略（指数严格、非核心宽松）
- `src/core/routes/internal.ts`：新增 `GET /internal/market/quick-snapshot` 路由，200/409/502 三种响应
- `tests/TencentSnapshotService.test.ts`：4 个单元测试覆盖正常构建、未收盘拒绝、降级策略、涨跌停计数
- `tests/internalRoutes.test.ts`：3 个路由测试覆盖 200/409/502

---

## [changer] 2026-07-30 — 新增 TencentSnapshotService + /market/quick-snapshot 路由
**开发者**: Aria

### 新增
- `src/modules/quote/MarketSnapshotService.ts`：扩展 `CloseMarketSnapshot` schema，新增 `MarketBreadth`、`QuickSnapshotCoverage` 接口和 `snapshot_kind` / `coverage_info` / `market_breadth` 可选字段；导出 `isAtOrAfterClose`
- `src/modules/quote/TencentSnapshotService.ts`：新增 `TencentSnapshotService`，15:30 收盘后基于腾讯实时行情构建简版收盘快照（6 大指数 + 全市场宽度 + 概念板块资金流），分级失败策略（指数严格、非核心宽松）
- `src/core/routes/internal.ts`：新增 `GET /internal/market/quick-snapshot` 路由，200/409/502 三种响应
- `tests/TencentSnapshotService.test.ts`：4 个单元测试覆盖正常构建、未收盘拒绝、降级策略、涨跌停计数
- `tests/internalRoutes.test.ts`：3 个路由测试覆盖 200/409/502

---

## [master] 2026-07-25 — 统一内部路由 token 读取优先级（INTERNAL_API_TOKEN || INTERNAL_TOKEN）
**开发者**: Aria

### 修复
- `src/index.ts`：6 处内部路由（push-leader / push-institution-research / push-stock-info / trigger-trend-batch / crawl/run / crawl/cycle）token 读取从 `INTERNAL_TOKEN` 改为 `INTERNAL_API_TOKEN || INTERNAL_TOKEN`，修复 `.env` 仅配置 `INTERNAL_API_TOKEN` 时 401 的问题
- `src/modules/auth/feishuMessageController.ts`：同上统一 token 优先级
- `src/modules/auth/feishuAuthController.ts`：同上统一 token 优先级
- `src/modules/monitor/windLeaderController.ts`：同上统一 token 优先级
- `src/modules/crawler/judgementController.ts`：修正 token 优先级顺序为 `INTERNAL_API_TOKEN || INTERNAL_TOKEN`（原为 `INTERNAL_TOKEN || INTERNAL_API_TOKEN`）

---

## [master] 2026-07-25 — 报告降级返回 + 趋势股评分表自动迁移修复
**开发者**: Aria

### 修复
- `src/core/routes/internal.ts`：周末/节假日 Agent 未生成报告时，公开路由 `/report/:intent/:date` 降级返回最近一份报告（新增 `getLatestAnalysisReport` 函数），避免前端所有报告页显示空状态
- `src/index.ts`：新增 `trend_scores` 表自动迁移（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS ma60_excluded`），服务重启自动补列，修复迁移 SQL 未执行导致评分数据全部丢失、API 500、trend_score 报告缺失的问题

### 新增
- `src/index.ts`：新增 `POST /api/internal/trigger-trend-batch` 管理接口，手动触发 `TrendBatchService.run()`，修复后可立即补数据无需等到 02:00

### 改进
- `AGENTS.md`：更新定时任务表格，新增趋势股自动迁移说明，调整趋势股批量评分为 02:00
- `src/core/routes/internal.ts`：`getAnalysisReport` 的 `created_at` 改用 `AT TIME ZONE 'UTC'` 返回真 UTC 时间，与前端 `formatDateTime` 配合正确显示

---

## [changer] 2026-07-21 — 收盘快照门禁：交易日历 fail-closed + 时钟边界 + 数据完整性

**开发者**: 37588

### 新增
- `src/modules/quote/MarketSnapshotService.ts`：当日 A 股大盘收盘事实聚合服务，六指数 + 全市场宽度 + 成交额 + 涨跌停 + 板块 + 主力资金
- `src/shared/utils/TradingCalendarService.ts`：A 股交易日历服务，基于周末规则 + 年度休市日历，未覆盖年度 fail-closed
- `tests/MarketSnapshotService.test.ts`：18 项测试覆盖分页、重复页拒绝、金额单位、节假日拒绝、15:29/15:30 边界、数据延迟

### 修复
- `src/modules/quote/TushareService.ts`：新增 `getCompleteDailyByDate` 分页去重抓取，重复页/页数上限立即失败
- `src/core/routes/internal.ts`：新增 `GET /internal/market/close-snapshot` 内部接口（鉴权 + 200/409/502）
- `tests/internalRoutes.test.ts`：路由时钟由 `__marketSnapshotDependencies.now` 驱动，15:29 拒绝/15:30 成功

### 改进
- 收盘门禁三重校验：交易日历 → 15:30 时钟 → SH 指数数据到位，任一不通过拒绝
- 节假日拒绝（周末/劳动节/国庆/跨年）在行情调用前完成，零 Tushare 调用

---

## [master] 2026-07-20 — 后端线：全行业覆盖 + 60日均线剔除 + 合并十倍股 + push历史修复
**开发者**: Aria

### 新增
- `src/modules/monitor/ma60Excluded.ts`：纯函数 `calcMa60Excluded(closes)` — 连续两日收盘价在60日均线下方→剔除
- `tests/TrendScoreMa60Excluded.test.ts`：7 项单元测试（TDD，全通过）
- `src/modules/push/__tests__/controller.spec.ts`：push 历史回归测试覆盖字符串→number、return_pct 计算、null 容错
- `sql/trend_scores_ma60.sql`：ALTER TABLE 加 ma60_excluded 列迁移
- `docs/sql/drop_tenx_scores.sql`：DROP tenx_scores 表运维 SQL
- `tenx-cleanup-roadmap.md`：十倍股清理后续修改建议文档

### 修复
- `src/modules/push/controller.ts`：PostgreSQL NUMERIC 列返回字符串导致前端 `.toFixed()` 崩溃；导出 `toFiniteNumber`，`withReturn` 增加 number 归一化

### 改进
- `src/modules/monitor/WindLeaderAnalyzerService.ts`：`identifyHotConcepts` 不再筛选 AI 相关板块，直接使用全部板块；删除 AI_RELATED_KEYWORDS 等死代码（150行）
- `src/modules/monitor/TrendScoreService.ts`：`calcTechnicalDim` 计算并返回 `ma60Excluded`，`TrendScoreResult` 接口新增字段
- `src/modules/monitor/trendScoreController.ts` + `TrendBatchService.ts`：saveToDB 持久化 `ma60_excluded` 列；getTopStocks 过滤 `ma60_excluded = false`
- `src/core/routes/internal.ts`：移除 tenx 路由 + TenxScoreService import；`/internal/trend/top` 过滤 ma60_excluded
- `sql/trend_scores.sql`：基础建表 SQL 包含 `ma60_excluded` 列
- `tests/internalRoutes.test.ts`：移除所有 tenx 测试用例
- `AGENTS.md`、`src/modules/monitor/AGENTS.md`、`src/modules/quote/AGENTS.md`：tenx→趋势股评分，新增60日均线剔除说明

### 重构
- 删除 `src/modules/monitor/tenxScoreController.ts`、`src/modules/monitor/TenxBatchService.ts`：tenx-score 独立模块下线
- `src/index.ts`：移除 tenx 公开路由（batch/rebuild/per-symbol 6条/top）+ import + 注释 cron
- **保留 `TenxScoreService.ts`**：含 11 个共享计算函数被 TrendScoreService 依赖

### 合并
- `agent/fix-push-history-date-sources`：推送历史日期源规范化（新增 pushHistoryDates.ts）
- `tieny`：fix(hot-burst) 历史兜底查询同步适配时间窗口

---

## [changer] 2026-07-18 — Morning trigger 鉴权统一 + agent.proxy 阻断 trigger 路径
**开发者**: 37588

### 修复
- `src/index.ts`：引用生产 handler 模块，删除内联实现；手动 morning trigger 鉴权统一为 `INTERNAL_API_TOKEN || INTERNAL_TOKEN`；转发正确 token 给 Python；透传事件统计字段
- `src/modules/agent/agent.proxy.ts`：循环 `decodeURIComponent`+规范化后用正则 `^/briefing/[^/]+/trigger(/.*)?$` 阻断 trigger 路径；解码失败 fail closed（默认 token 不作为有效凭据）；拒绝 briefing trigger 路径通过公开代理访问
- `src/core/routes/morning_trigger_handler.ts`（新增）：抽成可测试模块：检查 response.ok、安全处理非 JSON、fail closed（默认 token 不作为有效凭据）、透传 event_persisted_count/persist_failed_count

### 测试
- `src/modules/agent/__tests__/agent.proxy.spec.ts`：新增 trigger 路径拒绝测试（morning/event trigger 不可通过代理）+ 编码绕过用例
- `src/core/routes/__tests__/morning_trigger_handler.spec.ts`（新增）：使用真实 HTTP 上游 mock 测试：Token 优先级、透传、403/500、非 JSON、连接失败、fail closed

---

## [master] 2026-07-17 — 跨仓库一致性修复（端口/测试/缓存/文档）
**开发者**: Aria

### 修复
- `src/index.ts`：`AGENT_PY_URL` 默认端口 `8000`→`8080`（与 aistock-agent-py 实际端口对齐，原默认值导致 env 缺失时反代到错误端口）
- `package.json`：`test` glob 补充 `"tests/**/*.test.ts"`（原仅匹配 `src/**/__tests__/**/*.spec.ts`，漏掉 `tests/` 下 11 个测试文件）

### 改进
- `.gitignore`：新增 `data/kg-cache/`、`src/data/kg-cache/` 忽略规则，取消跟踪 14 个知识图谱运行时缓存文件（服务启动自动生成）
- `AGENTS.md`：同步修正 `AGENT_PY_URL` 默认端口文档（第 7.4 节 8000→8080）

---

## [changer] 2026-07-16 — 报告内容清洗 + review 检查脚本
**开发者**: 37588

### 改进
- `src/core/routes/internal.ts`：新增 `cleanReportContent()` 函数，清洗报告中给机器解析用的 HTML 注释标记（`<!--SECTOR_LIST_START-->` 等），避免污染用户界面（同时清洗 `text` 和 `display_report.details` 字段）

### 新增
- `scripts/check-details.js`、`scripts/check-report.js`、`scripts/insert-review.js`：review 数据检查和插入脚本

---

## [master] 2026-07-15 — 预筛选条件优化(成交额4000万+板块上榜≥3) + stk_surv接口修复
**开发者**: Aria

### 优化
- `src/modules/monitor/TrendBatchService.ts`：20日日均成交额阈值从 3000 万提高到 4000 万（与 vetoCheck 同步）
- `src/modules/monitor/TrendBatchService.ts`：板块 60 日上榜次数从 ≥2 提高到 ≥3
- `src/modules/monitor/TenxScoreService.ts`：`AVG_AMOUNT_THRESHOLD` 从 300000 提高到 400000 千元（4000 万），错误提示文案同步更新

### 修复
- `src/modules/quote/TushareService.ts`：机构调研接口名 `stk_survival` → `stk_surv`（Tushare 官方正确名称）

---

## [master] 2026-07-15 — 预筛选增加板块轮动过滤 + 进度日志增强
**开发者**: Aria

### 优化
- `src/modules/monitor/TrendBatchService.ts`：预筛选增加板块轮动过滤，用 `getBestBoardForStock()` 检查股票是否属于 60 日上榜板块（上榜次数 ≥ 2），零额外 API 调用，预计候选股从 981 降到 ~300-400 只
- `src/modules/monitor/TrendBatchService.ts`：进度日志从每 50 只改为每 10 只，增加单只股票评分成功日志（含分数/标签/板块/上榜次数），增加预计剩余时间
- `src/modules/monitor/TrendBatchService.ts`：预筛选日志增加板块缓存覆盖统计和"不在上榜板块"排除数量

---

## [master] 2026-07-15 — 预筛选对齐 vetoCheck + skipVeto 跳过重复否决
**开发者**: Aria

### 修复
- `src/modules/monitor/TrendBatchService.ts`：预筛选成交额从单日改为 20 日日均（拉取近 30 天 daily 数据聚合计算），与 vetoCheck 的 `AVG_AMOUNT_THRESHOLD`（300000 千元 = 3000 万）完全对齐
- `src/modules/monitor/TrendBatchService.ts`：ST 排除改用 `stock_basic` 接口批量获取全市场股票名称（含 'ST'/'\*ST'），修复 daily_basic bulk 查询不返回 is_st 字段的问题
- `src/modules/monitor/TrendBatchService.ts`：run() 传 `skipVeto=true`，预筛选已用相同标准过滤，无需在 calculateTrendScore 内部重复调用 vetoCheck（省 2 次 API/股）
- `src/modules/quote/TushareService.ts`：新增 `getStockBasicBulk()` 函数，批量获取全市场股票基本信息

---

## [master] 2026-07-15 — 两阶段批量评分优化 + 手动触发接口 + App微信登录接口
**开发者**: Aria

### 重构
- `src/modules/monitor/TrendBatchService.ts`：新增 `prefilterStocks()` 方法，用 bulk 接口一次性拉取全市场 daily_basic + daily 数据，在内存中快速筛选（非ST + 成交额>3000万 + 价格>2元 + 换手率>0.3% + 60日跌幅<10%），从 5000+ 股票筛至 ~300-800 只候选股
- `src/modules/monitor/TrendBatchService.ts`：`run()` 改为两阶段流程，阶段1预筛选 → 阶段2仅对候选股跑完整评分，预计从 5+ 小时降到 30-60 分钟
- `src/modules/monitor/TrendBatchService.ts`：已评分股票改为批量查询（`symbol = ANY($2)`）而非逐股查询，减少 DB 往返
- `src/modules/quote/TushareService.ts`：`DailyBasicFullRow` 新增 `is_st` 字段，`getDailyBasicByDate` 请求字段增加 `is_st`

### 新增
- `src/modules/monitor/trendScoreController.ts`：新增 `triggerBatch` 方法，支持 async/sync 两种模式和 force 参数
- `src/index.ts`：注册 `POST/GET /api/cn/stocks/trend-score/trigger-batch` 路由
- `src/modules/auth/controller.ts`：新增 `appWxLogin` 接口，App 端微信登录（uni.login code → 换取用户信息 → 签发 JWT）
- `src/modules/auth/scanLoginController.ts`：扫码登录增强（HTTP 状态码检查、空响应校验、try-catch 错误处理）

---

## [changer] 2026-07-15 — event/list 去重修复
**开发者**: 37588

### 修复
- `src/core/routes/internal.ts`：`GET /api/agent/event/list` 使用 `DISTINCT ON (user_id)` 去重（同一 eventId 只保留最新一条），COUNT 改为 `COUNT(DISTINCT user_id)` 避免分页计数偏差

### 测试
- `src/core/routes/__tests__/event_conduction.spec.ts`：新增去重测试用例（同一 eventId 多条记录场景）

---

## [master] 2026-07-15 — 统一最佳概念板块选择,逐板统计轮动上榜次数选最多
**开发者**: NanyuDeer

### 重构
- `src/modules/monitor/TrendScoreService.ts`：新增 `findBestConceptBoard` 函数，对股票所属每个 THS 概念板块独立统计 60 日轮动上榜次数，选上榜最多的单一板块统一用于概念 K 线 / sectorStrength / sectorName / weeklyListingTrend / sectorListCount60d
- `src/modules/monitor/TrendScoreService.ts`：`calcTrackDim` 新增 `bestBoard` 参数，移除原 ths_member 反查 + 多板块累加匹配逻辑，bestBoard 为空时回退到 sectorStats 行业/概念名匹配
- `src/modules/monitor/TrendScoreService.ts`：主函数概念 K 线获取改用最佳板块 ts_code 直接拉取 getThsDaily，无数据时回退行业名精确/模糊匹配

---

## [master] 2026-07-14 — 趋势股评分赛道维度数据源增强
**开发者**: NanyuDeer

### 改进
- `src/modules/monitor/TrendScoreService.ts`：weeklyListingTrend 复用板块轮动 rawData 真实周度上榜次数（替换占位 generateWeeklyTrend）
- `src/modules/monitor/TrendScoreService.ts`：sectorStrength 复用概念指数K线计算板块月涨幅（替换占位 '--'）
- `src/modules/monitor/TrendScoreService.ts`：policyItems 复用财联社新闻关键词提取政策/产业趋势项（替换占位硬编码）
## [changer] 2026-07-14 — Event Conduction 报告公开接口 + analysis_reports event_id 隔离
**开发者**: 37588

### 新增
- `src/core/routes/internal.ts`：新增 `GET /api/agent/event/list`（公开，分页列表，返回 eventId/title/source/publishTime/摘要/结论）和 `GET /api/agent/event/:eventId`（公开，详情，返回完整 analysis_reports 四模块 + event_podcast_brief）
- `src/core/routes/internal.ts`：POST analysis-reports 新增 event_conduction 报告类型校验（必填 event_id，复用 user_id 列做隔离键）

### 改进
- `src/core/routes/internal.ts`：VALID_REPORT_TYPES 白名单新增 event_conduction
- `src/shared/utils/CacheService.ts`：setInterval 添加 `.unref()`，确保测试环境/进程关闭时定时器不阻止退出

### 文档
- `README.md`：API 路由表新增 `/api/agent/event/list` 和 `/api/agent/event/:eventId`；analysis-reports 接口文档补充 event_id 说明和 event_conduction 类型

---

## [master] 2026-07-10 — Agent 报告持久化基础设施 + AGENTS.md 文档
**开发者**: Aria

### 新增
- `AGENTS.md`：面向 AI 开发助手的入口地图（模块架构地图、开发规范、硬约束、降级策略、跨服务协作契约）
- `docs/sql/agent_analysis_reports.sql`：Agent 分析报告持久化建表脚本（JSONB content + COALESCE 唯一索引解决 NULL user_id）
- `src/core/routes/internal.ts`：新增 `/internal/analysis-reports/*` 4 个端点（POST upsert / GET 按类型+日期查询 / GET 用户专属查询 / DELETE 过期清理）
- `src/index.ts`：新增 ReportCleanupCron（每日 03:00 清理 expires_at 过期的报告）

### 文档
- `README.md`：顶部添加 AGENTS.md 引用说明；精简开发规范部分（改为引用 AGENTS.md）；补充 Internal API 表格中遗漏的 `/internal/analysis-reports/*` 系列接口

---

## [master] 2026-07-10 — 重构知识图谱数据源：AiGraphService改用IndustryKGService
**开发者**: Aria

### 重构
- `src/modules/monitor/AiGraphService.ts`：数据源从 AiGraphExcelSource 改为 IndustryKGService，直接读取完整的行业/概念/上下游关系数据
- `src/modules/monitor/aiGraphController.ts`：删除 switchDataSource 接口和 DataSourceType 引用
- `src/index.ts`：初始化顺序调整，IndustryKGService 先初始化，AiGraphService 后初始化

### 删除
- `src/modules/monitor/AiGraphDataSource.ts`：数据源接口和工厂（不再需要）
- `src/modules/monitor/AiGraphExcelSource.ts`：Excel 数据源（无 Excel 文件，已废弃）

---

## [changer] 2026-07-06 — 新增 /internal/news/latest 接口（支撑 agent-py 晨报工具）
**开发者**: changer-collab

### 新增
- `src/modules/monitor/ClsStockNewsService.ts`：抽取私有 `fetchAndParseNews(keyword, stockName, limit, lastTime)`，新增 `getLatestNews(limit=10)` 静态方法（`keyword=''` 触发全量财联社快讯流）
- `src/core/routes/internal.ts`：新增 `GET /internal/news/latest` 路由，`limit` 默认 10、上限 50，复用 `verifyInternalToken` 鉴权

### 验证
- `npx tsc --noEmit`：无类型错误
- `curl /internal/news/latest?limit=3`：200 OK，返回 3 条真实财联社快讯
- Python agent-py 端到端：`get_cls_news.ainvoke({"limit": 3})` 正确返回格式化快讯

---

## [changer] 2026-07-06 — 修复 internal.ts token 不一致导致 agent-py 调用 403
**开发者**: changer-collab

### Bug 修复
- **根因**：`src/core/routes/internal.ts:20` 只读 `INTERNAL_TOKEN`，但项目实际用 `INTERNAL_API_TOKEN`；fallback 又与其他 8 处 token 校验点不一致（`change-me-in-production` vs `crawler-int-2026-token`），导致 Python agent-py 调 `/internal/*` 全部 403
- **修复**：`internal.ts` 改为优先读 `INTERNAL_API_TOKEN`，兼容 `INTERNAL_TOKEN`，与 `judgementController.ts:7` 对齐
- **.env**：新增 `INTERNAL_TOKEN=crawler-int-2026-token`（保留给 index.ts/feishu/crawler/windLeader 等 8 处旧模块），`INTERNAL_API_TOKEN` 改为 Python agent-py 用的值
- **零副作用**：其他 8 处 token 校验点行为不变（judgementController 因 `||` 短路优先 INTERNAL_TOKEN，也不受影响）

### 验证
- 4 个 `/internal/*` 接口直连测试全部 200 OK，返回真实数据（茅台现价 1194.45、46 家机构预测、58 条新闻）
- Python agent-py 调用 4 个工具无 `node_api_http_error`，token 修复成功

### 已知遗留问题（不在本次修复范围）
- agent-py 的 stock_analyst 工具调用成功但 LLM 输出仍称"数据暂不可用"，疑似 prompt 或 graph state 传递问题，需单独排查

---

## [changer] 2026-07-05 — 移除冗余 AGENTS.md，加入 .gitignore
**开发者**: changer-collab

### 文档
- 删除 repo 根级 AGENTS.md（与 README.md 内容重叠 80%+，维护两份易漂移）
- .gitignore 新增 AGENTS.md 忽略项
- 跨仓库约定（git 分支策略等）改由项目根 AGENTS.md 和 project_memory.md 承载（不在 git 仓库内）

---

## [main] 2026-07-02 — 项目模块化重组
**开发者**: 尹辰

### 重构
- 全项目从扁平结构重组为 shared/ + core/ + modules/ 三层架构
- 新增 6 个业务模块目录（quote/agent/push/auth/monitor/crawler）
- 新增 shared/ 共享层 + core/ 基础设施层
- 新增各模块 AGENTS.md
- 新增 README.md

---
