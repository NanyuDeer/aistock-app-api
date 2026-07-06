# Changelog — aistock-app-api

> 所有修改记录按时间倒序排列。每条记录标注分支、时间区间、开发者。

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
