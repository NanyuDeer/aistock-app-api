# 洞察详情页精简 + 取消预判 + 完整洞察报告 PDF（设计）

- 日期：2026-09-13
- 分支：junliang（三仓）
- 涉及仓库：aistock-app-frontend、aistock-app-api、aistock-agent-py
- 状态：待用户评审（评审通过后进入实施计划）

## 1. 背景与目标

当前"自选股洞察"链路存在两个问题：

1. **详情页信息过载**：`insight-detail-move.vue` 同时渲染报价头、洞见卡（含预判摘要）、归因状态、主因结论 + 聚焦因果链、五层候选、未解问题、证据清单、预判区共 8 个区块，移动端阅读成本高。
2. **预判链路不再需要**：阶段 2/3 引入的"轻量预判（forecast，midday/close slot）"经产品评审后决定整体下线。

目标：

- 洞察详情页**精简**为：报价头 + 一句话主因（含置信度）+ 底部"生成完整洞察报告 PDF"按钮。
- **彻底移除**轻量预判：三仓代码 + 数据库列 + 历史数据。
- 新增**完整洞察报告 PDF**（归因全量：五层候选 + 六阶段因果链 + 证据清单 + 未解问题 + 事件事实 + 免责声明），入口为详情页底部与"自选股异动"页异动卡片下端。

## 2. 决策记录（已与用户确认）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 取消预判的程度 | **彻底移除**（代码 + DB 列 + 历史数据） |
| 2 | PDF 生成方 | **agent-py 生成**（Python + reportlab） |
| 3 | PDF 交付方式 | **实时生成流式下载**（不落盘、无对象存储） |
| 4 | 详情页保留内容 | **报价头 + 一句话主因（含置信度）+ PDF 按钮** |
| 5 | PDF 内容范围 | **归因全量**（事件事实 + 主因 + 五层候选 + 六阶段链 + 证据清单 + 未解问题 + 免责声明） |
| 6 | 无归因时（processing/unavailable） | **禁止下载**：前端隐藏/禁用按钮；后端兜底返回 409 |

范围外（本次不做，避免过度设计）：

- 报告产物不落盘、不入对象存储、不做历史报告列表/分享链接。
- 首页洞察块（ListCell 6 行）**不加** PDF 按钮。
- 不改动异动事件的触发/打点/归因链路本身。

## 3. 详情页精简方案

### 3.1 精简后结构（`insight-detail-move.vue`）

1. **报价头**（保留现状）：股票名 + 涨/跌异动标签 + 价格 + 涨跌幅 + 开盘 + 阈值 + 严重度 + 触发时间
2. **一句话主因**：
   - `analysis_status === 'completed'`：取 `movement_view.primaryCandidate.verdict` 作为一句话主因，附置信度（`movement_view.confidenceLevel`）与归类标签；无 `verdict` 时回退 `primary_cause`（详情接口已返回）
   - `processing`：显示"归因中…"
   - `unavailable`：显示"原因暂不可用"
3. **底部按钮**："生成完整洞察报告 PDF"（仅 completed 且有有效归因时可用；processing/unavailable 时置灰并提示"该异动暂无完整归因"）

### 3.2 移除的区块

- 洞见卡内的"聚焦因果链"预览、候选归因卡片列表、未解问题、证据清单
- 预判区（整块，含 slot 标签）、洞见卡的 forecast summary 行
- 以上内容全部迁入 PDF 报告（见 §5）

## 4. 预判彻底移除清单

### 4.1 aistock-agent-py

| 文件 | 动作 |
|------|------|
| `src/aistock_agent/services/light_predictor.py` | 删除 |
| `src/aistock_agent/prompts/workers/light_predict.py` | 删除 |
| `src/aistock_agent/schemas/prediction.py` | 删除 `LightForecast` 及其引用 |
| `src/aistock_agent/services/scheduler.py` | 删除 `light_predict_midday`/`light_predict_close` 两个 job 与 `_run_light_predict_task` |
| `src/aistock_agent/config.py` | 删除 `scheduler_light_predict_midday_cron`/`scheduler_light_predict_close_cron` |
| `src/aistock_agent/services/data_client.py` | 删除 `list_light_predict_targets`/`set_event_forecast`/`set_judgement_forecast` |
| `src/aistock_agent/iterate/replay_layer.py` | 移除上述方法的隔离登记项 |
| `tests/unit/test_light_predictor.py` | 删除 |
| `tests/unit/test_scheduler.py` 等 | 回退 `from_crontab` 计数断言（-2）与 job 列表断言 |

