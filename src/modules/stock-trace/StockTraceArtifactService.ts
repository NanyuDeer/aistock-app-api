import { randomUUID } from 'node:crypto';
import pool from '../../core/db';
import { StockTraceAlertOrchestrator } from './StockTraceAlertOrchestrator';
import { StockTraceResultService } from './StockTraceResultService';
import type { MovementViewV2, StockTraceArtifact, StockTraceResult, StockSourceRecord, TraceCandidate } from './types';

const ARTIFACT_TTL_DAYS = 180;
let schemaPromise: Promise<void> | null = null;

interface ArtifactRow {
    artifact_id: string;
    event_id: string;
    snapshot_id: string;
    result_id: string;
    artifact_version: number;
    analysis_version: string;
    artifact_json: Record<string, unknown>;
    movement_view_json: MovementViewV2;
    validation_report_json: { status: 'passed'; errors: string[] };
    is_effective: boolean;
    supersedes_artifact_id: string | null;
    created_at: Date;
    expires_at: Date;
}

function serializeArtifact(row: ArtifactRow): StockTraceArtifact {
    return {
        artifactId: row.artifact_id,
        eventId: row.event_id,
        snapshotId: row.snapshot_id,
        resultId: row.result_id,
        artifactVersion: Number(row.artifact_version),
        analysisVersion: row.analysis_version,
        artifactJson: row.artifact_json,
        movementView: row.movement_view_json,
        validationReport: row.validation_report_json,
        isEffective: row.is_effective,
        supersedesArtifactId: row.supersedes_artifact_id || undefined,
        createdAt: new Date(row.created_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
    };
}

function primaryCandidate(result: StockTraceResult): TraceCandidate | undefined {
    const primaryChain = result.chains.find((chain) => chain.chainId === result.primaryChainId);
    return result.candidates.find((candidate) => candidate.candidateId === primaryChain?.candidateId)
        || result.candidates.find((candidate) => candidate.status === 'supported');
}

function toEvidenceMetadata(source: StockSourceRecord): Record<string, unknown> {
    return {
        source_id: source.sourceId,
        kind: source.kind,
        provider: source.provider,
        source_level: source.sourceLevel,
        title: source.title,
        content_excerpt: source.contentExcerpt,
        canonical_url: source.canonicalUrl,
        occurred_at: source.occurredAt?.toISOString(),
        captured_at: source.capturedAt.toISOString(),
        content_hash: source.contentHash,
    };
}

function isMajorACompanyCause(result: StockTraceResult, sources: StockSourceRecord[]): boolean {
    if (result.attributionStatus !== 'confirmed') return false;
    const primary = primaryCandidate(result);
    if (primary?.layer !== 'company') return false;
    const sourceMap = new Map(sources.map((source) => [source.sourceId, source]));
    return primary.supportingEvidenceIds.some((id) => {
        const source = sourceMap.get(id);
        if (!source || source.sourceLevel !== 'A' || !['announcement', 'news'].includes(source.kind)) return false;
        return source.payload.major === true || source.payload.impact_level === 'major' || source.payload.impact_level === 'material';
    });
}

export function canPublishStockTraceArtifact(result: StockTraceResult | null): result is StockTraceResult {
    return result?.validationStatus === 'passed';
}

export class StockTraceArtifactService {
    static async ensureSchema(): Promise<void> {
        if (!schemaPromise) schemaPromise = this.createSchema();
        return schemaPromise;
    }

    private static async createSchema(): Promise<void> {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_trace_artifacts (
                artifact_id UUID PRIMARY KEY,
                event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
                snapshot_id UUID NOT NULL REFERENCES stock_trace_snapshots(snapshot_id),
                result_id UUID NOT NULL REFERENCES stock_trace_results(result_id),
                artifact_version INTEGER NOT NULL,
                analysis_version VARCHAR(32) NOT NULL,
                artifact_json JSONB NOT NULL,
                movement_view_json JSONB NOT NULL,
                validation_report_json JSONB NOT NULL,
                is_effective BOOLEAN NOT NULL DEFAULT TRUE,
                supersedes_artifact_id UUID REFERENCES stock_trace_artifacts(artifact_id),
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMPTZ NOT NULL,
                UNIQUE(event_id, snapshot_id, analysis_version),
                UNIQUE(event_id, artifact_version)
            )
        `);
        await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_trace_artifacts_effective ON stock_trace_artifacts(event_id) WHERE is_effective');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_stock_trace_artifacts_expiry ON stock_trace_artifacts(expires_at)');
        await pool.query("ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS trigger_reason VARCHAR(64)");
        await pool.query("ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS artifact_id UUID");
        await pool.query("ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS channel VARCHAR(24) NOT NULL DEFAULT 'websocket'");
    }

    static async publishForResult(resultId: string): Promise<StockTraceArtifact | null> {
        await this.ensureSchema();
        const result = await StockTraceResultService.getById(resultId);
        if (!canPublishStockTraceArtifact(result)) return null;
        const sources = await this.loadSources(result.snapshotId);
        const existing = await pool.query<ArtifactRow>(`
            SELECT * FROM stock_trace_artifacts
            WHERE event_id = $1 AND snapshot_id = $2 AND analysis_version = $3
            LIMIT 1
        `, [result.eventId, result.snapshotId, result.analysisVersion]);
        if (existing.rows[0]) return serializeArtifact(existing.rows[0]);

        const artifactId = randomUUID();
        const artifact = this.buildArtifact(artifactId, result, sources);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const duplicate = await client.query<ArtifactRow>(`
                SELECT * FROM stock_trace_artifacts
                WHERE event_id = $1 AND snapshot_id = $2 AND analysis_version = $3
                LIMIT 1 FOR UPDATE
            `, [result.eventId, result.snapshotId, result.analysisVersion]);
            if (duplicate.rows[0]) {
                await client.query('COMMIT');
                return serializeArtifact(duplicate.rows[0]);
            }
            const current = await client.query<{ artifact_id: string; artifact_version: number }>(`
                SELECT artifact_id, artifact_version FROM stock_trace_artifacts
                WHERE event_id = $1 AND is_effective = TRUE
                FOR UPDATE
            `, [result.eventId]);
            const latestVersion = await client.query<{ artifact_version: number }>(
                'SELECT COALESCE(MAX(artifact_version), 0) AS artifact_version FROM stock_trace_artifacts WHERE event_id = $1',
                [result.eventId],
            );
            const artifactVersion = Number(latestVersion.rows[0]?.artifact_version || 0) + 1;
            if (current.rows[0]) await client.query('UPDATE stock_trace_artifacts SET is_effective = FALSE WHERE artifact_id = $1', [current.rows[0].artifact_id]);
            const now = new Date();
            const expiresAt = new Date(now.getTime() + ARTIFACT_TTL_DAYS * 24 * 60 * 60 * 1000);
            artifact.artifactVersion = artifactVersion;
            artifact.movementView.artifactVersion = artifactVersion;
            artifact.createdAt = now.toISOString();
            artifact.expiresAt = expiresAt.toISOString();
            await client.query(`
                INSERT INTO stock_trace_artifacts
                    (artifact_id, event_id, snapshot_id, result_id, artifact_version, analysis_version,
                     artifact_json, movement_view_json, validation_report_json, is_effective, supersedes_artifact_id, created_at, expires_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,TRUE,$10,$11,$12)
            `, [artifact.artifactId, artifact.eventId, artifact.snapshotId, artifact.resultId, artifactVersion,
                artifact.analysisVersion, JSON.stringify(artifact.artifactJson), JSON.stringify(artifact.movementView),
                JSON.stringify(artifact.validationReport), current.rows[0]?.artifact_id || null, now, expiresAt]);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
        if (isMajorACompanyCause(result, sources)) {
            await StockTraceAlertOrchestrator.pushConfirmedMajorCause(result.eventId, artifact.artifactId, artifact.movementView);
        }
        return artifact;
    }

    static async getEffectiveArtifact(eventId: string): Promise<StockTraceArtifact | null> {
        await this.ensureSchema();
        const result = await pool.query<ArtifactRow>(`
            SELECT * FROM stock_trace_artifacts
            WHERE event_id = $1 AND is_effective = TRUE AND expires_at > CURRENT_TIMESTAMP
            LIMIT 1
        `, [eventId]);
        return result.rows[0] ? serializeArtifact(result.rows[0]) : null;
    }

    static async getEffectiveArtifactForRevision(
        eventId: string,
        triggerRevision: number,
    ): Promise<StockTraceArtifact | null> {
        await this.ensureSchema();
        const result = await pool.query<ArtifactRow>(`
            SELECT a.*
            FROM stock_trace_artifacts a
            INNER JOIN stock_trace_snapshots s ON s.snapshot_id = a.snapshot_id
            WHERE a.event_id = $1
              AND s.trigger_revision = $2
              AND a.is_effective = TRUE
              AND a.expires_at > CURRENT_TIMESTAMP
            LIMIT 1
        `, [eventId, triggerRevision]);
        return result.rows[0] ? serializeArtifact(result.rows[0]) : null;
    }

    static async getMovementView(eventId: string, triggerRevision?: number): Promise<MovementViewV2 | null> {
        const artifact = triggerRevision === undefined
            ? await this.getEffectiveArtifact(eventId)
            : await this.getEffectiveArtifactForRevision(eventId, triggerRevision);
        return artifact?.movementView || null;
    }

    static async getEvidence(
        eventId: string,
        sourceId: string,
        triggerRevision?: number,
    ): Promise<Record<string, unknown> | null> {
        const artifact = triggerRevision === undefined
            ? await this.getEffectiveArtifact(eventId)
            : await this.getEffectiveArtifactForRevision(eventId, triggerRevision);
        const index = artifact?.artifactJson.evidence_index;
        if (!Array.isArray(index)) return null;
        return index.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && item.source_id === sourceId) || null;
    }

    private static buildArtifact(artifactId: string, result: StockTraceResult, sources: StockSourceRecord[]): StockTraceArtifact {
        const primary = primaryCandidate(result);
        const alternatives = result.candidates.filter((candidate) => candidate.candidateId !== primary?.candidateId && candidate.status === 'supported');
        const evidenceIndex = sources.map(toEvidenceMetadata);
        const movementView: MovementViewV2 = {
            schemaVersion: 'movement-view-v2', eventId: result.eventId, artifactId, artifactVersion: 0,
            status: result.attributionStatus, confidenceScore: result.confidenceScore, confidenceLevel: result.confidenceLevel,
            primaryCandidate: primary && { layer: primary.layer, status: primary.status, verdict: primary.verdict, supportingEvidenceIds: primary.supportingEvidenceIds },
            alternatives: alternatives.map((candidate) => ({ layer: candidate.layer, status: candidate.status, verdict: candidate.verdict, supportingEvidenceIds: candidate.supportingEvidenceIds })),
            unresolvedQuestions: result.unresolvedQuestions, suggestedActions: result.suggestedActions,
            evidenceCount: evidenceIndex.length, generatedAt: new Date().toISOString(),
        };
        return {
            artifactId, eventId: result.eventId, snapshotId: result.snapshotId, resultId: result.resultId,
            artifactVersion: 0, analysisVersion: result.analysisVersion,
            artifactJson: {
                schema_version: 'stock-trace-artifact-v1', event_id: result.eventId, snapshot_id: result.snapshotId,
                result_id: result.resultId, attribution_status: result.attributionStatus,
                confidence: { score: result.confidenceScore, level: result.confidenceLevel, config_version: result.confidenceConfigVersion },
                primary_chain_id: result.primaryChainId, alternative_chain_id: result.alternativeChainId,
                candidates: result.candidates, chains: result.chains, contradictions: result.contradictions,
                unresolved_questions: result.unresolvedQuestions, missing_capabilities: result.missingCapabilities,
                suggested_actions: result.suggestedActions, evidence_index: evidenceIndex,
            },
            movementView, validationReport: { status: 'passed', errors: [] }, isEffective: true,
            createdAt: '', expiresAt: '',
        };
    }

    private static async loadSources(snapshotId: string): Promise<StockSourceRecord[]> {
        const result = await pool.query<Record<string, unknown>>(`
            SELECT source_id, kind, provider, source_level, title, content_excerpt, canonical_url, source_ref,
                   symbol, window_start, window_end, occurred_at, captured_at, freshness_seconds, payload, content_hash
            FROM stock_trace_source_records WHERE snapshot_id = $1 ORDER BY captured_at, source_id
        `, [snapshotId]);
        return result.rows.map((row) => ({
            sourceId: String(row.source_id), kind: row.kind as StockSourceRecord['kind'], provider: String(row.provider),
            sourceLevel: row.source_level as StockSourceRecord['sourceLevel'], title: String(row.title), contentExcerpt: String(row.content_excerpt),
            canonicalUrl: row.canonical_url ? String(row.canonical_url) : undefined, sourceRef: row.source_ref ? String(row.source_ref) : undefined,
            symbol: row.symbol ? String(row.symbol).trim() : undefined, windowStart: row.window_start ? new Date(String(row.window_start)) : undefined,
            windowEnd: row.window_end ? new Date(String(row.window_end)) : undefined, occurredAt: row.occurred_at ? new Date(String(row.occurred_at)) : undefined,
            capturedAt: new Date(String(row.captured_at)), freshnessSeconds: row.freshness_seconds === null ? undefined : Number(row.freshness_seconds),
            payload: (row.payload || {}) as Record<string, unknown>, contentHash: String(row.content_hash),
        }));
    }
}
