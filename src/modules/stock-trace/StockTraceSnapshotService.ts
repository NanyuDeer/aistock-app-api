import { createHash, randomUUID } from 'node:crypto';
import pool from '../../core/db';
import { ClsStockNewsService } from '../monitor/ClsStockNewsService';
import { StockInfoService } from '../crawler/StockInfoService';
import { getThsDaily, getThsIndex } from '../quote/TushareService';
import { getCnIndexQuoteFacts } from '../quote/indexController';
import { shanghaiDateStr, shanghaiDateYyyymmdd } from '../../shared/utils/shanghaiTime';
import {
    type DataReadiness,
    type SnapshotStage,
    type SourceLevel,
    type StockSourceRecord,
    type StockTraceSnapshot,
    type TriggerEvent,
} from './types';

const SNAPSHOT_TTL_DAYS = 30;
const EXCERPT_LIMIT = 600;
const ENRICHED_COLLECTION_TIMEOUT_MS = 25_000;
// 事件库（Python 侧）读取超时：远小于 enriched 采集预算 25s，失败即降级直采
const EVENT_STORE_TIMEOUT_MS = 5_000;
const COLLECTOR_VERSIONS = {
    snapshot: 'stock-trace-snapshot-v1',
    company: 'cls-and-stock-info-v1',
    sector: 'ths-board-v1',
    market: 'tencent-index-v1',
};

let schemaPromise: Promise<void> | null = null;

function stableJson(value: unknown): string {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export function stockTraceStableHash(value: unknown): string {
    return createHash('sha256').update(stableJson(value)).digest('hex');
}

function hash(value: unknown): string {
    return stockTraceStableHash(value);
}

function withinEnrichedBudget<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('collector_timeout')), ENRICHED_COLLECTION_TIMEOUT_MS);
        void operation.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error: unknown) => { clearTimeout(timer); reject(error); },
        );
    });
}

function excerpt(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_LIMIT);
}

function asDate(value: unknown, fallback: Date): Date {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === 'string') {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return fallback;
}

function sourceRecord(input: Omit<StockSourceRecord, 'contentHash'>): StockSourceRecord {
    return { ...input, contentHash: hash({
        source_id: input.sourceId,
        provider: input.provider,
        title: input.title,
        excerpt: input.contentExcerpt,
        url: input.canonicalUrl || '',
        source_ref: input.sourceRef || '',
    payload: input.payload,
    }) };
}

interface SnapshotRow {
    snapshot_id: string;
    event_id: string;
    trigger_revision: number;
    snapshot_stage: SnapshotStage;
    source_revision_hash: string;
    trigger_event_json: Record<string, unknown>;
    missing_fields: string[];
    data_readiness: Record<'company' | 'sector' | 'market', DataReadiness>;
    collector_versions: Record<string, string>;
    captured_at: Date;
    supersedes_snapshot_id: string | null;
}

// ─── 统一事件抓取中台：事件库读取（读库优先、缺库降级，2026-08-12） ───

/** Python 事件库事件（EventRecord，Task 1/6 契约）。 */
interface EventStoreEvent {
    event_id: string;
    title?: string;
    summary?: string;
    url?: string;
    impact_score?: number;
    direction?: string;
    source?: string;
    source_level?: string;
    content_hash?: string;
    scrape_at?: string;
    score_date?: string;
    payload?: Record<string, unknown>;
}

function isEventStoreEvent(value: unknown): value is EventStoreEvent {
    return typeof value === 'object' && value !== null
        && typeof (value as Record<string, unknown>).event_id === 'string';
}