### 4.2 aistock-app-api

| 位置 | 动作 |
|------|------|
| 新增迁移 `src/db/migrations/019_drop_forecast.sql` | `ALTER TABLE stock_trace_events DROP COLUMN IF EXISTS forecast;`、`ALTER TABLE stock_info_judgements DROP COLUMN IF EXISTS forecast;`（**保留 `is_limit_up`**，前端涨停文案仍依赖）。编号以当前最大迁移号 +1 为准（若 019 已被占用则顺延） |
| `ensureSchema()` / 启动兜底中的幂等 ALTER | 移除 `forecast` 列的 `ADD COLUMN IF NOT EXISTS`（否则重启会重建列）；`is_limit_up` 的 ALTER 保留 |
| `StockTraceService.ts` | 删 `listLightPredictTargets`、`upsertEventForecast`；`listUserEvents`/`listRecentEvents`/`getUserEvent`/`getRecentEvent` 返回体移除 `forecast`（保留 `is_limit_up`） |
| `StockTraceController`（controller.ts） | 移除 `forecast` 透出 |
| `internalRouter.ts` | 删 `GET /light-predict-targets`、`PATCH /events/:eventId/forecast` |
| `crawler/internalRouter.ts` | 删 `PATCH /internal/stock-info/judgements/:id/forecast`；若该文件仅此端点则删除文件并从 `index.ts` 卸载挂载 |
| `crawler/StockInfoService.ts` | 删 `upsertJudgementForecast` 与 3 处 SELECT 中的 `forecast` 列、行类型字段 |
| `monitor/service.ts` | 删 `MonitorEventItem`/`mapJudgementToEvent` 中的 `forecast` |
| `stock-trace/types.ts` | 删 `ForecastSlot`、`LightPredictTarget` 类型；前端 `stockTrace.ts` 同步删 `forecast` 字段 |

### 4.3 aistock-app-frontend

| 位置 | 动作 |
|------|------|
| `pages/insight-detail-move.vue` | 删预判区模板块与样式、`forecastSlot` computed、`slotLabel`、`parseForecastSlot` 引用；洞见卡 forecast 行 |
| `pages/insight.vue` | 删 `forecastSummary` 及其展示行 |
| `components/insightCards.ts` | 删 `ForecastSlotPayload`、`parseForecastSlot`、`hasForecast` 及其派生逻辑（`cardInTab` 的 forecast 分支）；若 `buildInsightCards`/`InsightStockCard` 经 Grep 确认已无生产引用，且其中含预判字段，一并按最小改动清理 |
| `components/insightCards.spec.ts` | 删除 `parseForecastSlot` 相关用例（保留/更新其余用例） |
| `shared/api/modules/stockTrace.ts` | 删 `forecast` 字段 |
| 前端情报接口相关 | 情报列表仅展示 title/meta，无 forecast 展示，无需改动 |

### 4.4 数据

迁移 019 执行即丢弃历史 `forecast` 数据（用户已确认）。执行前建议在开发环境备份一次表结构相关的行数统计（可选，非强制）。

## 5. 完整洞察报告 PDF

### 5.1 数据流与接口契约

```
前端(H5/App, 带 JWT)
  → GET /api/cn/favorites/movements/:eventId/report.pdf        [app-api]
      · JWT 鉴权（复用 stock-trace controller 的 authFromRequest）
      · 自选归属校验（复用 getUserEvent/getRecentEvent；无归属 → 404）
      · 无有效归因（无 artifact 且最新 result 非 passed）→ 409 { code: 409, message: '该异动暂无完整归因' }
  → app-api InsightReportService.buildReportData(eventId)
      · 事件事实：getInternalEvent(eventId)（含 revisions）
      · 归因：presentEventAnalysis 同源逻辑（getEffectiveArtifactForRevision → 回退 getEffectiveArtifact）
      · 主因短语：result.primary_phrase；摘要：result.display_report
  → POST {AGENT_PY_URL}/internal/insight-report/render             [agent-py]
      Header: X-Internal-Token
      Body: 报告数据 JSON（见 §5.3）
      Resp: application/pdf（bytes）
  → app-api 透传：Content-Type: application/pdf
                 Content-Disposition: attachment; filename="insight-report-<symbol>-<date>.pdf"
```

