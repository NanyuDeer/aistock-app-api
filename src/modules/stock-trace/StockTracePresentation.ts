import type { StockTraceArtifact, StockTraceResult } from './types';

export const TRACE_REASON_UNAVAILABLE = '原因暂不可用';

export interface TraceUnavailableView {
    code: 'reason_unavailable';
    message: typeof TRACE_REASON_UNAVAILABLE;
    triggerFacts: Record<string, unknown>;
}

export interface StockTraceAnalysisPresentation {
    processingStatus: 'processing' | 'completed' | 'unavailable' | 'failed';
    artifact: StockTraceArtifact | null;
    unavailable?: TraceUnavailableView;
}

const TRIGGER_FACT_FIELDS = [
    'event_id', 'trigger_revision', 'symbol', 'stock_name', 'event_type', 'direction',
    'triggered_at', 'window_start_at', 'window_end_at', 'latest_price', 'previous_close',
    'change_pct', 'threshold_pct', 'severity', 'rule_version', 'fact_status',
] as const;

function triggerFacts(event: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        TRIGGER_FACT_FIELDS
            .filter((field) => event[field] !== undefined)
            .map((field) => [field, event[field]]),
    );
}

export function presentStockTraceAnalysis(
    event: Record<string, unknown>,
    artifact: StockTraceArtifact | null,
    latestResult: StockTraceResult | null,
    jobStatus?: string | null,
): StockTraceAnalysisPresentation {
    if (artifact) return { processingStatus: 'completed', artifact };

    // unavailable 优先于 failed：有 rejected/failed result 表示归因跑完并给出"无结论"结论，
    // 信息量高于 job 死信；与列表 SQL 的派生顺序（artifact→unavailable→dead_letter→processing）保持一致。
    if (latestResult?.validationStatus === 'rejected' || latestResult?.processingStatus === 'failed') {
        return {
            processingStatus: 'unavailable',
            artifact: null,
            unavailable: {
                code: 'reason_unavailable',
                message: TRACE_REASON_UNAVAILABLE,
                triggerFacts: triggerFacts(event),
            },
        };
    }
    // 当前版本归因 job 死信（无 artifact/result）→ 归因失败
    if (jobStatus === 'dead_letter') {
        return { processingStatus: 'failed', artifact: null };
    }
    return { processingStatus: 'processing', artifact: null };
}
