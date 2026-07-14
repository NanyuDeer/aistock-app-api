# Changelog — aistock-app-api

> 所有修改记录按时间倒序排列。每条记录标注分支、时间区间、开发者。

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