- agent-py 不回调、不出站 → 不涉及 `replay_layer` 登记。
- 生成不落盘；每次点击实时渲染（纯模板填充，无 LLM，成本≈0）。
- 超时：app-api 调用 agent-py 设 10s 超时；失败返回 502 + 前端提示"报告生成失败，请重试"。

### 5.2 agent-py 实现

- 新增 `src/aistock_agent/services/insight_report.py`：纯渲染函数 `render_insight_report(data: dict) -> bytes`
- 依赖：新增 `reportlab`（写入 `pyproject.toml`）
- 中文：`reportlab.pdfbase.cidfonts.UnicodeCIDFont('STSong-Light')`，无需字体文件
- 新增路由：`POST /internal/insight-report/render`，校验 `X-Internal-Token`（复用现有 internal 鉴权依赖）
- 版式：A4 纵向；页眉（股票名 + 代码 + 报告日期）；页脚（页码 + "本报告由 AI 生成，仅供参考，不构成投资建议"）

### 5.3 报告章节结构（归因全量）

1. **事件事实**：股票（名称/代码）、触发时间、方向、涨跌幅、阈值、严重度、最新价/昨收
2. **主因结论**：一句话主因（`verdict`/`primary_phrase`）+ 置信度 + 归类标签 + 归因生成时间
3. **五层候选归因**：layer（company/sector/market/capital/technical）、status（supported/weak/rejected/insufficient）、verdict、支撑证据 ID
4. **六阶段因果链**：stage（structural_root→trigger→transmission→exposure→repricing→observable_result）、claim、epistemicType、status、证据 ID
5. **证据清单**：kind/provider/title/content_excerpt/occurred_at/canonical_url
6. **未解问题**：unresolved_questions
7. **免责声明**：AI 生成、数据来源、仅供参考

### 5.4 输入 JSON 契约（app-api → agent-py）

```json
{
  "event": {
    "eventId": "mv:003018:2026-09-04:1788485647932:up",
    "symbol": "003018", "stockName": "金富科技",
    "tradingDate": "2026-09-04", "direction": "up",
    "triggeredAt": "2026-09-04T01:34:07.932Z",
    "latestPrice": 60.49, "previousClose": 56.43,
    "changePct": 7.19, "thresholdPct": 7, "severity": "medium",
    "ruleVersion": "price-v1"
  },
  "attribution": {
    "primaryPhrase": "液冷服务器概念板块联动",
    "confidenceLevel": "medium",
    "candidates": [ { "layer": "sector", "status": "supported", "verdict": "…", "supportingEvidenceIds": ["e1"] } ],
    "chains": [ { "role": "primary", "nodes": [ { "stage": "trigger", "claim": "…", "epistemicType": "fact", "status": "established", "evidenceIds": ["e1"] } ] } ],
    "unresolvedQuestions": ["…"],
    "evidenceIndex": [ { "source_id": "e1", "kind": "news", "provider": "cls", "title": "…", "content_excerpt": "…", "occurred_at": "…", "canonical_url": "…" } ]
  }
}
```

- 所有字段均为"可用即渲染"：缺失字段输出"暂缺"，不得报错中断。
- 证据 ID 与清单做映射展示（如 `e1`、`e2`），供读者对照。

## 6. 前端入口与下载适配

