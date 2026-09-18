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
