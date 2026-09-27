# 完整洞察报告：PDF 下载 → 页面流式输出（设计）

- 日期：2026-09-25
- 涉及仓库：aistock-agent-py、aistock-app-api、aistock-app-frontend
- 分支：junliang（本地未提交）
- 状态：设计已获用户批准，进入实施

## 1. 背景与目标

现有「完整洞察报告」为 **PDF 下载**形态（详情页按钮 + 自选股异动页卡片「报告 ›」），链路为
`app-api 组装数据 → agent-py reportlab 渲染 → 前端 blob 下载`。实际使用中反馈不好：
PDF 仅在移动端外部阅读器打开、无法在页面内直接阅读、且每次都要下载文件。

目标：

- **改为页面内流式输出**：详情页点「生成完整洞察报告」，在**按钮下方**逐章节呈现完整报告。
- **彻底移除 PDF 链路**（前端下载工具、app-api 端点与渲染调用、agent-py reportlab 渲染与内嵌字体 2.33MB）。
- 报告**内容与现有 PDF 完全一致**（事件事实 / 主因结论 / 分层候选 / 六阶段因果链 / 证据清单 / 未解问题，
  含既有的中文化与时间格式化规则）。

## 2. 决策记录（已与用户确认）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 报告内容来源 | **保持模板渲染**（无 LLM）。不引入 LLM 生成，避免成本、延迟与内容失真 |
| 2 | PDF 链路 | **彻底移除**（含前端工具、app-api 端点、agent-py 渲染器与字体文件） |
| 3 | 端侧范围 | **只做 H5**（`EventSource`）。App/小程序端不做（项目既有约束：App 端推荐 WS，非 SSE） |
| 4 | 生成方 | **方案 C**：agent-py 返回结构化 `sections` JSON（复用全部 Python 逻辑），app-api 负责分块推 SSE |
| 5 | 自选股异动页入口 | 卡片「报告 ›」改为**跳详情页 + `?autostart=1`**，由详情页自动开始生成 |
| 6 | 呈现节奏 | app-api 每节之间约 **80ms** 延迟，使"流式"有可感知的渐次展开效果 |
| 7 | SSE 错误传递 | 端点**始终返回 200**，错误放进 `data: {"type":"error","code":...}`（EventSource 读不到 HTTP 错误体） |

## 3. 架构与数据流

```
H5 洞察详情页
  └─ 点击「生成完整洞察报告」
      └─ EventSource GET /api/cn/favorites/movements/:eventId/report/stream   [app-api]
           ├─ JWT 鉴权（复用 authFromRequest）
           ├─ 自选归属校验（复用 StockTraceService.getUserEvent；无归属 → error 404）
           ├─ 组装报告数据（复用 InsightReportService.buildReportData）
           ├─ 无有效归因（无 artifact）→ error 409
           ├─ POST {AGENT_PY_URL}/api/agent/insight-report/sections（X-Internal-Token）
           │     → { header, sections: [{heading, lines}] }
           ├─ send start → send section × N（每节间 80ms）→ send done
           └─ 15s 心跳 `: keep-alive`
  [agent-py] POST /api/agent/insight-report/sections
      └─ build_report_header + build_report_sections（纯函数，复用；无 reportlab、无字体）
```

- 报告**不落盘、不缓存**（模板渲染毫秒级，无成本）。
- app-api 调 agent-py 超时 10s（沿用现值）；失败 → `event: error {code:502}`。

## 4. 接口契约

### 4.1 agent-py：`POST /api/agent/insight-report/sections`

- 鉴权：`X-Internal-Token`（复用 `verify_internal_token`）
- 请求体：与现 `render` 端点相同的报告数据 JSON（`{event, attribution}`）
- 响应：`application/json`
  ```json
  { "header": "海正生材（688203） · 2026-09-24",
    "sections": [ { "heading": "事件事实", "lines": ["股票：…", "触发时间：…"] } ] }
  ```
- 说明：`lines` 已是**中文化 + 时间格式化 + 枚举翻译后**的最终展示文本。

### 4.2 app-api：`GET /api/cn/favorites/movements/:eventId/report/stream`

- 响应头：`Content-Type: text/event-stream;charset=UTF-8`、`Cache-Control: no-cache, no-transform`、
  `Connection: keep-alive`、`X-Accel-Buffering: no`，随后 `flushHeaders()`
- 事件序列（**不写 `event:` 行**，type 内嵌在 data —— 与现有 `useAlertSSE` 同构，前端只需 `eventSource.onmessage` 一个入口）：
  ```
  data: {"type":"start","header":"海正生材（688203） · 2026-09-24","total":6}
  data: {"type":"section","index":0,"heading":"事件事实","lines":["股票：…","触发时间：…"]}
  data: {"type":"section","index":1,"heading":"主因结论","lines":[…]}
  data: {"type":"done","message":"success"}
  ```