/** 事件库事件 → StockSourceRecord（字段映射按简报 Step 4；contentHash 由 sourceRecord() 自动计算）。 */
function toEventStoreSourceRecord(ev: EventStoreEvent, symbol: string, capturedAt: Date): StockSourceRecord {
    const occurredAt = asDate(ev.scrape_at, capturedAt);
    const summary = typeof ev.summary === 'string' ? ev.summary : '';
    const title = typeof ev.title === 'string' && ev.title ? ev.title : '无标题';
    const sourceLevel: SourceLevel =
        ev.source_level === 'A' || ev.source_level === 'B' || ev.source_level === 'C' || ev.source_level === 'D'
            ? ev.source_level
            : 'C';
    return sourceRecord({
        sourceId: ev.event_id,
        kind: ev.source === 'announcement' ? 'announcement' : 'news',
        provider: typeof ev.source === 'string' && ev.source ? ev.source : 'event_store',
        sourceLevel,
        title,
        contentExcerpt: excerpt(summary.slice(0, 500) || title),
        canonicalUrl: typeof ev.url === 'string' && ev.url ? ev.url : undefined,
        sourceRef: ev.event_id,
        symbol,
        occurredAt,
        capturedAt,
        freshnessSeconds: Math.max(0, Math.floor((capturedAt.getTime() - occurredAt.getTime()) / 1000)),
        payload: ev.payload || {},
    });
}

/**
 * 读取当日事件库证据（stock_trace 证据源优先读事件库）。
 *
 * 调用 Python `GET /api/agent/event/scrape-by-symbol/:symbol?date=当日`
 * （app-api 反代 `/api/agent/*` → Python 等价路径；沿
 * StockTraceTriggerService 的 fetch + X-Internal-Token 先例）。
 * date 用上海时区当日（shanghaiDateStr），与 Node 侧交易日约定一致。
 *
 * 任何失败（未配置 / 网络错 / HTTP 错 / 解析错）或空结果都返回 []，
 * 由调用方降级到原采集路径——绝不抛异常（P0 功能保护）。
 */
