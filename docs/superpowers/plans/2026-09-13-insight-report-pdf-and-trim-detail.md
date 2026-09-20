# 洞察详情页精简 + 取消预判 + 完整洞察报告 PDF 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 洞察详情页精简为"报价头 + 一句话主因 + PDF 按钮"，彻底移除轻量预判链路（代码 + DB 列 + 历史数据），新增由 agent-py 渲染、实时流式下载的"完整洞察报告 PDF"。

**Architecture:** 前端（JWT）→ app-api `GET /api/cn/favorites/movements/:eventId/report.pdf`（鉴权 + 自选归属 + 组装报告数据）→ agent-py `POST /internal/insight-report/render`（X-Internal-Token，reportlab 纯模板渲染）→ PDF 字节流原路返回；不落盘、不调 LLM。预判移除为独立清理线（app-api 迁移 019 + agent-py 删除任务/提示词）。

**Tech Stack:** aistock-app-frontend（uni-app Vue3 + TS + vitest）、aistock-app-api（Express + TS + pg + node:test/tsx）、aistock-agent-py（FastAPI + Pydantic + pytest + reportlab）。

**Spec:** `d:\aistock\aistock-app-api\docs\superpowers\specs\2026-09-13-insight-report-pdf-and-trim-detail-design.md`

## Global Constraints

- 分支：三仓均在 `junliang`；提交信息用 `feat:`/`fix:` + 中文描述（遵循各仓习惯）。
- **保留 `stock_trace_events.is_limit_up`**（涨停文案依赖），只删 `forecast` 列。
- 无有效归因（无 artifact）时，报告端点返回 **409**（`{ code: 409, message: '该异动暂无完整归因' }`），前端按钮不展示。
- 报告**实时生成、不落盘、不入对象存储**；中文使用 reportlab `STSong-Light` CID 字体（免字体文件）。
- 首页洞察块（ListCell ≤6 行）**不加** PDF 按钮。
- agent-py 只新增"被 app-api 调用"的端点，**不出站** → 不涉及 `iterate/replay_layer.py` 登记。
- 删除预判时**不得触碰**对话/个股预测功能（`predict_stock`、`schemas/prediction.py` 中非 `LightForecast` 的部分、`prompts/workers/prediction*`）。
- Windows + PowerShell 环境；命令以 `;` 串联，`npx`/`node`/`.venv311` 路径按各仓现状。
- 沙箱注意：本机命令经 `trae-sandbox` 执行，改动文件后如命令报"文件不存在/旧内容"，用 Write 全量重写或沙箱内脚本改写再复验。

---

### Task 1: agent-py 完整洞察报告 PDF 渲染（纯函数 + 渲染 + internal 端点）

**Files:**
- Create: `aistock-agent-py/src/aistock_agent/services/insight_report.py`
- Create: `aistock-agent-py/tests/unit/test_insight_report.py`
- Modify: `aistock-agent-py/pyproject.toml`（`dependencies` 增加 reportlab）
- Modify: `aistock-agent-py/src/aistock_agent/api/routes.py`（文件末尾新增端点；顶部 `from fastapi import ...` 补 `Response`）

**Interfaces:**
- Consumes: `aistock_agent.api.deps.verify_internal_token`（已存在）
- Produces:
  - `build_report_sections(data: dict[str, Any]) -> list[tuple[str, list[str]]]`（纯函数；缺失字段输出 `"暂缺"`）
  - `render_insight_report(sections: list[tuple[str, list[str]]], *, title: str = "自选股洞察 · 完整归因报告") -> bytes`
  - HTTP：`POST /api/agent/insight-report/render`（FastAPI `router` 前缀为 `/api/agent`，见 `routes.py` 挂载；鉴权 `X-Internal-Token`）

- [ ] **Step 1: 加依赖**

`pyproject.toml` 的 `dependencies` 中（`"httpx==0.28.1",` 一行之后）加入：

```toml
    "reportlab>=4.2,<5.0",     # 完整洞察报告 PDF 渲染（纯模板，无 LLM）
```

安装：

```powershell
cd d:\aistock\aistock-agent-py; .\.venv311\Scripts\python.exe -m pip install "reportlab>=4.2,<5.0"
```

Expected: `Successfully installed reportlab-4.x`

- [ ] **Step 2: 写失败测试**

创建 `tests/unit/test_insight_report.py`：

```python
"""完整洞察报告 PDF 渲染测试（2026-09-13）。"""

from aistock_agent.services.insight_report import build_report_sections, render_insight_report

_FULL_DATA = {
    "event": {
        "eventId": "mv:003018:2026-09-04:1788485647932:up",
        "symbol": "003018",
        "stockName": "金富科技",
        "triggeredAt": "2026-09-04T01:34:07.932Z",
        "direction": "up",
        "changePct": 7.19,
        "thresholdPct": 7,
        "severity": "medium",
        "latestPrice": 60.49,
        "previousClose": 56.43,
    },
    "attribution": {
        "primaryPhrase": "液冷服务器概念板块联动",
        "confidenceLevel": "medium",
        "candidates": [{"layer": "sector", "status": "supported", "verdict": "板块联动", "supportingEvidenceIds": ["e1"]}],
        "chains": [{"role": "primary", "nodes": [{"stage": "trigger", "claim": "板块异动", "epistemicType": "fact", "status": "established", "evidenceIds": ["e1"]}]}],
        "unresolvedQuestions": ["资金持续性待观察"],
        "evidenceIndex": [{"source_id": "e1", "kind": "news", "title": "液冷概念走强", "content_excerpt": "板块涨 3%"}],
    },
}


def test_build_sections_contains_all_chapters() -> None:
    sections = build_report_sections(_FULL_DATA)
    headings = [h for h, _ in sections]
    assert headings == ["事件事实", "主因结论", "五层候选归因", "六阶段因果链", "证据清单", "未解问题"]


def test_missing_fields_render_as_placeholder() -> None:
    sections = build_report_sections({"event": {}, "attribution": {}})
    joined = "\n".join(line for _, lines in sections for line in lines)
    assert "暂缺" in joined


def test_render_returns_pdf_bytes() -> None:
    pdf = render_insight_report(build_report_sections(_FULL_DATA))
    assert pdf[:4] == b"%PDF"
    assert len(pdf) > 1000
```

- [ ] **Step 3: 运行测试确认失败**

```powershell
cd d:\aistock\aistock-agent-py; $env:PYTHONPATH="src"; .\.venv311\Scripts\python.exe -m pytest tests/unit/test_insight_report.py -q
```

Expected: FAIL（`ModuleNotFoundError: No module named 'aistock_agent.services.insight_report'`）

- [ ] **Step 4: 实现渲染服务**

创建 `src/aistock_agent/services/insight_report.py`：