- 错误（仍以 HTTP 200 返回）：
  ```
  data: {"type":"error","code":401,"message":"请先登录查看"}
  data: {"type":"error","code":404,"message":"该异动不在你的自选范围内，或已过期"}
  data: {"type":"error","code":409,"message":"该异动暂无完整归因"}
  data: {"type":"error","code":502,"message":"报告生成失败，请重试"}
  ```
- 心跳：每 15s 写 `: keep-alive\n\n`（沿用 `analysisController` 做法）。

### 4.3 前端 `useInsightReportSSE`

- 仿 `modules/market/utils/useAlertSSE.ts`：`EventSource` + 事件分发 + 60s 超时 + `stop()`。
- 暴露：`header`、`sections`（数组，逐条追加）、`loading`、`error`、`done`、`start(eventId)`、`stop()`。

## 5. UI 形态

```
[ 生成完整洞察报告 ]            ← 生成中→「生成中…」，可点击停止；完成后→「重新生成」
────────────────────────
海正生材（688203） · 2026-09-24        ← start 事件
事件事实                              ← section 事件逐条追加
  股票：海正生材（688203）
  触发时间：2026-09-24 09:36
主因结论
  …
```

- 未生成：按钮下方无内容。
- 生成中：已到达章节 + 末尾「生成中…」。
- 出错：按钮下方显示错误文案（如「该异动暂无完整归因」）。
- 样式沿用 `variables.scss` token（禁止硬编码颜色/字号）。

## 6. 三仓改动清单

### 6.1 aistock-agent-py

新增：
- `api/routes.py`：`POST /api/agent/insight-report/sections`
- `services/insight_report.py`：`build_report_response(data) -> dict`（`{header, sections}`，薄封装）

删除：
- `api/routes.py`：`POST /api/agent/insight-report/render`
- `services/insight_report.py`：`render_insight_report()`、reportlab 相关 import（`colors/A4/ParagraphStyle/mm/pdfmetrics/TTFont/Paragraph/SimpleDocTemplate/Spacer/BytesIO`）、`_register_font`、`_FONT`、`_FONT_FILE`、`_DISCLAIMER`、`_escape`（仅 PDF 用）。**保留** `_CN_TZ`（`_time_text` 仍依赖）
- `src/aistock_agent/assets/fonts/NotoSansSC-Regular-Subset.ttf`（2.33MB）及 `assets/`（若无其他内容）
- `pyproject.toml`：`package-data` 中的 `assets/fonts/*.ttf`
- `tests/unit/test_insight_report.py`：PDF 渲染相关用例（`/FontFile2` 嵌入、`STSong-Light` 不存在、内嵌字体、`render_insight_report` 调用等）

保留（复用）：
- `build_report_header`、`build_report_sections`、全部中文化映射与 `_localize`、`_label`、`_time_text`、`_evidence_ids`、`_text`、`_escape`（若 `_escape` 仅 PDF 用则删）

### 6.2 aistock-app-api

新增：
- `StockTraceController.reportStream`（SSE）与路由 `GET /api/cn/favorites/movements/:eventId/report/stream`
- `InsightReportService.fetchSections(data)`（调 agent-py 新端点，返回 `{header, sections}`）

删除：
- `StockTraceController.report`（`report.pdf`）与其路由
- `InsightReportService.renderPdf`
- `__tests__/insightReport.spec.ts` 中 PDF 透传相关用例

保留：
- `InsightReportService.buildReportData`（数据组装不变）
- `StockTraceService.getUserEvent` 的 `trading_date::text`（页眉交易日依赖）

### 6.3 aistock-app-frontend

新增：
- `src/modules/favorites/utils/useInsightReportSSE.ts`（+ spec）

修改：
- `pages/insight-detail-move.vue`：按钮文案改「生成完整洞察报告」；按钮下方新增报告展示区（页眉 + 章节列表）；`onLoad` 支持 `?autostart=1`；`onUnload` 调 `stop()`；移除 `downloadInsightReport` 引用
- `pages/monitor.vue`：卡片「报告 ›」改为 `navigateTo(详情页?event_id=…&autostart=1)`；移除报告下载逻辑
- `shared/api/modules/stockTrace.ts`：`reportUrl()` → 改为 `reportStreamUrl(eventId)`（SSE URL，不走 request 拦截器）

删除：
- `src/shared/utils/downloadInsightReport.ts`

## 7. 错误处理与边界

