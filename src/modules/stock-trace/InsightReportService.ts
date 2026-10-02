import axios from 'axios';
import type { StockTraceArtifact, StockTraceResult } from './types';

/** agent-py 报告章节端点（内部调用，非出站数据源） */
function agentBaseUrl(): string {
    return (process.env.AGENT_PY_URL || process.env.PYTHON_AGENT_URL || 'http://localhost:8000').replace(/\/$/, '');
}

/** 键值对（事件事实）：`tone` 供前端做涨跌着色，非涨跌项为 null/缺省 */
export interface ReportKvItem {
    label: string;
    value: string;
    tone?: 'up' | 'down' | null;
}

/** 六阶段因果链节点：中文标签用于展示，`*Key` 供前端做中性弱化判定 */
export interface ReportChainStage {
    stage: string;
    stageKey: string;
    claim: string;
    epistemic: string;
    epistemicKey: string;
    status: string;
    statusKey: string;
    evidenceIds: string[];
    evidenceCount: number;
}

/**
 * 报告内容块（判别联合，`type` 区分）。文本已由 agent-py 中文化 + 时间格式化，
 * 前端只按 `type` 选择呈现形式（表格/时间轴/卡片），不做文本解析。
 */
export type ReportBlock =
    | { type: 'kv'; items: ReportKvItem[] }
    | { type: 'verdict'; text: string; badges: Array<{ label: string; value: string }> }
    | { type: 'candidates'; items: Array<{ layer: string; status: string; statusKey: string; verdict: string; evidenceIds: string[] }> }
    | { type: 'chain'; stages: ReportChainStage[] }
    | { type: 'evidence'; items: Array<{ sourceId: string; provider: string; kind: string; occurredAt: string; level: string; title: string; excerpt: string }> }
    | { type: 'list'; items: string[] };

/** 报告章节：`blocks` 为空数组表示该节无数据（前端渲染"暂缺"） */
export interface ReportSection {
    heading: string;
    blocks: ReportBlock[];
}

export interface ReportSections {
    /** 页眉：股票名（代码） · 交易日 */
    header: string;
    sections: ReportSection[];
}

/**
 * 报告数据组装（纯函数，便于单测）：
 * 事件事实（含交易日，供 PDF 页眉）+ 归因结论（主因短语/置信度/归类标签/归因生成时间）
 * + 分层候选（capital 为条件准入层，可能缺席）+ 六阶段因果链 + 证据清单 + 未解问题。
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
                // 页眉交易日：PDF 页眉「股票名（代码） · 交易日」
                tradingDate: event.trading_date,
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
                // 归类标签（渲染层映射为中文）+ 归因生成时间
                primaryLayer: view?.primaryCandidate?.layer ?? null,
                generatedAt: view?.generatedAt ?? null,
                candidates: content.candidates ?? [],
                chains: content.chains ?? [],
                unresolvedQuestions: content.unresolved_questions ?? [],
                evidenceIndex: content.evidence_index ?? [],
            },
        };
    },

    /** 调用 agent-py 构建报告章节；失败抛出（由 controller 转 SSE error 事件 502）。 */
    async fetchSections(data: Record<string, unknown>): Promise<ReportSections> {
        const token = process.env.INTERNAL_API_TOKEN ?? '';
        const response = await axios.post(`${agentBaseUrl()}/api/agent/insight-report/sections`, data, {
            headers: { 'X-Internal-Token': token, 'Content-Type': 'application/json' },
            timeout: 10_000,
        });
        const payload = response.data as Partial<ReportSections> | undefined;
        if (!payload || !Array.isArray(payload.sections)) {
            throw new Error('agent-py 返回的章节结构非法');
        }
        return {
            header: String(payload.header ?? ''),
            // 边界归一化：上游章节缺 blocks / 非数组时补空数组，避免把 undefined 透给前端
            sections: payload.sections.map((section) => ({
                heading: String(section?.heading ?? ''),
                blocks: Array.isArray(section?.blocks) ? section.blocks : [],
            })),
        };
    },
};