- **详情页底部**：主按钮"生成完整洞察报告 PDF"（`completed` 且有效归因可用）
- **自选股异动页卡片下端**：`InsightAlertCard` 内新增"洞察报告"次按钮，`@click.stop` 阻止冒泡（不触发进详情）；仅当该事件 `analysis_status === 'completed'` 时显示（列表接口已返回该字段）
- 新增 `src/shared/utils/downloadInsightReport.ts`：
  - H5：`fetch(API + /report.pdf, { headers: { Authorization } })` → `blob` → `a[download]` 触发下载
  - App：`uni.downloadFile({ url, header: { Authorization } })` → `uni.openDocument`（失败提示"请先在系统设置中安装 PDF 阅读器"）
  - 统一错误提示：401 登录失效 / 404 事件不存在 / 409 "该异动暂无完整归因" / 其他 "报告生成失败，请重试"
- 接口常量集中在 `shared/api/modules/stockTrace.ts`（新增 `reportUrl(eventId)`）

## 7. 测试与验收

### 7.1 单元/接口测试

- agent-py：`tests/unit/test_insight_report.py`
  - 正常数据 → 返回 bytes 且长度 > 0，且内容包含"主因结论""五层候选""六阶段因果链""证据清单""免责声明"关键标题
  - 字段缺失（无 candidates/chains/evidence）→ 仍成功渲染，缺失章节显示"暂缺"
- app-api：`__tests__/insightReport.spec.ts`
  - 未登录 → 401；无自选归属 → 404；无有效归因 → 409；成功 → 状态 200、`content-type: application/pdf` 且响应体透传 agent bytes（mock agent 调用）
- 前端：`insightCards.spec.ts` 更新（删预判用例）；新增 `downloadInsightReport` 或卡片按钮渲染用例（mock 请求，断言按钮存在与调用）

### 7.2 端到端验收（H5）

1. 预判相关内容全部消失：详情页无预判区/预判摘要，洞察列表无预判摘要行，DB 中 `forecast` 列不存在（迁移 019 已执行）
2. 详情页仅剩：报价头 + 一句话主因 + PDF 按钮
3. 用 mxfff 登录 → 自选股异动页 → 点卡片下端"洞察报告" → 下载得到 PDF；打开核对：章节齐全、中文正常、候选/链/证据与页面原数据一致
4. 对一个 `unavailable` 事件：按钮不显示（详情页）→ 手工请求接口返回 409
5. agent-py 重启后 scheduler 不再注册 `light_predict_*` job

### 7.3 回归

- `stock_trace_lookup` 读层：`GET /internal/stock-trace/events` 不再返回 `forecast` 字段（列表页不依赖）
- 涨停文案仍使用 `is_limit_up`（列保留），不受影响

## 8. 风险与回滚

| 风险 | 说明 | 缓解 |
|------|------|------|
| 迁移 019 不可逆丢弃 forecast 历史 | 已确认接受 | 执行前可导出 `SELECT event_id, forecast FROM stock_trace_events WHERE forecast <> '{}'::jsonb` 备份为 JSON（可选） |
| 忘记移除 `ensureSchema` 幂等 ALTER | 会导致重启后 forecast 列被重建，且回写接口已删 → 表中出现空列 | 实施时 Grep `forecast` 全仓定位所有 ADD COLUMN；用迁移 019 + 删除 ALTER 双保险 |
| reportlab 中文显示 | STSong-Light 为 PDF 阅读器内置 CID 字体，个别精简阅读器可能回退 | 备选：内置 NotoSansSC 字体文件并用 `TTFont` 嵌入 |
| App 端打开 PDF | 无阅读器时会失败 | 提示安装/使用外部应用打开 |
| agent-py 不可用 | 下载失败 | app-api 返回 502 + 前端"报告生成失败，请重试" |

## 9. 实施顺序（供后续计划展开）

1. agent-py：新增 PDF 渲染服务 + internal 端点 + 依赖（可独立先交付并单测）
2. app-api：报告数据组装 + `report.pdf` 端点 + agent 调用（依赖 1 的契约，可用 mock 并行开发）
3. app-api：迁移 019 + 预判移除（代码/端点/字段）
4. agent-py：预判移除（任务/提示词/schema/配置/测试）
5. frontend：详情页精简 + 下载适配 +（异动卡片下端按钮）
6. frontend：预判相关清理（insightCards/insight.vue/类型/spec）
7. 端到端验收 + 文档同步（各仓 AGENTS.md / changelog / project_memory）