| 场景 | 行为 |
|------|------|
| 未登录 | `event: error {code:401}` → 前端提示「请先登录查看」 |
| 事件不存在/非自选 | `{code:404}` → 「该异动不在你的自选范围内，或已过期」 |
| 无完整归因（无 artifact） | `{code:409}` → 「该异动暂无完整归因」 |
| agent-py 不可用/超时/返回非 JSON | `{code:502}` → 「报告生成失败，请重试」 |
| 前端 60s 无 done | 关闭连接并提示「请求超时，请稍后重试」 |
| 重复点击 | 生成中禁用（或先 `stop()` 再重启）；完成后按钮变「重新生成」 |
| 离开页面 | `onUnload` → `stop()` 关闭 EventSource |
| 字段缺失 | 沿用「暂缺」；`sections` 为空数组时前端显示「本次归因未产出完整报告」 |

## 8. 测试与验收

- **agent-py**：`test_insight_report.py` 调整为「章节构建 + 中文化」用例集（保留现有 15 例，删除 PDF 渲染 8 例）；新增 `build_report_response` 结构用例（`{header, sections}`、缺失字段不抛错）。
- **app-api**：新增 SSE 用例——未登录/无归属/无归因分别走 `event: error` 且 HTTP 200；成功路径事件序列 `start → section×N → done`；多处 `write` 证明**未缓冲**；agent-py 失败 → `error 502`。
- **app-frontend**：`useInsightReportSSE.spec.ts`（事件分发 / 逐条追加 / done / error / 超时 / stop）；详情页 mount 用例（点击按钮 → 章节渐次出现 → 页眉正确）。
- **端到端（H5）**：隧道 + app-api + agent-py + H5 5173 → 详情页点按钮 → 按钮下方逐章节展开 → 内容与现 PDF 一致（含中文化、时间格式、证据清单）。
- 回归：`npx vue-tsc --noEmit`、app-api `npx tsc --noEmit`、agent-py `ruff` + `pytest`、相关 node:test/vitest 全绿。

## 9. 风险与回滚

| 风险 | 说明 | 缓解 |
|------|------|------|
| App/小程序端 | 流式未实现，按钮在 App 端无效 | 前端按平台条件编译：非 H5 显示"请在 H5 查看完整报告"提示；后续按需补 WS |
| agent-py 不可用 | 报告整体不可用（与现状 PDF 相同） | `error 502` + 前端重试提示；不改鉴权与归属校验的位置 |
| EventSource 读不到 HTTP 错误 | 无法用状态码传递错误 | 端点始终 200，错误走 `event: error`（见 §4.2） |
| 80ms 节奏被视为"人为拖慢" | 数据本就毫秒可得 | 延迟集中在 app-api 一处常量，可一键调 0 |
| 删除字体文件后 PDF 能力彻底消失 | 不可回滚到 PDF | 若需回滚，从 git 历史恢复 `insight_report.py` + 字体文件；本设计保留 `build_report_sections` 等纯函数，渲染层可重建 |

## 10. 实施顺序

1. agent-py：新增 `sections` 端点 + `build_report_response`；删除 PDF 渲染/字体/路由；调整测试
2. app-api：新增 SSE 端点 + `fetchSections`；删除 `report.pdf` 与 `renderPdf`；调整测试
3. app-frontend：`useInsightReportSSE` + 详情页改造 + monitor 入口改造 + 删除下载工具；补测试
4. 端到端 H5 实测 + 文档同步（各仓 AGENTS.md / changelog-pending.md / project_memory）

## 11. 演进：章节内容由 `lines` 改为结构化 `blocks`（2026-09-26）

本设计文档 §4/§5 描述的 `sections:[{heading, lines}]`（纯文本行）**已于 2026-09-26 被结构化 `blocks` 取代**。
触发原因：用户验收后反馈"完整报告排版不美观"（六节同字号长文本、无层级），并询问"六阶段因果链能否用表格或流程图"——
**纯文本行无法承载节点卡/表格**，因此需要把"渲染成什么形状"的决定权从字符串格式交还给结构化数据。