export async function loadEventStoreEvidence(symbol: string, capturedAt: Date): Promise<StockSourceRecord[]> {
    const baseUrl = process.env.PYTHON_AGENT_URL || process.env.AGENT_PY_URL || '';
    const token = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || '';
    if (!baseUrl || !token) {
        console.warn('[StockTraceSnapshot] event_store_read_failed, fallback to original collect', {
            symbol,
            reason: 'python url or internal token not configured',
        });
        return [];
    }
    const url = `${baseUrl.replace(/\/+$/, '')}/api/agent/event/scrape-by-symbol/${encodeURIComponent(symbol)}?date=${shanghaiDateStr()}`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'X-Internal-Token': token },
            signal: AbortSignal.timeout(EVENT_STORE_TIMEOUT_MS),
        });
        if (!response.ok) {
            console.warn('[StockTraceSnapshot] event_store_read_failed, fallback to original collect', {
                symbol,
                status: response.status,
            });
            return [];
        }
        const data = (await response.json()) as { events?: unknown };
        const events = Array.isArray(data?.events) ? data.events : [];
        return events
            .filter(isEventStoreEvent)
            .map((ev) => toEventStoreSourceRecord(ev, symbol, capturedAt));
    } catch (err: unknown) {
        console.warn('[StockTraceSnapshot] event_store_read_failed, fallback to original collect', {
            symbol,
            error: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
}

export class StockTraceSnapshotService {
    static async ensureSchema(): Promise<void> {
        if (!schemaPromise) schemaPromise = this.createSchema();
        return schemaPromise;
    }

    private static async createSchema(): Promise<void> {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_trace_snapshots (
                snapshot_id UUID PRIMARY KEY,
                event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
                trigger_revision INTEGER NOT NULL,
                snapshot_stage VARCHAR(12) NOT NULL CHECK (snapshot_stage IN ('initial', 'enriched', 'corrected')),
                source_revision_hash CHAR(64) NOT NULL,
                trigger_event_json JSONB NOT NULL,
                missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
                data_readiness JSONB NOT NULL,
                collector_versions JSONB NOT NULL,
                captured_at TIMESTAMPTZ NOT NULL,
                supersedes_snapshot_id UUID,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (event_id, trigger_revision, snapshot_stage, source_revision_hash)
            )
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_stock_trace_snapshots_event ON stock_trace_snapshots(event_id, trigger_revision, captured_at DESC)');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_trace_source_records (
                source_pk UUID PRIMARY KEY,
                snapshot_id UUID NOT NULL REFERENCES stock_trace_snapshots(snapshot_id),
                source_id VARCHAR(128) NOT NULL,
                kind VARCHAR(24) NOT NULL,
                provider VARCHAR(64) NOT NULL,
                source_level VARCHAR(16) NOT NULL CHECK (source_level IN ('A', 'B', 'C', 'D')),
                title VARCHAR(512) NOT NULL,
                content_excerpt TEXT NOT NULL,
                canonical_url TEXT,
                source_ref VARCHAR(256),
                symbol CHAR(6),
                window_start TIMESTAMPTZ,
                window_end TIMESTAMPTZ,
                occurred_at TIMESTAMPTZ,
                captured_at TIMESTAMPTZ NOT NULL,
                freshness_seconds INTEGER CHECK (freshness_seconds IS NULL OR freshness_seconds >= 0),
                payload JSONB NOT NULL,
                content_hash CHAR(64) NOT NULL,
                object_key VARCHAR(512),
                object_etag VARCHAR(128),
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (snapshot_id, source_id)
            )
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_stock_trace_sources_snapshot_level ON stock_trace_source_records(snapshot_id, source_level)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_stock_trace_sources_hash ON stock_trace_source_records(content_hash)');
    }

    static async captureInitial(event: TriggerEvent): Promise<StockTraceSnapshot> {
        const capturedAt = new Date();
        const trigger = sourceRecord({
            sourceId: `trigger:${event.eventId}:r${event.triggerRevision}`,
            kind: 'trigger_fact', provider: 'stock_trace_detector', sourceLevel: 'A', title: 'Price trigger event',
            contentExcerpt: `Price change ${event.actualValue.toFixed(2)}% crossed ${event.thresholdValue.toFixed(2)}% threshold.`,
            symbol: event.symbol, windowStart: event.windowStartAt, windowEnd: event.windowEndAt, occurredAt: event.triggeredAt, capturedAt,
            payload: { event_id: event.eventId, trigger_revision: event.triggerRevision, direction: event.direction, threshold_pct: event.thresholdValue, actual_change_pct: event.actualValue },
        });
        const quote = sourceRecord({
            sourceId: `quote:${event.eventId}:r${event.triggerRevision}`,
            kind: 'quote_fact', provider: 'tencent_quote', sourceLevel: 'A', title: 'Trigger-time quote fact',
            contentExcerpt: `Latest ${event.latestPrice}; previous close ${event.previousClose}; change ${event.actualValue.toFixed(2)}%.`,
            symbol: event.symbol, windowStart: event.windowStartAt, windowEnd: event.windowEndAt, occurredAt: event.triggeredAt, capturedAt,
            freshnessSeconds: Math.max(0, Math.floor((capturedAt.getTime() - event.triggeredAt.getTime()) / 1000)),
            payload: { latest_price: event.latestPrice, previous_close: event.previousClose, change_pct: event.actualValue },
        });
        return this.persist({
            event, stage: 'initial', capturedAt, sourceRecords: [trigger, quote],
            missingFields: ['company_context', 'sector_context', 'market_context'],
            dataReadiness: { company: 'missing', sector: 'missing', market: 'missing' },
        });
    }

    static async captureCorrected(event: TriggerEvent): Promise<StockTraceSnapshot> {
        const initial = await this.captureInitialForStage(event, 'corrected');
        return initial;
    }

    private static async captureInitialForStage(event: TriggerEvent, stage: 'corrected'): Promise<StockTraceSnapshot> {
        const capturedAt = new Date();
        const trigger = sourceRecord({
            sourceId: `trigger:${event.eventId}:r${event.triggerRevision}`, kind: 'trigger_fact',
            provider: 'stock_trace_detector', sourceLevel: 'A', title: 'Corrected price trigger event',
            contentExcerpt: `Trigger revision ${event.triggerRevision}; price change ${event.actualValue.toFixed(2)}%.`,
            symbol: event.symbol, windowStart: event.windowStartAt, windowEnd: event.windowEndAt, occurredAt: event.triggeredAt, capturedAt,
            payload: { event_id: event.eventId, trigger_revision: event.triggerRevision, direction: event.direction, actual_change_pct: event.actualValue },
        });
        const quote = sourceRecord({
            sourceId: `quote:${event.eventId}:r${event.triggerRevision}`, kind: 'quote_fact', provider: 'tencent_quote',
            sourceLevel: 'A', title: 'Corrected trigger-time quote fact',
            contentExcerpt: `Latest ${event.latestPrice}; previous close ${event.previousClose}; change ${event.actualValue.toFixed(2)}%.`,
            symbol: event.symbol, windowStart: event.windowStartAt, windowEnd: event.windowEndAt, occurredAt: event.triggeredAt, capturedAt,
            payload: { latest_price: event.latestPrice, previous_close: event.previousClose, change_pct: event.actualValue },
        });
        return this.persist({ event, stage, capturedAt, sourceRecords: [trigger, quote],
            missingFields: ['company_context', 'sector_context', 'market_context'],
            dataReadiness: { company: 'missing', sector: 'missing', market: 'missing' } });
    }

    static scheduleEnriched(event: TriggerEvent): void {
        const timer = setTimeout(() => void this.captureEnriched(event).catch((error: unknown) => {
            console.error('[StockTraceSnapshot] enriched capture failed:', error instanceof Error ? error.message : error);
        }), 1_000);
        timer.unref();
    }

    static async captureEnriched(event: TriggerEvent): Promise<StockTraceSnapshot> {
        const capturedAt = new Date();
        const [company, sector, market] = await Promise.allSettled([
            withinEnrichedBudget(this.collectCompanySources(event, capturedAt)),
            withinEnrichedBudget(this.collectSectorSources(event, capturedAt)),
            withinEnrichedBudget(this.collectMarketSources(event, capturedAt)),
        ]);
        const sourceRecords = [
            ...this.baseSources(event, capturedAt),
            ...(company.status === 'fulfilled' ? company.value : []),
            ...(sector.status === 'fulfilled' ? sector.value : []),
            ...(market.status === 'fulfilled' ? market.value : []),
        ];
        const readiness: Record<'company' | 'sector' | 'market', DataReadiness> = {
            company: company.status === 'fulfilled' && company.value.length > 0 ? 'complete' : company.status === 'fulfilled' ? 'partial' : 'missing',
            sector: sector.status === 'fulfilled' && sector.value.length > 0 ? 'complete' : sector.status === 'fulfilled' ? 'partial' : 'missing',
            market: market.status === 'fulfilled' && market.value.length >= 2 ? 'complete' : market.status === 'fulfilled' ? 'partial' : 'missing',
        };
        const missingFields = Object.entries(readiness).filter(([, value]) => value !== 'complete').map(([key]) => `${key}_context`);
        return this.persist({ event, stage: 'enriched', capturedAt, sourceRecords, missingFields, dataReadiness: readiness });
    }

    private static baseSources(event: TriggerEvent, capturedAt: Date): StockSourceRecord[] {
        return [
            sourceRecord({ sourceId: `trigger:${event.eventId}:r${event.triggerRevision}`, kind: 'trigger_fact', provider: 'stock_trace_detector', sourceLevel: 'A', title: 'Price trigger event', contentExcerpt: `Price change ${event.actualValue.toFixed(2)}% crossed ${event.thresholdValue.toFixed(2)}% threshold.`, symbol: event.symbol, windowStart: event.windowStartAt, windowEnd: event.windowEndAt, occurredAt: event.triggeredAt, capturedAt, payload: { event_id: event.eventId, trigger_revision: event.triggerRevision, direction: event.direction, threshold_pct: event.thresholdValue, actual_change_pct: event.actualValue } }),
            sourceRecord({ sourceId: `quote:${event.eventId}:r${event.triggerRevision}`, kind: 'quote_fact', provider: 'tencent_quote', sourceLevel: 'A', title: 'Trigger-time quote fact', contentExcerpt: `Latest ${event.latestPrice}; previous close ${event.previousClose}; change ${event.actualValue.toFixed(2)}%.`, symbol: event.symbol, windowStart: event.windowStartAt, windowEnd: event.windowEndAt, occurredAt: event.triggeredAt, capturedAt, payload: { latest_price: event.latestPrice, previous_close: event.previousClose, change_pct: event.actualValue } }),
        ];
    }

    private static async collectCompanySources(event: TriggerEvent, capturedAt: Date): Promise<StockSourceRecord[]> {
        // 统一事件抓取中台：事件证据优先读事件库，缺库降级到原采集（2026-08-12）
        try {
            const eventStoreRecords = await loadEventStoreEvidence(event.symbol, capturedAt);
            if (eventStoreRecords.length > 0) {
                console.log('[StockTraceSnapshot] event_store_used', {
                    symbol: event.symbol,
                    count: eventStoreRecords.length,
                });
                return eventStoreRecords;
            }
        } catch (error: unknown) {
            console.warn('[StockTraceSnapshot] event_store_read_failed, fallback to original collect', {
                symbol: event.symbol,
                error: String(error),
            });
        }
        // 原采集逻辑保持不变（ClsStockNewsService 个股新闻 + StockInfoService 公告）
        const records: StockSourceRecord[] = [];
        const [newsResult, announcementResult] = await Promise.allSettled([
            ClsStockNewsService.getStockNews(event.symbol, { limit: 5, lastTime: 0 }),
            StockInfoService.queryJudgements({ symbol: event.symbol, info_type: 'announcement', limit: 5, offset: 0 }),
        ]);
        if (newsResult.status === 'fulfilled') {
            for (const item of newsResult.value.items) {
                const occurredAt = asDate(item.time, capturedAt);
                records.push(sourceRecord({ sourceId: `cls:${item.id}`, kind: 'news', provider: 'cls', sourceLevel: 'B', title: item.title || 'CLS news', contentExcerpt: excerpt(item.content), canonicalUrl: item.link || undefined, sourceRef: String(item.id), symbol: event.symbol, occurredAt, capturedAt, freshnessSeconds: Math.max(0, Math.floor((capturedAt.getTime() - occurredAt.getTime()) / 1000)), payload: { title: item.title, time: item.time } }));
            }
        }
        if (announcementResult.status === 'fulfilled') {
            for (const item of announcementResult.value.items) {
                const occurredAt = asDate(item.published_at, capturedAt);
                records.push(sourceRecord({ sourceId: `announcement:${item.id}`, kind: 'announcement', provider: item.source || 'stock_info', sourceLevel: 'B', title: item.title, contentExcerpt: excerpt(item.ai_summary), canonicalUrl: item.url || undefined, sourceRef: item.source_id || String(item.id), symbol: event.symbol, occurredAt, capturedAt, freshnessSeconds: Math.max(0, Math.floor((capturedAt.getTime() - occurredAt.getTime()) / 1000)), payload: { impact: item.ai_impact, horizon: item.ai_horizon, keywords: item.ai_keywords } }));
            }
        }
        return records;
    }

    private static async collectSectorSources(event: TriggerEvent, capturedAt: Date): Promise<StockSourceRecord[]> {
        const mapping = await pool.query<{ sector_name: string }>(`SELECT sector_name FROM stock_concept_mapping WHERE symbol = $1 ORDER BY sector_name LIMIT 3`, [event.symbol]);
        if (mapping.rows.length === 0) return [];
        const indexRows = await getThsIndex('N', 'A');
        const indexByName = new Map(indexRows.map((row) => [row.name, row]));
        const startDate = new Date(capturedAt.getTime() - 10 * 24 * 60 * 60 * 1000);
        const startDateStr = shanghaiDateYyyymmdd(startDate);
        const records: StockSourceRecord[] = [];
        for (const board of mapping.rows) {
            const index = indexByName.get(board.sector_name);
            if (!index) continue;
            try {
                const dailyRows = await getThsDaily(index.ts_code, startDateStr);
                const latest = dailyRows.sort((left, right) => String(right.trade_date).localeCompare(String(left.trade_date)))[0];
                if (!latest) continue;
                records.push(sourceRecord({ sourceId: `ths-board:${index.ts_code}:${latest.trade_date}`, kind: 'sector_fact', provider: 'ths', sourceLevel: 'B', title: board.sector_name, contentExcerpt: `Board latest daily change ${Number(latest.pct_change).toFixed(2)}% on ${latest.trade_date}.`, sourceRef: index.ts_code, symbol: event.symbol, occurredAt: asDate(`${latest.trade_date}T07:00:00Z`, capturedAt), capturedAt, payload: { board_code: index.ts_code, board_name: board.sector_name, board_type: index.type, trade_date: latest.trade_date, pct_change: Number(latest.pct_change), close: Number(latest.close), turnover_rate: Number(latest.turnover_rate) } }));
            } catch {
                continue;
            }
        }
        return records;
    }

    private static async collectMarketSources(event: TriggerEvent, capturedAt: Date): Promise<StockSourceRecord[]> {
        const indexes = await getCnIndexQuoteFacts(['000001', '399001', '399006', '000680', '000688']);
        return indexes.filter((index) => index.latest_price !== null).map((index) => sourceRecord({ sourceId: `market:${index.symbol}:${capturedAt.getTime()}`, kind: 'market_fact', provider: 'tencent_index', sourceLevel: 'A', title: index.name, contentExcerpt: `${index.name} change ${Number(index.change_pct).toFixed(2)}%.`, sourceRef: index.symbol, occurredAt: capturedAt, capturedAt, payload: { ...index } }));
    }

    private static async persist(input: {
        event: TriggerEvent;
        stage: SnapshotStage;
        capturedAt: Date;
        sourceRecords: StockSourceRecord[];
        missingFields: string[];
        dataReadiness: Record<'company' | 'sector' | 'market', DataReadiness>;
    }): Promise<StockTraceSnapshot> {
        await this.ensureSchema();
        const sourceRevisionHash = hash({ trigger_event: input.event, source_hashes: input.sourceRecords.map((source) => source.contentHash).sort(), collector_versions: COLLECTOR_VERSIONS });
        const existing = await pool.query<SnapshotRow>(`SELECT snapshot_id, event_id, trigger_revision, snapshot_stage, source_revision_hash, trigger_event_json, missing_fields, data_readiness, collector_versions, captured_at, supersedes_snapshot_id FROM stock_trace_snapshots WHERE event_id = $1 AND trigger_revision = $2 AND snapshot_stage = $3 AND source_revision_hash = $4 LIMIT 1`, [input.event.eventId, input.event.triggerRevision, input.stage, sourceRevisionHash]);
        if (existing.rows[0]) return this.toSnapshot(existing.rows[0], input.sourceRecords);
        const previous = await pool.query<{ snapshot_id: string }>(`SELECT snapshot_id FROM stock_trace_snapshots WHERE event_id = $1 ORDER BY captured_at DESC LIMIT 1`, [input.event.eventId]);
        const snapshotId = randomUUID();
        await pool.query(`INSERT INTO stock_trace_snapshots (snapshot_id, event_id, trigger_revision, snapshot_stage, source_revision_hash, trigger_event_json, missing_fields, data_readiness, collector_versions, captured_at, supersedes_snapshot_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12)`, [snapshotId, input.event.eventId, input.event.triggerRevision, input.stage, sourceRevisionHash, JSON.stringify(input.event), JSON.stringify(input.missingFields), JSON.stringify(input.dataReadiness), JSON.stringify(COLLECTOR_VERSIONS), input.capturedAt, previous.rows[0]?.snapshot_id || null, new Date(input.capturedAt.getTime() + SNAPSHOT_TTL_DAYS * 24 * 60 * 60 * 1000)]);
        for (const source of input.sourceRecords) {
            await pool.query(`INSERT INTO stock_trace_source_records (source_pk, snapshot_id, source_id, kind, provider, source_level, title, content_excerpt, canonical_url, source_ref, symbol, window_start, window_end, occurred_at, captured_at, freshness_seconds, payload, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18)`, [randomUUID(), snapshotId, source.sourceId, source.kind, source.provider, source.sourceLevel, source.title, source.contentExcerpt, source.canonicalUrl || null, source.sourceRef || null, source.symbol || null, source.windowStart || null, source.windowEnd || null, source.occurredAt || null, source.capturedAt, source.freshnessSeconds ?? null, JSON.stringify(source.payload), source.contentHash]);
        }
        return { snapshotId, eventId: input.event.eventId, triggerRevision: input.event.triggerRevision, snapshotStage: input.stage, sourceRevisionHash, triggerEvent: input.event, missingFields: input.missingFields, dataReadiness: input.dataReadiness, collectorVersions: COLLECTOR_VERSIONS, capturedAt: input.capturedAt, supersedesSnapshotId: previous.rows[0]?.snapshot_id, sourceRecords: input.sourceRecords };
    }

    private static toSnapshot(row: SnapshotRow, sourceRecords: StockSourceRecord[]): StockTraceSnapshot {
        return { snapshotId: row.snapshot_id, eventId: row.event_id, triggerRevision: row.trigger_revision, snapshotStage: row.snapshot_stage, sourceRevisionHash: row.source_revision_hash, triggerEvent: row.trigger_event_json as unknown as TriggerEvent, missingFields: row.missing_fields, dataReadiness: row.data_readiness, collectorVersions: row.collector_versions, capturedAt: row.captured_at, supersedesSnapshotId: row.supersedes_snapshot_id || undefined, sourceRecords };
    }

    static async getSnapshot(snapshotId: string): Promise<Record<string, unknown> | null> {
        await this.ensureSchema();
        const snapshot = await pool.query(`SELECT snapshot_id, event_id, trigger_revision, snapshot_stage, source_revision_hash, trigger_event_json, missing_fields, data_readiness, collector_versions, captured_at, supersedes_snapshot_id FROM stock_trace_snapshots WHERE snapshot_id = $1 LIMIT 1`, [snapshotId]);
        if (!snapshot.rows[0]) return null;
        const sources = await pool.query(`SELECT source_id, kind, provider, source_level, title, content_excerpt, canonical_url, source_ref, symbol, window_start, window_end, occurred_at, captured_at, freshness_seconds, payload, content_hash FROM stock_trace_source_records WHERE snapshot_id = $1 ORDER BY occurred_at NULLS LAST, source_id`, [snapshotId]);
        return { ...snapshot.rows[0], source_records: sources.rows };
    }

    static async getAnalysisContext(eventId: string, triggerRevision: number): Promise<Record<string, unknown> | null> {
        await this.ensureSchema();
        const result = await pool.query<{ snapshot_id: string }>(`
            SELECT snapshot_id FROM stock_trace_snapshots
            WHERE event_id = $1 AND trigger_revision = $2 AND snapshot_stage = 'enriched'
            ORDER BY captured_at DESC LIMIT 1
        `, [eventId, triggerRevision]);
        if (!result.rows[0]) return null;
        const snapshot = await this.getSnapshot(result.rows[0].snapshot_id);
        if (!snapshot) return null;
        // Internal Worker uses the cross-service Snapshot contract, rather than
        // exposing the database-specific trigger_event_json column name.
        return {
            snapshotId: snapshot.snapshot_id,
            eventId: snapshot.event_id,
            triggerRevision: snapshot.trigger_revision,
            snapshotStage: snapshot.snapshot_stage,
            sourceRevisionHash: snapshot.source_revision_hash,
            triggerEvent: snapshot.trigger_event_json,
            missingFields: snapshot.missing_fields,
            dataReadiness: snapshot.data_readiness,
            collectorVersions: snapshot.collector_versions,
            capturedAt: snapshot.captured_at,
            supersedesSnapshotId: snapshot.supersedes_snapshot_id || undefined,
            sourceRecords: snapshot.source_records,
        };
    }
}