```python
"""完整洞察报告 PDF 渲染（2026-09-13）。

纯模板填充，不调用 LLM：app-api 组装报告数据 → 本服务渲染 A4 PDF → 原路流式回传。
中文使用 reportlab 内置 CID 字体 STSong-Light，无需字体文件。
"""

from __future__ import annotations

from io import BytesIO
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

_FONT = "STSong-Light"
_MISSING = "暂缺"
_DISCLAIMER = "本报告由 AI 生成，仅供参考，不构成投资建议"


def _register_font() -> None:
    """注册中文字体（幂等）。"""
    try:
        pdfmetrics.getFont(_FONT)
    except KeyError:
        pdfmetrics.registerFont(UnicodeCIDFont(_FONT))


def _text(value: Any) -> str:
    """任意值 → 展示文本；空值统一"暂缺"。"""
    if value is None or value == "":
        return _MISSING
    return str(value)


def _escape(text: str) -> str:
    """Paragraph 需要转义 XML 保留字符。"""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_report_sections(data: dict[str, Any]) -> list[tuple[str, list[str]]]:
    """报告数据 → 章节列表 (标题, 内容行)。缺失字段输出"暂缺"，不抛错。"""
    event = data.get("event") or {}
    attr = data.get("attribution") or {}

    sections: list[tuple[str, list[str]]] = [
        ("事件事实", [
            f"股票：{_text(event.get('stockName'))}（{_text(event.get('symbol'))}）",
            f"触发时间：{_text(event.get('triggeredAt'))}",
            f"方向：{_text(event.get('direction'))}",
            f"涨跌幅：{_text(event.get('changePct'))}%（阈值 {_text(event.get('thresholdPct'))}%）",
            f"严重度：{_text(event.get('severity'))}",
            f"最新价 / 昨收：{_text(event.get('latestPrice'))} / {_text(event.get('previousClose'))}",
        ]),
        ("主因结论", [
            f"一句话主因：{_text(attr.get('primaryPhrase'))}",
            f"置信度：{_text(attr.get('confidenceLevel'))}",
        ]),
    ]

    candidates = [c for c in (attr.get("candidates") or []) if isinstance(c, dict)]
    sections.append(("五层候选归因", [
        f"[{_text(c.get('layer'))} · {_text(c.get('status'))}] {_text(c.get('verdict'))}"
        for c in candidates
    ] or [_MISSING]))

    chain_lines: list[str] = []
    for chain in attr.get("chains") or []:
        if not isinstance(chain, dict):
            continue
        for node in chain.get("nodes") or []:
            if not isinstance(node, dict):
                continue
            chain_lines.append(
                f"{_text(node.get('stage'))}：{_text(node.get('claim'))}"
                f"（{_text(node.get('epistemicType'))} / {_text(node.get('status'))}）"
            )
    sections.append(("六阶段因果链", chain_lines or [_MISSING]))

    evidence = [e for e in (attr.get("evidenceIndex") or []) if isinstance(e, dict)]
    sections.append(("证据清单", [
        f"{_text(e.get('source_id'))}｜{_text(e.get('kind'))}｜{_text(e.get('title'))}｜{_text(e.get('content_excerpt'))}"
        for e in evidence
    ] or [_MISSING]))

    questions = [str(q) for q in (attr.get("unresolvedQuestions") or []) if q]
    sections.append(("未解问题", questions or [_MISSING]))

    return sections


def render_insight_report(
    sections: list[tuple[str, list[str]]],
    *,
    title: str = "自选股洞察 · 完整归因报告",
) -> bytes:
    """章节列表 → A4 PDF bytes（页眉标题 + 章节 + 页脚免责声明/页码）。"""
    _register_font()
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("cnTitle", parent=styles["Title"], fontName=_FONT, fontSize=18, leading=26)
    heading_style = ParagraphStyle(
        "cnHeading", parent=styles["Heading2"], fontName=_FONT, fontSize=13, leading=19,
        spaceBefore=12, spaceAfter=4, textColor=colors.HexColor("#1B4E8C"),
    )
    body_style = ParagraphStyle("cnBody", parent=styles["BodyText"], fontName=_FONT, fontSize=10.5, leading=17)

    def _decorate(canvas: Any, doc: Any) -> None:  # noqa: ANN401 - reportlab 回调签名
        canvas.saveState()
        canvas.setFont(_FONT, 8)
        canvas.drawString(18 * mm, 12 * mm, _DISCLAIMER)
        canvas.drawRightString(A4[0] - 18 * mm, 12 * mm, f"第 {doc.page} 页")
        canvas.restoreState()

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        topMargin=18 * mm, bottomMargin=20 * mm, leftMargin=18 * mm, rightMargin=18 * mm,
        title=title,
    )
    story: list[Any] = [Paragraph(_escape(title), title_style), Spacer(1, 8)]
    for heading, lines in sections:
        story.append(Paragraph(_escape(heading), heading_style))
        for line in lines:
            story.append(Paragraph(_escape(line), body_style))
    doc.build(story, onFirstPage=_decorate, onLaterPages=_decorate)
    return buffer.getvalue()
```

- [ ] **Step 5: 运行测试确认通过**

```powershell
cd d:\aistock\aistock-agent-py; $env:PYTHONPATH="src"; .\.venv311\Scripts\python.exe -m pytest tests/unit/test_insight_report.py -q
```

Expected: `3 passed`

- [ ] **Step 6: 新增 internal 端点**

`src/aistock_agent/api/routes.py`：

1）顶部 `from fastapi import ...` 一行中补上 `Response`（若未导入）；确保已有 `from aistock_agent.api.deps import verify_internal_token`。

2）文件末尾新增：

```python
@router.post("/insight-report/render")
async def render_insight_report_pdf(
    payload: dict[str, Any],
    _: None = Depends(verify_internal_token),
) -> Response:
    """完整洞察报告 PDF 渲染：app-api 组装数据 → 本端点纯模板渲染（无 LLM）→ 返回 application/pdf。"""
    from aistock_agent.services.insight_report import build_report_sections, render_insight_report

    pdf = render_insight_report(build_report_sections(payload))
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="insight-report.pdf"'},
    )
```

- [ ] **Step 7: 手工验证端点**

```powershell
# 另开终端先启动 agent-py（若未运行）
cd d:\aistock\aistock-agent-py; $env:PYTHONPATH="src"; .\.venv311\Scripts\python.exe -m uvicorn aistock_agent.main:app --host 0.0.0.0 --port 8000
# 再发请求（token 取 .env.development 的 INTERNAL_API_TOKEN）
$tok = ((Select-String -Path d:\aistock\aistock-agent-py\.env.development -Pattern '^INTERNAL_API_TOKEN=').Line -replace '^INTERNAL_API_TOKEN=','').Trim('"')
$body = '{"event":{"symbol":"003018","stockName":"金富科技","changePct":7.19,"thresholdPct":7},"attribution":{"primaryPhrase":"测试主因"}}'
$r = Invoke-WebRequest -Uri 'http://localhost:8000/api/agent/insight-report/render' -Method Post -Headers @{ 'X-Internal-Token' = $tok } -ContentType 'application/json' -Body $body -OutFile d:\aistock\tmp-report.pdf -PassThru
"status=$($r.StatusCode)"; (Get-Item d:\aistock\tmp-report.pdf).Length
```

Expected: `status=200` 且文件长度 > 1000；用 PDF 阅读器打开可见中文章节与页脚。

- [ ] **Step 8: 提交**

```powershell
cd d:\aistock\aistock-agent-py; git add pyproject.toml src/aistock_agent/services/insight_report.py src/aistock_agent/api/routes.py tests/unit/test_insight_report.py; git commit -m "feat(insight-report): 新增完整洞察报告 PDF 渲染服务与 internal 端点"
```

---

### Task 2: app-api 报告数据组装 + `report.pdf` 端点

**Files:**
- Create: `aistock-app-api/src/modules/stock-trace/InsightReportService.ts`
- Modify: `aistock-app-api/src/modules/stock-trace/controller.ts`（新增 `report` 静态方法）
- Modify: `aistock-app-api/src/index.ts`（在 271 行 `app.get('/api/cn/favorites/movements/:eventId', ...)` **之前**注册新路由）
- Create: `aistock-app-api/src/modules/stock-trace/__tests__/insightReport.spec.ts`

