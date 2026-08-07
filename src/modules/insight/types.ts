// src/modules/insight/types.ts
export interface InsightSourceRow {
    source_id: string;
    source_url: string;
    article_id: string;
    trade_date: string;
    title: string;
    keywords: string[];
    content: string;
    mentioned_symbols: MentionedSymbol[];
    published_at: string;
    fetched_at: string;
    content_hash: string;
    parser_version: string;
}

export interface MentionedSymbol {
    symbol: string;   // 6 位代码
    name: string;
    change_pct?: string;
}

export interface InsightEventRow {
    event_id: string;
    symbol: string;
    stock_name: string;
    trade_date: string;
    event_type: 'limit_up_radar';
    direction: 'up' | 'down';
    source_id: string;
    status: 'active' | 'superseded';
    created_at: string;
}

export interface InsightJobRow {
    job_id: string;
    event_id: string;
    analysis_version: string;
    status: 'queued' | 'published' | 'processing' | 'completed' | 'failed' | 'dead_letter';
    attempt_count: number;
    last_error_code?: string;
    stream_message_id?: string;
}

export interface InsightResultRow {
    result_id: string;
    event_id: string;
    analysis_version: string;
    attribution_status: 'confirmed' | 'unconfirmed';
    confidence: 'high' | 'medium' | 'low' | 'unconfirmed';
    primary_driver: Record<string, unknown>;
    secondary_drivers: unknown[];
    display_report: Record<string, unknown>;
    podcast_brief: string;
    validation_status: 'llm' | 'rule_fallback';
    model_provider: string;
    created_at: string;
}
