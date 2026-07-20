# Changelog — aistock-app-api

> 所有修改记录按时间倒序排列。每条记录标注分支、时间区间、开发者。

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