**Interfaces:**
- Consumes: `StockTraceService.getUserEvent(id, openid, eventId)` / `getRecentEvent(eventId)`；`StockTraceArtifactService.getEffectiveArtifactForRevision(eventId, revision)` / `getEffectiveArtifact(eventId)`；`StockTraceResultService.getLatestForEventRevision(eventId, revision)`；`presentEventAnalysis(eventId, event)`（controller 内私有函数，同文件可用）；`authFromRequest(req)`、`eventIdFromRequest(req)`（同文件）
- Produces:
  - `InsightReportService.buildReportData(event: Record<string, unknown>, artifact: StockTraceArtifact, result: StockTraceResult | null): Record<string, unknown>`
  - `InsightReportService.renderPdf(data: Record<string, unknown>): Promise<Buffer>`
  - HTTP：`GET /api/cn/favorites/movements/:eventId/report.pdf`（401 未登录 / 404 无归属 / 409 无完整归因 / 200 PDF / 502 agent 失败）

- [ ] **Step 1: 写失败测试**

创建 `src/modules/stock-trace/__tests__/insightReport.spec.ts`：

```ts
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StockTraceController } from '../controller.ts';
import { StockTraceService } from '../StockTraceService.ts';
import { StockTraceArtifactService } from '../StockTraceArtifactService.ts';
import { StockTraceResultService } from '../StockTraceResultService.ts';
import { InsightReportService } from '../InsightReportService.ts';

function fakeRes() {
    const res = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        body: undefined as unknown,
        setHeader(k: string, v: string) { this.headers[k] = v; return this; },
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
        send(payload: unknown) { this.body = payload; return this; },
    };
    return res;
}

describe('GET /movements/:eventId/report.pdf', () => {
    beforeEach(() => {
        process.env.JWT_SECRET = 'test-secret';
    });

    it('未登录 → 401', async () => {
        const res = fakeRes();
        await StockTraceController.report({ headers: {}, params: { eventId: 'mv:1' } } as never, res as never, (() => {}) as never);
        assert.equal(res.statusCode, 401);
    });

    it('无自选归属 → 404', async () => {
        mock.method(StockTraceService, 'getUserEvent', async () => null);
        const res = fakeRes();
        const req = { headers: { authorization: 'Bearer x' }, params: { eventId: 'mv:1' } };
        mock.method(await import('../../shared/utils/jwt.ts'), 'verifyJwt', () => ({ id: 'u1', openid: 'o1' }));
        await StockTraceController.report(req as never, res as never, (() => {}) as never);
        assert.equal(res.statusCode, 404);
    });

    it('无有效归因 → 409', async () => {
        mock.method(StockTraceService, 'getUserEvent', async () => ({ event_id: 'mv:1', trigger_revision: 1 }));
        mock.method(StockTraceArtifactService, 'getEffectiveArtifactForRevision', async () => null);
        mock.method(StockTraceArtifactService, 'getEffectiveArtifact', async () => null);
        mock.method(StockTraceResultService, 'getLatestForEventRevision', async () => ({ validationStatus: 'rejected', processingStatus: 'partial' }));
        const res = fakeRes();
        mock.method(await import('../../shared/utils/jwt.ts'), 'verifyJwt', () => ({ id: 'u1', openid: 'o1' }));
        await StockTraceController.report({ headers: { authorization: 'Bearer x' }, params: { eventId: 'mv:1' } } as never, res as never, (() => {}) as never);
        assert.equal(res.statusCode, 409);
    });

    it('成功 → 200 + application/pdf', async () => {
        const artifact = { artifactId: 'a1', artifactVersion: 1, artifactJson: { candidates: [], chains: [], evidence_index: [] }, movementView: { status: 'confirmed' }, createdAt: '2026-09-13' };
        mock.method(StockTraceService, 'getUserEvent', async () => ({ event_id: 'mv:1', symbol: '003018', trigger_revision: 1, triggered_at: '2026-09-04T01:34:07.932Z' }));
        mock.method(StockTraceArtifactService, 'getEffectiveArtifactForRevision', async () => artifact);
        mock.method(StockTraceResultService, 'getLatestForEventRevision', async () => ({ primaryPhrase: '液冷服务器概念板块联动', validationStatus: 'passed', processingStatus: 'completed' }));
        mock.method(InsightReportService, 'renderPdf', async () => Buffer.from('%PDF-1.4 fake'));
        const res = fakeRes();
        mock.method(await import('../../shared/utils/jwt.ts'), 'verifyJwt', () => ({ id: 'u1', openid: 'o1' }));
        await StockTraceController.report({ headers: { authorization: 'Bearer x' }, params: { eventId: 'mv:1' } } as never, res as never, (() => {}) as never);
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['Content-Type'], 'application/pdf');
        assert.ok(String(res.headers['Content-Disposition']).includes('attachment'));
    });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
cd d:\aistock\aistock-app-api; node --import tsx --test src/modules/stock-trace/__tests__/insightReport.spec.ts
```

Expected: FAIL（`Cannot find module '../InsightReportService.ts'`）

- [ ] **Step 3: 实现 InsightReportService**

创建 `src/modules/stock-trace/InsightReportService.ts`：

```ts
import axios from 'axios';
import type { StockTraceArtifact, StockTraceResult } from './types';

/** agent-py 报告渲染端点（内部调用，非出站数据源） */
function agentBaseUrl(): string {
    return (process.env.AGENT_PY_URL || process.env.PYTHON_AGENT_URL || 'http://localhost:8000').replace(/\/$/, '');
}

/**
 * 报告数据组装（纯函数，便于单测）：
 * 事件事实 + 归因结论（主因短语/置信度）+ 五层候选 + 六阶段因果链 + 证据清单 + 未解问题。
 * 字段缺失不做兜底（由 agent-py 渲染为"暂缺"）。
 */
export const InsightReportService = {
    buildReportData(
        event: Record<string, unknown>,
        artifact: StockTraceArtifact,
        result: StockTraceResult | null,
    ): Record<string, unknown> {
        const content = artifact.artifactJson ?? {};
        const view = artifact.movementView;
        return {
            event: {
                eventId: event.event_id,
                symbol: event.symbol,
                stockName: event.stock_name,
                triggeredAt: event.triggered_at ?? event.first_triggered_at,
                direction: event.direction,
                changePct: event.change_pct,
                thresholdPct: event.threshold_pct,
                severity: event.severity,
                latestPrice: event.latest_price,
                previousClose: event.previous_close,
            },
            attribution: {
                primaryPhrase: result?.primaryPhrase ?? view?.primaryCandidate?.verdict ?? event.primary_cause ?? null,
                confidenceLevel: view?.confidenceLevel ?? null,
                candidates: content.candidates ?? [],
                chains: content.chains ?? [],
                unresolvedQuestions: content.unresolved_questions ?? [],
                evidenceIndex: content.evidence_index ?? [],
            },
        };
    },

    /** 调用 agent-py 渲染 PDF；失败抛出（由 controller 转 502）。 */
    async renderPdf(data: Record<string, unknown>): Promise<Buffer> {
        const token = process.env.INTERNAL_API_TOKEN ?? '';
        const response = await axios.post(`${agentBaseUrl()}/api/agent/insight-report/render`, data, {
            headers: { 'X-Internal-Token': token, 'Content-Type': 'application/json' },
            responseType: 'arraybuffer',
            timeout: 10_000,
        });
        return Buffer.from(response.data as ArrayBuffer);
    },
};
```

- [ ] **Step 4: 新增 controller.report**

`src/modules/stock-trace/controller.ts`：顶部补 `import { InsightReportService } from './InsightReportService';`，在 `get` 方法之后新增：