| 项 | 本文档原设计（§4/§5） | 实际（2026-09-26 起） | 原因 |
|---|---|---|---|
| 章节内容 | `lines: string[]`（预格式化文本行） | **`blocks: Block[]`**（判别联合 6 类：`kv`/`verdict`/`candidates`/`chain`/`evidence`/`list`） | 文本行无法表达"这是键值对 / 表格 / 时间轴节点" |
| 空节 | `lines: ['暂缺']` | **`blocks: []`**（前端渲染"暂缺"） | 空占位由展示层决定，数据层不必造占位文本 |
| 因果链 | 两条链的节点平铺成 `lines` | **`chain.stages`，只含 `role=primary` 主链** | 真实 artifact 通常是 primary + alternative 各 6 节点；平铺会把 12 个节点混在一起、无分界（实测 6 条线上数据） |
| 枚举 | 直接给中文标签 | **中文标签 + 机器 key**（`stageKey`/`epistemicKey`/`statusKey`） | 前端做"中性弱化"需按状态判定，**不应匹配中文标签字符串** |
| SSE 契约 | `{"type":"section", index, heading, lines}` | `{"type":"section", index, heading, blocks}` | 同上；§7 错误处理、§8 测试、§9 风险均不变 |

**未变的部分**：SSE 通道与分帧协议、80ms 节间节奏、前置校验在开流前完成（真实状态码）、`fetch + ReadableStream` 消费、
agent-py 纯模板构建（无 LLM）、`_localize` 中文化映射、`buildReportData` 的字段组装与主因三级兜底（仍在 app-api）。

**前端呈现**：新增 `modules/favorites/components/InsightReportBody.vue` 按 `block.type` 分派；六阶段因果链采用**纵向时间轴**
（序号圆点 + 竖向连接线 + 节点卡；`statusKey !== 'established'` 走中性灰阶弱化，不用告警色）。其余五节的"精修排版"待用户确认因果链效果后另行推进。

## 12. 演进：补齐 App 端流式通道（双通道 + 运行时能力探测，2026-09-26）

本设计的 §2 决策 3「端侧范围只做 H5」、§4.3（`EventSource` 消费）、§7（`EventSource` 读不到 HTTP 错误体）、
§9 风险表首行（「App/小程序端流式未实现，按钮在 App 端无效」）**已于 2026-09-26 被双通道方案取代**。
触发原因：移除 PDF 链路后改动**只覆盖 H5**，而项目既有硬约束写着「WebView may not support ReadableStream」——
App 端走 `fetch + ReadableStream` 大概率跑不通，报告在 App 端根本打不开。

| 项 | 本文档原设计 | 实际（2026-09-26 起） | 原因 |
|---|---|---|---|
| 端侧范围 | 只做 H5，App/小程序不做（§2 决策 3） | **双通道**：H5 走 `fetch + ReadableStream`；App/小程序走 `uni.request({ enableChunked: true }) + requestTask.onChunkReceived` | `ReadableStream` 在 App WebView 不保证可用；uni-app 原生分块传输可设 `header`，鉴权不受限 |
| 通道选择 | —（未涉及） | **运行时能力探测 `pickReportStreamChannel()`**，不用条件编译 `#ifdef` | 条件编译在 vitest 下不会被裁剪，两条分支会同时执行，无法为两端分别写测试 |
| 消费方式 | `EventSource`（§4.3「仿 `useAlertSSE`」） | `fetch + ReadableStream`（H5）/ `uni.request` 分块（App） | `EventSource` 无法设置 `Authorization` 头，而本端点需 JWT（`useAlertSSE` 能这么写是因为其端点不校验登录，属特例） |
| 错误传递 | 端点**始终 200**，错误走 `data: {"type":"error"}`（§2 决策 7、§7、§9） | 前置校验（401/404/409/502）在 `flushHeaders()` **之前**用**真实状态码 + JSON** 返回；仅开流后异常走 `data: {"type":"error"}` 兜底 | 前端改用 `fetch`/`uni.request` 后能直接读状态码（只有 `EventSource` 读不到错误体） |
| 共享逻辑 | —（未涉及） | 纯函数 `createReportStreamDecoder(handle)`：`data: {...}\n\n` 分帧、`TextDecoder({stream:true})` 跨块续解、半帧缓存、累计 `rawText` | 两条通道分帧必须一致，抽出纯函数才能单测 |
| 取消 | `stop()` 关 `EventSource`（§4.3） | `setCancel(cb)` 回调统一：`AbortController.abort`（fetch）/ `requestTask.abort`（chunked）；另加 `active` 标志阻断 `stop()` 后迟到响应改写状态 | 两种通道的中止 API 不同，调用方不应感知 |

**未变的部分**：`{heading, blocks}` 章节契约、SSE 分帧协议、80ms 节间节奏、前置校验在开流前完成、
agent-py 纯模板构建、前端 `InsightReportBody.vue` 的 6 类 block 分派。

**验证边界**：App 端 chunked 通道在 H5 上跑不到，由 `useInsightReportSSE.spec.ts`（25 例，含 App 通道集成）锁定；
本机无 App 运行环境，**未经真机/模拟器实测**，需真机自验。H5 侧已回归实测通过（6 节 / 6 节点 / 无错误）。