```ts
    /** 完整洞察报告 PDF：登录 + 自选归属 + 有效归因校验 → 组装数据 → agent-py 渲染 → 流式下载 */
    static async report(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const auth = await authFromRequest(req);
            // 报告属于用户资产：未登录直接 401（不做未登录全局降级）
            if (!auth || !auth.id) {
                res.status(401).json({ code: 401, message: 'unauthorized' });
                return;
            }
            const eventId = eventIdFromRequest(req);
            if (!eventId) {
                res.status(404).json({ code: 404, message: 'not found' });
                return;
            }
            const event = await StockTraceService.getUserEvent(auth.id, auth.openid, eventId);
            if (!event) {
                res.status(404).json({ code: 404, message: 'Event not found' });
                return;
            }
            const presentation = await presentEventAnalysis(eventId, event);
            if (!presentation.artifact) {
                res.status(409).json({ code: 409, message: '该异动暂无完整归因' });
                return;
            }
            const revision = triggerRevision(event);
            const result = revision > 0
                ? await StockTraceResultService.getLatestForEventRevision(eventId, revision)
                : null;
            const data = InsightReportService.buildReportData(event, presentation.artifact, result);
            const pdf = await InsightReportService.renderPdf(data);
            const date = String(event.triggered_at ?? '').slice(0, 10) || 'report';
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="insight-report-${String(event.symbol ?? '')}-${date}.pdf"`);
            res.send(pdf);
        } catch (error) {
            // agent-py 不可用/渲染失败 → 502（前端提示稍后重试）
            res.status(502).json({ code: 502, message: '报告生成失败，请重试' });
            void next;
        }
    }
```

- [ ] **Step 5: 注册路由**

`src/index.ts` 第 271 行之前插入（**必须在 `:eventId` 通用路由之前**，否则被其捕获）：

```ts
app.get('/api/cn/favorites/movements/:eventId/report.pdf', (req, res, next) => StockTraceController.report(req, res, next));
```

- [ ] **Step 6: 运行测试确认通过**

```powershell
cd d:\aistock\aistock-app-api; node --import tsx --test src/modules/stock-trace/__tests__/insightReport.spec.ts; npx tsc --noEmit
```

Expected: 4 tests pass；tsc 无输出（0 error）

- [ ] **Step 7: 端到端手工验证（agent-py 需已运行 Task 1）**

```powershell
# 生成测试 token（复用此前方式：JWT_SECRET + mxfff 的 id/openid），或直接用浏览器已登录态取 localStorage.token
$t = (Select-String -Path d:\aistock\aistock-app-api\.env -Pattern '^INTERNAL_API_TOKEN=').Line -replace '^INTERNAL_API_TOKEN=',''
$a = (Select-String -Path d:\aistock\aistock-app-api\.env -Pattern '^AGENT_PY_URL=').Line -replace '^AGENT_PY_URL=',''
"agent=$a"  # 确认与 agent-py 地址一致
```

用浏览器/Invoke-WebRequest 带登录 JWT 请求：
`http://localhost:3000/api/cn/favorites/movements/mv:003018:2026-09-04:1788485647932:up/report.pdf`
Expected: 200、`Content-Type: application/pdf`、下载文件可打开且含中文章节；对一个 rejected/unavailable 事件请求 → 409。

- [ ] **Step 8: 提交**

```powershell
cd d:\aistock\aistock-app-api; git add src/modules/stock-trace/InsightReportService.ts src/modules/stock-trace/controller.ts src/modules/stock-trace/__tests__/insightReport.spec.ts src/index.ts; git commit -m "feat(insight-report): 新增完整洞察报告 PDF 下载端点（agent-py 渲染、实时流式）"
```

---

### Task 3: app-api 预判彻底移除（迁移 019 + 代码清理）

**Files:**
- Create: `aistock-app-api/src/db/migrations/019_drop_forecast.sql`
- Modify: `aistock-app-api/src/modules/stock-trace/StockTraceService.ts`（删 `listLightPredictTargets`/`upsertEventForecast`；4 个查询方法去掉 `forecast`；删除 ensureSchema 中 forecast 的幂等 ALTER）
- Modify: `aistock-app-api/src/modules/stock-trace/internalRouter.ts`（删 `GET /light-predict-targets`、`PATCH /events/:eventId/forecast` 及其注释块）
- Modify: `aistock-app-api/src/modules/stock-trace/controller.ts`（`list`/`get` 透出字段去掉 `forecast`）
- Modify: `aistock-app-api/src/modules/stock-trace/types.ts`（删 `ForecastSlot`、`LightPredictTarget`）
- Modify: `aistock-app-api/src/modules/crawler/internalRouter.ts`（删 judgements forecast 端点；若文件仅此路由 → 删除文件）
- Modify: `aistock-app-api/src/modules/crawler/StockInfoService.ts`（删 `upsertJudgementForecast` 与 SELECT/行类型中的 `forecast`）
- Modify: `aistock-app-api/src/modules/monitor/service.ts`（`MonitorEventItem`/`mapJudgementToEvent` 去 `forecast`）
- Modify: `aistock-app-api/src/index.ts`（若 crawler internalRouter 整文件删除，移除其挂载行 631）
- Test: `aistock-app-api/src/modules/stock-trace/__tests__/listAnalysisStatus.spec.ts` 等既有 spec 若断言 response 含 forecast → 更新

**Interfaces:**
- Consumes: 现有 schema/服务
- Produces: `stock_trace_events`、`stock_info_judgements` **无 `forecast` 列**；movements/详情接口返回体无 `forecast`（仍含 `is_limit_up`）

- [ ] **Step 1: 定位所有 forecast 引用**

```powershell
cd d:\aistock\aistock-app-api; rg -n "forecast" src/modules/stock-trace src/modules/crawler src/modules/monitor src/index.ts | Select-String -NotMatch "earnings_forecast|profit-forecast|ProfitForecast|forecast_net|forecast_eps|forecast_detail|ForecastVersion|morning_forecast"
```

Expected: 输出即为需清理的行（重点：`StockTraceService`/`internalRouter`/`controller`/`types`/`crawler`/`monitor`）。逐条确认后按下述步骤处理；**与 `stock_trace_events.forecast`、`stock_info_judgements.forecast` 无关的命中（业绩预测等）保持不动**。

- [ ] **Step 2: 写迁移 019**

创建 `src/db/migrations/019_drop_forecast.sql`：

```sql
-- 019_drop_forecast.sql
-- 2026-09-13：轻量预判（forecast）功能彻底下线——删除 slot 分存列（历史数据一并丢弃）
-- 注意：保留 is_limit_up（涨停文章命中标记，前端涨停文案仍依赖）
ALTER TABLE stock_trace_events DROP COLUMN IF EXISTS forecast;
ALTER TABLE stock_info_judgements DROP COLUMN IF EXISTS forecast;
```

- [ ] **Step 3: 执行迁移并验证列已删除**

```powershell
cd d:\aistock\aistock-app-api; node -e "const fs=require('fs');const {Client}=require('pg');(async()=>{const env=Object.fromEntries(fs.readFileSync('.env','utf8').split(/\r?\n/).map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2]]));const c=new Client({connectionString:env.DATABASE_URL});await c.connect();const sql=fs.readFileSync('src/db/migrations/019_drop_forecast.sql','utf8');await c.query(sql);const r=await c.query(\"SELECT table_name,column_name FROM information_schema.columns WHERE column_name='forecast' AND table_name IN ('stock_trace_events','stock_info_judgements')\");console.log('remaining forecast columns:',r.rowCount);const k=await c.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='stock_trace_events' AND column_name='is_limit_up'\");console.log('is_limit_up kept:',k.rowCount===1);await c.end()})()"
```

Expected: `remaining forecast columns: 0` 且 `is_limit_up kept: true`

- [ ] **Step 4: 删除服务方法与返回字段**

`StockTraceService.ts`：
- 删除 `listLightPredictTargets` 整个方法与其上方注释块（`轻量预判候选聚合（阶段 2）…`）
- 删除 `upsertEventForecast` 整个方法与其注释
- `listUserEvents` / `listRecentEvents` / `getUserEvent` / `getRecentEvent`：SELECT 去掉 `e.forecast`（保留 `e.is_limit_up`）；返回对象去掉 `forecast: row.forecast ?? null,`（保留 `is_limit_up: ...`）
- `ensureSchema()` 中删除 forecast 相关 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS forecast ...`（保留 `is_limit_up` 的 ALTER；若两条写在同一次 `pool.query` 调用中，需拆开只删 forecast 部分）

- [ ] **Step 5: 删除 internal 端点**

`internalRouter.ts`：删除文件末尾 `// ── 阶段 2：轻量预判任务端点（agent-py 定时消费，2026-09-03）──` 注释块、`router.get('/light-predict-targets', ...)`、`router.patch('/events/:eventId/forecast', ...)` 及其处理函数。

- [ ] **Step 6: 删除类型/控制器透出/crawler/monitor 引用**

- `types.ts`：删 `ForecastSlot`、`LightPredictTarget` 定义；若其他类型字段引用它们一并删除
- `controller.ts`：`list` 返回 items 映射中删 `forecast`（保留 `is_limit_up`）；`get` 的 `result` 直接 spread（无显式 forecast 时无需改）
- `crawler/internalRouter.ts`：删除 `PATCH /internal/stock-info/judgements/:id/forecast`；若删除后文件无任何路由 → 删除该文件，并在 `index.ts` 删除 `app.use('/internal/stock-info', stockInfoInternalRouter)` 与其 import
- `crawler/StockInfoService.ts`：删 `upsertJudgementForecast`；3 处 SELECT 去掉 `forecast`；行类型/映射去掉 `forecast`
- `monitor/service.ts`：`getEventsByUserFavorites` 的 SELECT 去掉 `forecast`；`MonitorEventItem`/`mapJudgementToEvent` 去掉 `forecast`

- [ ] **Step 7: 回归验证**

```powershell
cd d:\aistock\aistock-app-api; npx tsc --noEmit
node --import tsx --test src/modules/stock-trace/__tests__/listAnalysisStatus.spec.ts
node --import tsx --test src/modules/insight/__tests__/*.spec.ts
```

Expected: tsc 0 error；spec 全通过（若某用例断言返回体含 `forecast`，删除该断言后重跑通过）

- [ ] **Step 8: 提交**

```powershell
cd d:\aistock\aistock-app-api; git add src/db/migrations/019_drop_forecast.sql src/modules/stock-trace src/modules/crawler src/modules/monitor src/index.ts; git commit -m "refactor(insight): 彻底移除轻量预判 forecast（迁移 019 + 服务/端点/字段清理）"
```

---

### Task 4: agent-py 预判彻底移除

**Files:**
- Delete: `aistock-agent-py/src/aistock_agent/services/light_predictor.py`
- Delete: `aistock-agent-py/src/aistock_agent/prompts/workers/light_predict.py`
- Delete: `aistock-agent-py/tests/unit/test_light_predictor.py`
- Modify: `aistock-agent-py/src/aistock_agent/schemas/prediction.py`（删 `LightForecast`）
- Modify: `aistock-agent-py/src/aistock_agent/services/scheduler.py`（删两 job 与 `_run_light_predict_task`）
- Modify: `aistock-agent-py/src/aistock_agent/config.py`（删两个 cron 字段）
- Modify: `aistock-agent-py/src/aistock_agent/services/data_client.py`（删三个方法）
- Modify: `aistock-agent-py/src/aistock_agent/iterate/replay_layer.py`（删三项隔离登记）
- Modify: `aistock-agent-py/tests/unit/test_scheduler.py`（job 计数/列表断言回退）

**重要边界（不得误删）：**
- `predict_stock`（个股预测/对话预测）与其 prompts、`schemas/prediction.py` 中除 `LightForecast` 外的类型**保持不动**
- `query_cached_morning_forecast` / `morning_forecast`（晨报）**保持不动**

- [ ] **Step 1: 定位引用**

```powershell
cd d:\aistock\aistock-agent-py; rg -n "light_predict|LightForecast" src tests
```

Expected: 逐条确认为预判专属（`light_predictor`、`prompts/workers/light_predict`、`LightForecast`、scheduler 两 job、config 两 cron、data_client 三方法、replay_layer 三登记、test_light_predictor、test_scheduler 计数）。`adapters.py:137-154` 的注释提到 light_predict 仅为说明文字，**可保留**（不改逻辑）。

- [ ] **Step 2: 删除文件与代码**

- 删除 `src/aistock_agent/services/light_predictor.py`、`src/aistock_agent/prompts/workers/light_predict.py`、`tests/unit/test_light_predictor.py`
- `schemas/prediction.py`：删除 `LightForecast` 类定义；若某处 import 它（如 `light_predictor`）已随文件删除
- `services/scheduler.py`：删除 `light_predict_midday`/`light_predict_close` 两个 `add_job` 及其 `_run_light_predict_task` 函数；保留其余 job
- `config.py`：删除 `scheduler_light_predict_midday_cron`、`scheduler_light_predict_close_cron`
- `services/data_client.py`：删除 `list_light_predict_targets`、`set_event_forecast`、`set_judgement_forecast` 三个方法
- `iterate/replay_layer.py`：删除 `"NodeApiClient.list_light_predict_targets"`、`"NodeApiClient.set_event_forecast"`、`"NodeApiClient.set_judgement_forecast"` 三行及其专属注释

- [ ] **Step 3: 回退测试断言**

`tests/unit/test_scheduler.py`：
- job 数量/列表断言：删除 `light_predict_midday`/`light_predict_close` 期望项；`from_crontab` 计数断言减 2（例如原 18 → 16）
- 若存在 timezone 用例的 job 计数断言，按同上调整

```powershell
cd d:\aistock\aistock-agent-py; rg -n "light_predict|16|18" tests/unit/test_scheduler.py
```

Expected: 输出中不再有 `light_predict`；计数断言为回退后的值

- [ ] **Step 4: 验证**

```powershell
cd d:\aistock\aistock-agent-py; rg -n "light_predict|LightForecast" src tests
```

Expected: **无输出**（`adapters.py` 若含 "light_predict" 字样注释，需一并改写为不含该词的表述，确保 grep 干净）

```powershell
cd d:\aistock\aistock-agent-py; $env:PYTHONPATH="src"; .\.venv311\Scripts\python.exe -m pytest tests/unit/test_scheduler.py tests/unit/test_insight_report.py -q
```

Expected: 全部通过

- [ ] **Step 5: 重启验证 scheduler**

```powershell
cd d:\aistock\aistock-agent-py; $env:PYTHONPATH="src"; .\.venv311\Scripts\python.exe -m uvicorn aistock_agent.main:app --host 0.0.0.0 --port 8000
```

Expected: `scheduler_started` 的 `jobs` 列表中**不再出现** `light_predict_midday`/`light_predict_close`（其余 job 保持 16 个）

- [ ] **Step 6: 提交**

```powershell
cd d:\aistock\aistock-agent-py; git add -A src tests; git commit -m "refactor(insight): 彻底移除轻量预判任务（scheduler/提示词/schema/回写方法/隔离登记）"
```

---

### Task 5: 前端详情页精简 + 报告下载适配

**Files:**
- Create: `aistock-app-frontend/src/shared/utils/downloadInsightReport.ts`
- Modify: `aistock-app-frontend/src/shared/api/modules/stockTrace.ts`（新增 `reportUrl(eventId)`，并删除 `forecast` 字段——与 Task 7 同步执行亦可）
- Modify: `aistock-app-frontend/src/modules/favorites/pages/insight-detail-move.vue`（模板 + script + 样式精简）
- Test: `aistock-app-frontend/src/shared/utils/downloadInsightReport.spec.ts`（新增）

**Interfaces:**
- Consumes: `stockTraceApi.get(eventId)` / `getAnalysis(eventId)`（已存在）；`API_BASE_URL`（`@/shared/utils/constants`）；`uni` 全局
- Produces:
  - `buildInsightReportUrl(eventId: string): string`
  - `downloadInsightReport(eventId: string): Promise<void>`（H5 走 fetch+Blob 下载；App 走 `uni.downloadFile` + `uni.openDocument`；409 → 抛 `Error('该异动暂无完整归因')`）
  - 详情页一句话主因：`primaryCause.verdict` → 回退 `detail.primary_cause` → 回退"归因中/原因暂不可用"

- [ ] **Step 1: 写失败测试**

创建 `src/shared/utils/downloadInsightReport.spec.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildInsightReportUrl } from './downloadInsightReport'

describe('downloadInsightReport URL 构造', () => {
  beforeEach(() => {
    vi.stubGlobal('uni', { getStorageSync: vi.fn(() => 'test-token') })
  })

  it('拼接 report.pdf 路径并编码 eventId', () => {
    const url = buildInsightReportUrl('mv:003018:2026-09-04:1788485647932:up')
    expect(url).toContain('/api/cn/favorites/movements/')
    expect(url).toContain('/report.pdf')
    expect(url).toContain(encodeURIComponent('mv:003018:2026-09-04:1788485647932:up'))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
cd d:\aistock\aistock-app-frontend; npx vitest run src/shared/utils/downloadInsightReport.spec.ts
```

Expected: FAIL（`Failed to resolve import './downloadInsightReport'`）。

若 vitest 白名单（`vitest.config.ts`）未收录该 spec，先在其 allowlist 中加入 `src/shared/utils/downloadInsightReport.spec.ts` 后重跑。

- [ ] **Step 3: 实现下载工具**

创建 `src/shared/utils/downloadInsightReport.ts`：

```ts
/**
 * 完整洞察报告 PDF 下载（2026-09-13）。
 * H5：fetch(带 JWT) → Blob → a[download]；App：uni.downloadFile + uni.openDocument。
 * 备注：报告由 app-api 组装数据并调用 agent-py 实时渲染，无落盘。
 */
import { API_BASE_URL } from '@/shared/utils/constants'

/** 报告端点 URL（H5 fetch / App downloadFile 共用） */
export function buildInsightReportUrl(eventId: string): string {
  const base = API_BASE_URL.replace(/\/$/, '')
  return `${base}/api/cn/favorites/movements/${encodeURIComponent(eventId)}/report.pdf`
}

function authHeader(): Record<string, string> {
  const token = uni.getStorageSync('token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** H5：带鉴权拉取 PDF 并触发浏览器下载 */
async function downloadOnH5(eventId: string): Promise<void> {
  const res = await fetch(buildInsightReportUrl(eventId), { headers: authHeader() })
  if (res.status === 409) throw new Error('该异动暂无完整归因')
  if (!res.ok) throw new Error('报告生成失败，请重试')
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = `insight-report-${eventId.split(':')[1] ?? 'report'}.pdf`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(objectUrl)
}

/** App：uni.downloadFile（带鉴权）后调用系统阅读器打开 */
function downloadOnApp(eventId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    uni.downloadFile({
      url: buildInsightReportUrl(eventId),
      header: authHeader(),
      success: (res) => {
        if (res.statusCode === 409) { reject(new Error('该异动暂无完整归因')); return }
        if (res.statusCode !== 200) { reject(new Error('报告生成失败，请重试')); return }
        uni.openDocument({
          filePath: res.tempFilePath,
          fileType: 'pdf',
          showMenu: true,
          success: () => resolve(),
          fail: () => reject(new Error('请先安装 PDF 阅读器，或使用其他应用打开')),
        })
      },
      fail: () => reject(new Error('报告生成失败，请重试')),
    })
  })
}

/** 统一下载入口：按平台分流 */
export async function downloadInsightReport(eventId: string): Promise<void> {
  // #ifdef H5
  await downloadOnH5(eventId)
  return
  // #endif
  // #ifndef H5
  await downloadOnApp(eventId)
  // #endif
}
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
cd d:\aistock\aistock-app-frontend; npx vitest run src/shared/utils/downloadInsightReport.spec.ts
```

Expected: 1 test passed

- [ ] **Step 5: 精简详情页模板**

`insight-detail-move.vue`：

1）删除 `<InsightCard ... />`（洞见卡整块，59-69 行）
2）删除"归因结果（completed）"整块（88-171 行：主因横幅 + 聚焦因果链 + 候选归因 + 未解问题 + 证据清单）
3）删除"预判区"整块（173-201 行）
4）在"归因状态"块（71-86 行，保留）与"归因完成但结果不可用"块（203-210 行，保留）之后，插入：

```html
      <!-- ===== 一句话主因（精简版详情，完整归因见 PDF 报告） ===== -->
      <view v-if="oneLineCause" class="section main-cause-simple">
        <view class="main-title-row">
          <text class="section-title">归因主因</text>
          <view class="title-right">
            <text v-if="confidenceLevel" class="badge is-gold">{{ confidenceText(confidenceLevel) }}</text>
          </view>
        </view>
        <text class="one-line-text">{{ oneLineCause }}</text>
      </view>

      <!-- ===== 完整报告下载（仅 completed 且有有效归因时可用） ===== -->
      <view
        v-if="canDownloadReport"
        :class="['report-btn', { 'is-busy': reportBusy }]"
        @tap="onDownloadReport"
      >
        <text class="report-btn-text">{{ reportBusy ? '正在生成报告…' : '生成完整洞察报告 PDF' }}</text>
      </view>
      <text v-else-if="analysis?.processing_status === 'completed'" class="report-hint">
        完整报告将在归因完成后可下载
      </text>
```

- [ ] **Step 6: 精简详情页 script**

`insight-detail-move.vue` script 部分：

1）替换 import 行为：

```ts
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { stockTraceApi, type StockTraceEvent, type StockTraceAnalysisResponse } from '@/shared/api/modules/stockTrace'
import SubPageCard2 from '@/shared/components/SubPageCard2.vue'
import { downloadInsightReport } from '@/shared/utils/downloadInsightReport'
```

（删除 `InsightCard`、`ForecastSlotPayload`、`parseForecastSlot`、`TraceChain`、`TraceEvidence` 的 import）

2）删除以下计算属性/函数整块：`eviOpen`、`allCandidates`、`primaryChains`、`evidenceList`、`primaryCause`、`candidateCards`、`unresolvedQuestions`、`forecastSlot`、`slotLabel`、`insightData`、`evidenceCountLabel`、`isConfirmed`、`layerText`、`statusText`、`stageText`、`kindText`、`evidenceExcerpt`、`fmtAmount`

3）新增：

```ts
/** 一句话主因：优先 artifact 主因候选 verdict → 详情 primary_cause；无结论返回空串 */
const oneLineCause = computed<string>(() => {
  const verdict = artifact.value?.artifactJson.candidates
    ?.find((c) => c.candidateId === artifact.value?.artifactJson.chains
      ?.find((ch) => ch.chainId === artifact.value?.artifactJson.primary_chain_id)?.candidateId)?.verdict
  return String(verdict ?? detail.value?.primary_cause ?? '').trim()
})

/** 置信度等级（高/中/低） */
const confidenceLevel = computed<string>(() => {
  const conf = artifact.value?.artifactJson.confidence
  if (!conf) return ''
  return conf.level ?? (conf.score != null && conf.score >= 0.7 ? 'high' : conf.score != null && conf.score >= 0.5 ? 'medium' : 'low')
})

/** 报告可下载：归因已完成且存在有效 artifact */
const canDownloadReport = computed(() => analysis.value?.processing_status === 'completed' && !!artifact.value)

const reportBusy = ref(false)
async function onDownloadReport(): Promise<void> {
  if (reportBusy.value || !detail.value) return
  const eventId = detail.value.event_id
  if (!eventId) return
  reportBusy.value = true
  try {
    await downloadInsightReport(eventId)
  } catch (err) {
    uni.showToast({ title: (err as Error).message || '报告生成失败，请重试', icon: 'none' })
  } finally {
    reportBusy.value = false
  }
}
```

（`confidenceText`、`severityText`、`fmtPrice`、`fmtPercent`、`fmtTime`、`trendClass` 保留；`confidenceText` 供徽标使用）

- [ ] **Step 7: 精简样式**

删除已无引用的样式块：`/* ===== 主因：结论横幅（含置信度）+ 聚焦因果链 ===== */`、`/* ===== 候选解释：卡片列表 ===== */`、`/* ===== 未解问题 ===== */`、`/* ===== 预判区：conditions 卡片列表 ===== */`、`/* ===== 证据清单 ===== */`、`.insight-in-page`；新增：

```scss
/* ===== 一句话主因（精简版） ===== */
.main-cause-simple {
  display: flex; flex-direction: column; gap: $s-2;
}
.one-line-text {
  font-size: $font-size-base; color: $ink; line-height: 1.6;
}

/* ===== 完整报告下载按钮 ===== */
.report-btn {
  margin-top: $s-4; padding: $s-3; border-radius: $r-md;
  background: $primary; text-align: center;
  /* #ifdef H5 */
  cursor: pointer;
  /* #endif */
}
.report-btn.is-busy { background: $line; }
.report-btn-text { font-size: $font-size-base; color: #ffffff; font-weight: 600; }
.report-hint { display: block; margin-top: $s-3; font-size: $font-size-xs; color: $ink-soft; text-align: center; }
```

- [ ] **Step 8: 验证**

```powershell
cd d:\aistock\aistock-app-frontend; npx vitest run src/shared/utils/downloadInsightReport.spec.ts
```

Expected: 通过；再用 IDE 诊断确认 `insight-detail-move.vue` 0 error。

- [ ] **Step 9: 提交**

```powershell
cd d:\aistock\aistock-app-frontend; git add src/shared/utils/downloadInsightReport.ts src/shared/utils/downloadInsightReport.spec.ts src/modules/favorites/pages/insight-detail-move.vue vitest.config.ts; git commit -m "feat(insight-detail): 详情页精简为报价头+一句话主因+报告下载按钮"
```

---

### Task 6: 自选股异动页卡片下端"洞察报告"按钮

**Files:**
- Modify: `aistock-app-frontend/src/shared/components/InsightAlertCard.vue`（新增 `reportable` prop 与 `report` emit + footer 按钮）
- Modify: `aistock-app-frontend/src/modules/favorites/pages/monitor.vue`（传入 `reportable` 并处理 `@report`）
- Test: `aistock-app-frontend/src/shared/components/InsightAlertCard.spec.ts`（新增或更新）

**Interfaces:**
- Consumes: `downloadInsightReport(eventId)`（Task 5）、`AlertItem.eventId`/`completed` 状态
- Produces: `InsightAlertCard` 新 props `reportable?: boolean`；新 emit `report`（无参，父组件据 `alert.eventId` 下载）

- [ ] **Step 1: 写失败测试**

创建/更新 `src/shared/components/InsightAlertCard.spec.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import InsightAlertCard from './InsightAlertCard.vue'

const baseProps = { name: '金富科技', symbol: '003018', direction: 'up' as const, message: '主因：液冷服务器概念板块联动', type: '上涨异动', time: '09-04 09:34' }

describe('InsightAlertCard 洞察报告按钮', () => {
  it('reportable=true 时渲染报告按钮并 emit report（不冒泡触发卡片点击）', async () => {
    const onClick = vi.fn()
    const wrapper = mount(InsightAlertCard, { props: { ...baseProps, reportable: true, onClick } })
    const btn = wrapper.find('.insight-alert-card__report')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(wrapper.emitted('report')).toBeTruthy()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('reportable 缺省时不渲染报告按钮', () => {
    const wrapper = mount(InsightAlertCard, { props: baseProps })
    expect(wrapper.find('.insight-alert-card__report').exists()).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
cd d:\aistock\aistock-app-frontend; npx vitest run src/shared/components/InsightAlertCard.spec.ts
```

Expected: FAIL（按钮不存在）。若 vitest 白名单未收录该 spec，先登记后重跑。

- [ ] **Step 3: 组件加按钮**

`InsightAlertCard.vue`：

1）模板 footer 内（`insight-alert-card__footer` 之后、`body` 结束前）新增：

```html
      <view v-if="reportable" class="insight-alert-card__report" @tap.stop="emit('report')">
        <text class="insight-alert-card__report-text">洞察报告</text>
      </view>
```

2）script：`Props` 增加 `reportable?: boolean`；`withDefaults` 增加 `reportable: false`；新增 `const emit = defineEmits<{ (e: 'report'): void }>()`

3）样式追加：

```scss
.insight-alert-card__report {
  margin-top: 12rpx; padding: 10rpx 0; border-radius: 12rpx;
  background: rgba(255, 255, 255, 0.16); text-align: center;
  /* #ifdef H5 */
  cursor: pointer;
  /* #endif */
}
.insight-alert-card__report-text { font-size: 24rpx; color: #ffffff; }
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
cd d:\aistock\aistock-app-frontend; npx vitest run src/shared/components/InsightAlertCard.spec.ts
```

Expected: 2 passed

- [ ] **Step 5: monitor.vue 接入**

模板 `InsightAlertCard` 处增加 `:reportable="alert.analysisStatus === 'completed'"` 与 `@report="onReport(alert.eventId)"`（`AlertItem` 增加可选 `analysisStatus?: string`，在 `movementToAlertItem` 中赋值 `m.analysis_status`）。

script 新增：

```ts
import { downloadInsightReport } from '@/shared/utils/downloadInsightReport'

const reportBusy = ref(false)
async function onReport(eventId: string): Promise<void> {
  if (reportBusy.value || !eventId) return
  reportBusy.value = true
  try {
    await downloadInsightReport(eventId)
  } catch (err) {
    uni.showToast({ title: (err as Error).message || '报告生成失败，请重试', icon: 'none' })
  } finally {
    reportBusy.value = false
  }
}
```

- [ ] **Step 6: 验证**

```powershell
cd d:\aistock\aistock-app-frontend; npx vitest run src/shared/components/InsightAlertCard.spec.ts src/modules/favorites/components/AlertContent.spec.ts
```

Expected: 全部通过（若 `AlertContent.spec` 断言 ListCell 数量，不受影响）

- [ ] **Step 7: 提交**

```powershell
cd d:\aistock\aistock-app-frontend; git add src/shared/components/InsightAlertCard.vue src/shared/components/InsightAlertCard.spec.ts src/modules/favorites/pages/monitor.vue; git commit -m "feat(monitor): 异动卡片下端新增洞察报告下载按钮"
```

---

### Task 7: 前端预判清理（insightCards / insight.vue / 类型 / spec）

**Files:**
- Modify: `aistock-app-frontend/src/modules/favorites/components/insightCards.ts`
- Modify: `aistock-app-frontend/src/modules/favorites/components/insightCards.spec.ts`
- Modify: `aistock-app-frontend/src/modules/favorites/pages/insight.vue`
- Modify: `aistock-app-frontend/src/shared/api/modules/stockTrace.ts`
- Modify: `aistock-app-frontend/src/modules/favorites/AGENTS.md`（文档，Task 8 统一亦可）

**Interfaces:**
- Consumes: 无
- Produces: `insightCards.ts` 不再导出 `ForecastSlotPayload`/`parseForecastSlot`；`StockTraceEvent` 无 `forecast` 字段；`insight.vue` 列表项无 `forecastSummary`

- [ ] **Step 1: 写/改失败测试**

`insightCards.spec.ts`：删除 `parseForecastSlot` 的所有用例与 import；若 `buildInsightCards` 用例断言 `hasForecast`/`forecast`，改为断言其余字段（或按 Step 3 结论删除无引用函数后再调整）。

```powershell
cd d:\aistock\aistock-app-frontend; rg -n "parseForecastSlot|ForecastSlotPayload|hasForecast|forecast" src/modules/favorites src/shared/api/modules/stockTrace.ts
```

Expected: 输出即待清理清单（`insightCards.ts`、`insightCards.spec.ts`、`insight.vue`、`stockTrace.ts`；`insight-detail-move.vue` 已在 Task 5 清理）

- [ ] **Step 2: 运行测试确认失败**

```powershell
cd d:\aistock\aistock-app-frontend; npx vitest run src/modules/favorites/components/insightCards.spec.ts
```

Expected: FAIL（`parseForecastSlot` 相关用例在移除导出后引用失败）

- [ ] **Step 3: 删除预判相关导出与用法**

- `insightCards.ts`：删除 `ForecastSlotPayload`、`parseForecastSlot`、内部 `parseForecast`、`hasForecast` 相关；`InsightStockCard` 删除 `hasForecast`/`forecast` 字段；`cardInTab` 删除 `'forecast'` 分支（签名收窄为 `'all' | 'trace'`）；`buildInsightCards` 删除 forecast 解析逻辑；`IntelEvent.forecast` 字段删除
  - 若 `buildInsightCards`/`InsightStockCard`/`cardInTab` 经 `rg` 确认已无生产引用（首页洞察块已改 ListCell），可一并删除这三个导出与其 spec 用例；**若仍被引用则仅做字段裁剪**
- `insight.vue`：删除 `forecastSummary` 字段计算与模板中的预判摘要行；`extractForecastSummary` 函数删除
- `stockTrace.ts`：删除 `StockTraceEvent.forecast` 字段与 `StockTraceAnalysisResponse` 中相关项（若有）

- [ ] **Step 4: 运行测试确认通过**

```powershell
cd d:\aistock\aistock-app-frontend; npx vitest run src/modules/favorites/components/insightCards.spec.ts src/modules/favorites/components/AlertContent.spec.ts src/shared/utils/downloadInsightReport.spec.ts
```

Expected: 全部通过；`rg -n "parseForecastSlot|ForecastSlotPayload|hasForecast" src` 无输出（spec 亦无）

- [ ] **Step 5: 提交**

```powershell
cd d:\aistock\aistock-app-frontend; git add src/modules/favorites src/shared/api/modules/stockTrace.ts; git commit -m "refactor(insight): 前端移除预判字段与展示（insightCards/洞察列表/类型）"
```

---

### Task 8: 文档同步 + 端到端验收

**Files:**
- Modify: `aistock-app-api/src/modules/stock-trace/AGENTS.md`、`aistock-app-api/src/modules/crawler/AGENTS.md`（若涉及）、`aistock-app-api/changelog-pending.md`
- Modify: `aistock-app-frontend/src/modules/favorites/AGENTS.md`、`aistock-app-frontend/changelog-pending.md`
- Modify: `aistock-agent-py/docs/`（若存在模块说明）或 `aistock-agent-py/changelog-pending.md`
- Modify: `c:\Users\Lia\.trae-cn\memory\projects\-d-aistock\project_memory.md`

**Interfaces:** 无（文档）

- [ ] **Step 1: 更新各仓文档**

- app-api `stock-trace/AGENTS.md`：追加"2026-09-13 完整洞察报告 PDF + 预判彻底移除（迁移 019，保留 is_limit_up）"小节，写明端点 `GET /api/cn/favorites/movements/:eventId/report.pdf`（401/404/409/200/502）与 agent-py `POST /api/agent/insight-report/render`
- app-api `changelog-pending.md`：追加本次变更条目（PDF 端点、迁移 019、预判移除）
- frontend `favorites/AGENTS.md` + `changelog-pending.md`：详情页精简、报告下载按钮（详情页底部 + 异动卡片）、预判移除
- agent-py `changelog-pending.md`：新增 `insight_report` 服务与端点；删除 light_predict 任务/提示词/schema
- `project_memory.md`：记录决策（彻底移除预判、PDF 由 agent-py 渲染、报告端点契约、无归因 409）与教训（删列必须同时删 ensureSchema 幂等 ALTER）

- [ ] **Step 2: 端到端验收（H5，mxfff 已登录）**

按 spec §7.2 逐项确认并记录证据：

1. 洞察详情页仅有：报价头 + 一句话主因（含置信度）+ 报告按钮；无预判区/因果链/候选/证据清单
2. 自选股异动页卡片下端出现"洞察报告"按钮；点击 → 下载 PDF；打开核对章节（事件事实/主因结论/五层候选/六阶段因果链/证据清单/未解问题/免责声明）与中文显示
3. 对一个 `unavailable` 事件：详情页按钮不出现；直接请求 `report.pdf` → 409
4. DB 校验：`SELECT column_name FROM information_schema.columns WHERE table_name IN ('stock_trace_events','stock_info_judgements') AND column_name='forecast'` → 0 行；`is_limit_up` 仍存在
5. agent-py 重启后 `scheduler_started` 的 jobs 不含 `light_predict_*`
6. 前端全量检查：`rg -n "parseForecastSlot|ForecastSlotPayload|hasForecast|forecast" src/modules/favorites src/shared/api/modules/stockTrace.ts` 无预判残留

- [ ] **Step 3: 提交**

```powershell
cd d:\aistock\aistock-app-api; git add src/modules/stock-trace/AGENTS.md changelog-pending.md; git commit -m "docs(insight-report): 记录报告 PDF 端点与预判移除"
cd d:\aistock\aistock-app-frontend; git add src/modules/favorites/AGENTS.md changelog-pending.md; git commit -m "docs(insight-detail): 记录详情页精简与报告入口"
cd d:\aistock\aistock-agent-py; git add changelog-pending.md; git commit -m "docs(insight-report): 记录报告渲染服务与预判移除"
```

---

## Self-Review

**1. Spec coverage**
- spec §3 详情页精简 → Task 5（模板/script/样式）
- spec §4.1 agent-py 预判移除 → Task 4
- spec §4.2 app-api 预判移除（含迁移 019、ensureSchema ALTER）→ Task 3
- spec §4.3 frontend 预判移除 → Task 7（+ Task 5 移除详情页预判）
- spec §5 PDF 数据流/端点/章节/JSON 契约 → Task 1（渲染+章节）与 Task 2（数据组装+端点）
- spec §6 入口与下载适配 → Task 5（工具）+ Task 6（卡片按钮）
- spec §7 测试与验收 → 各任务测试步骤 + Task 8
- spec §8 风险（ensureSchema 幂等 ALTER）→ Task 3 Step 4 明确要求；中文 CID 字体 → Task 1 Step 4
- spec §9 实施顺序 → Task 1→2→3→4→5→6→7→8 顺序一致

**2. Placeholder scan**：无 TODO/TBD；所有代码步骤含完整代码；删除类步骤给出精确清单 + grep 验证命令。

**3. Type consistency**
- `build_report_sections` / `render_insight_report`：Task 1 定义、Task 2 输入契约（`event`/`attribution` 字段名）一致
- `InsightReportService.buildReportData/renderPdf`：Task 2 内定义与调用一致
- `downloadInsightReport` / `buildInsightReportUrl`：Task 5 定义，Task 6 复用
- 端点路径一致：app-api `/api/cn/favorites/movements/:eventId/report.pdf`；agent-py `/api/agent/insight-report/render`
- `InsightAlertCard` 新增 `reportable` prop 与 `report` emit：Task 6 内组件与 monitor 用法一致
