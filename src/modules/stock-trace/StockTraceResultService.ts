import { randomUUID } from 'node:crypto';
import pool from '../../core/db';
import {
    type AttributionStatus,
    type CandidateLayer,
    type CandidateStatus,
    type ChainStage,
    type StockSourceRecord,
    type StockTraceResult,
    type TraceCandidate,
    type TraceChain,
    type TraceChainNode,
    type TraceDirection,
} from './types';

const ANALYSIS_VERSION = 'rule-six-stage-v1';
const CONFIDENCE_CONFIG_VERSION = 'confidence-v1.0';
const STAGES: readonly ChainStage[] = ['structural_root', 'trigger', 'transmission', 'exposure', 'repricing', 'observable_result'];

interface SnapshotInput {
    snapshotId: string;
    eventId: string;
    triggerRevision: number;
    windowEndAt: Date;
    direction: TraceDirection;
    sourceRecords: StockSourceRecord[];
}

interface ValidationInput {
    attributionStatus: AttributionStatus;
    confidenceScore?: number;
    candidates: TraceCandidate[];
    chains: TraceChain[];
    sources: StockSourceRecord[];
    windowEndAt: Date;
    direction: TraceDirection;
    /** 缺失的能力清单（如 capital_flow_disabled）。部分校验规则在能力缺失时放宽。 */
    missingCapabilities?: string[];
}

export interface ExternalResultInput {
    event_id: string;
    snapshot_id: string;
    analysis_version: string;
    attribution_status: AttributionStatus;
    primary_chain_id: string | null;
    alternative_chain_id: string | null;
    confidence_score: number;
    confidence_level: NonNullable<StockTraceResult['confidenceLevel']>;
    candidates: Array<{
        candidate_id: string; layer: CandidateLayer; rank: number; status: CandidateStatus; verdict: string;
        supporting_evidence_ids: string[]; counter_evidence_ids: string[];
    }>;
    chains: Array<{
        chain_id: string; candidate_id: string; role: TraceChain['role']; nodes: Array<{
            node_id: string; stage: ChainStage; stage_order: number; epistemic_type: TraceChainNode['epistemicType'];
            status: TraceChainNode['status']; claim: string; evidence_ids: string[]; counter_evidence_ids: string[];
        }>;
    }>;
    contradictions?: string[];
    unresolved_questions?: string[];
    suggested_actions?: StockTraceResult['suggestedActions'];
    /** 简短主因短语（≤20 字，Python LLM 生成） */
    primary_phrase?: string;
}

let schemaPromise: Promise<void> | null = null;

function asDate(value: unknown): Date {
    if (value instanceof Date) return value;
    return new Date(String(value));
}

function valueDirection(source: StockSourceRecord): TraceDirection | 'neutral' | null {
    const payload = source.payload;
    const numericValue = payload.change_pct ?? payload.pct_change;
    if (typeof numericValue === 'number') return numericValue > 0 ? 'up' : numericValue < 0 ? 'down' : 'neutral';
    const impact = String(payload.impact || '').toLowerCase();
    if (impact.includes('利好') || impact.includes('positive')) return 'up';
    if (impact.includes('利空') || impact.includes('negative')) return 'down';
    return null;
}

function sourceById(sources: StockSourceRecord[]): Map<string, StockSourceRecord> {
    return new Map(sources.map((source) => [source.sourceId, source]));
}

function candidateVerdict(layer: CandidateLayer, status: CandidateStatus): string {
    if (status === 'supported') return `${layer} evidence is available for a constrained causal hypothesis.`;
    return `${layer} evidence is insufficient to establish a causal explanation.`;
}

function buildCandidate(layer: CandidateLayer, evidence: StockSourceRecord[], counterEvidence: StockSourceRecord[] = []): TraceCandidate {
    const supported = evidence.length > 0;
    const status: CandidateStatus = supported ? 'supported' : counterEvidence.length > 0 ? 'rejected' : 'insufficient';
    return {
        candidateId: randomUUID(), layer, rank: 1, status,
        verdict: candidateVerdict(layer, status),
        supportingEvidenceIds: evidence.map((source) => source.sourceId), counterEvidenceIds: counterEvidence.map((source) => source.sourceId),
    };
}

function buildChain(candidate: TraceCandidate, triggerSourceId: string): TraceChain {
    const evidence = candidate.supportingEvidenceIds;
    const established = candidate.status === 'supported';
    const node = (
        stage: ChainStage,
        order: number,
        epistemicType: TraceChainNode['epistemicType'],
        status: TraceChainNode['status'],
        claim: string,
        evidenceIds: string[],
    ): TraceChainNode => ({ nodeId: randomUUID(), stage, stageOrder: order, epistemicType, status, claim, evidenceIds, counterEvidenceIds: [] });
    return {
        chainId: randomUUID(), candidateId: candidate.candidateId, role: 'primary',
        nodes: [
            node('structural_root', 1, established ? 'fact' : 'hypothesis', established ? 'established' : 'not_established', established ? 'Snapshot source establishes a relevant contextual fact.' : 'No structural root fact is established.', established ? evidence : []),
            node('trigger', 2, 'fact', 'established', 'The configured price rule was triggered.', [triggerSourceId]),
            node('transmission', 3, 'inference', established ? 'partial' : 'not_established', established ? 'A transmission path is plausible but not fully established.' : 'No transmission fact is established.', established ? evidence : []),
            node('exposure', 4, 'hypothesis', 'not_established', 'No exposure fact is established.', []),
            node('repricing', 5, 'inference', established ? 'partial' : 'not_established', established ? 'Observed contextual facts may be consistent with repricing.' : 'No repricing fact is established.', established ? evidence : []),
            node('observable_result', 6, 'fact', 'established', 'The price movement is directly observed in the trigger fact.', [triggerSourceId]),
        ],
    };
}

export function validateStockTraceResult(input: ValidationInput): string[] {
    const errors: string[] = [];
    const sourceMap = sourceById(input.sources);
    const triggerSources = input.sources.filter((source) => source.kind === 'trigger_fact');
    for (const layer of ['company', 'sector', 'market'] as CandidateLayer[]) {
        if (!input.candidates.some((candidate) => candidate.layer === layer)) errors.push(`result:missing_${layer}_candidate`);
    }
    const ensureEvidence = (
        ids: string[],
        prefix: string,
        options: { allowPostWindow?: boolean } = {},
    ): void => {
        for (const id of ids) {
            const source = sourceMap.get(id);
            if (!source) errors.push(`${prefix}:evidence_not_found:${id}`);
            else if (!options.allowPostWindow && source.occurredAt && source.occurredAt.getTime() > input.windowEndAt.getTime()) {
                errors.push(`${prefix}:evidence_after_window:${id}`);
            }
        }
    };

    for (const candidate of input.candidates) {
        ensureEvidence(candidate.supportingEvidenceIds, `candidate:${candidate.layer}`);
        // A sector/market fact captured after the event window is useful context,
        // but cannot be required as contemporaneous counter-evidence or block publication.
        ensureEvidence(candidate.counterEvidenceIds, `candidate:${candidate.layer}:counter`, {
            allowPostWindow: candidate.layer === 'sector' || candidate.layer === 'market',
        });
    }
    for (const layer of ['sector', 'market'] as CandidateLayer[]) {
        const hasOppositeFact = input.sources.some((source) =>
            (layer === 'sector' ? source.kind === 'sector_fact' : source.kind === 'market_fact')
            && Boolean(source.occurredAt)
            && source.occurredAt!.getTime() <= input.windowEndAt.getTime()
            && valueDirection(source) !== null
            && valueDirection(source) !== 'neutral'
            && valueDirection(source) !== input.direction,
        );
        const candidate = input.candidates.find((item) => item.layer === layer);
        // 2026-08-21 决策：sector/market 候选未声称驱动（非 supported）或资金流数据缺失
        // （capital_flow_disabled，agent 无法完整分析资金面）时不强制反证。
        // 避免误伤：如板块候选已明确"非主要驱动"仍因窗口内存在反向小板块事实被阻塞。
        if (hasOppositeFact && candidate?.status === 'supported'
            && !(input.missingCapabilities ?? []).includes('capital_flow_disabled')
            && candidate.counterEvidenceIds.length === 0) errors.push(`candidate:${layer}:missing_counter_evidence`);
    }
    for (const chain of input.chains) {
        if (chain.nodes.length !== STAGES.length) errors.push(`chain:${chain.chainId}:invalid_stage_count`);
        for (const expected of STAGES) if (!chain.nodes.some((node) => node.stage === expected)) errors.push(`chain:${chain.chainId}:missing_${expected}`);
        for (const node of chain.nodes) {
            ensureEvidence(node.evidenceIds, `node:${node.stage}`);
            if (node.epistemicType === 'fact' && node.evidenceIds.length === 0) errors.push(`node:${node.stage}:fact_without_evidence`);
            if (node.status === 'not_established' && node.evidenceIds.length > 0) errors.push(`node:${node.stage}:not_established_with_evidence`);
            if (node.stage === 'observable_result' && !node.evidenceIds.some((id) => triggerSources.some((source) => source.sourceId === id))) errors.push('node:observable_result:missing_trigger_fact');
        }
    }
    if (input.attributionStatus === 'confirmed') {
        if ((input.confidenceScore || 0) < 0.75) errors.push('confirmed:confidence_below_threshold');
        const companyEvidence = input.candidates.find((candidate) => candidate.layer === 'company')?.supportingEvidenceIds
            .map((id) => sourceMap.get(id)).filter((source): source is StockSourceRecord => Boolean(source)) || [];
        const hasAEvent = companyEvidence.some((source) => source.sourceLevel === 'A');
        const hasBEvent = companyEvidence.some((source) => source.sourceLevel === 'B' && valueDirection(source) === input.direction);
        const hasIndependentFact = input.sources.some((source) => (source.kind === 'sector_fact' || source.kind === 'market_fact') && source.sourceLevel !== 'D' && valueDirection(source) === input.direction && Boolean(source.occurredAt) && source.occurredAt!.getTime() <= input.windowEndAt.getTime());
        if (!hasAEvent && !hasBEvent) errors.push('confirmed:missing_qualified_company_event');
        if (!hasAEvent && !hasIndependentFact) errors.push('confirmed:missing_independent_market_fact');
        if (companyEvidence.some((source) => source.sourceLevel === 'D')) errors.push('confirmed:grade_d_evidence');
    }
    return errors;
}

export class StockTraceResultService {
    static async ensureSchema(): Promise<void> {
        if (!schemaPromise) schemaPromise = this.createSchema();
        return schemaPromise;
    }

    private static async createSchema(): Promise<void> {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_trace_results (
                result_id UUID PRIMARY KEY, event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
                snapshot_id UUID NOT NULL REFERENCES stock_trace_snapshots(snapshot_id), analysis_version VARCHAR(32) NOT NULL,
                model_provider VARCHAR(32) NOT NULL, model_version VARCHAR(128) NOT NULL,
                processing_status VARCHAR(16) NOT NULL, attribution_status VARCHAR(16) NOT NULL,
                primary_chain_id UUID, alternative_chain_id UUID, confidence_score NUMERIC(4,3), confidence_level VARCHAR(8),
                confidence_config_version VARCHAR(32) NOT NULL, contradictions JSONB NOT NULL DEFAULT '[]'::jsonb,
                unresolved_questions JSONB NOT NULL DEFAULT '[]'::jsonb, missing_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
                suggested_actions JSONB NOT NULL DEFAULT '[]'::jsonb, validation_status VARCHAR(16) NOT NULL,
                validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb, primary_phrase VARCHAR(24) NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(event_id, snapshot_id, analysis_version)
            )
        `);
        await pool.query(`ALTER TABLE stock_trace_results ADD COLUMN IF NOT EXISTS primary_phrase VARCHAR(24) NOT NULL DEFAULT ''`);
        await pool.query(`CREATE TABLE IF NOT EXISTS stock_trace_candidates (candidate_id UUID PRIMARY KEY, result_id UUID NOT NULL REFERENCES stock_trace_results(result_id), layer VARCHAR(12) NOT NULL, rank SMALLINT NOT NULL, status VARCHAR(16) NOT NULL, verdict TEXT NOT NULL, supporting_evidence_ids JSONB NOT NULL, counter_evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(result_id, layer, rank))`);
        await pool.query(`CREATE TABLE IF NOT EXISTS stock_trace_chains (chain_id UUID PRIMARY KEY, result_id UUID NOT NULL REFERENCES stock_trace_results(result_id), candidate_id UUID NOT NULL REFERENCES stock_trace_candidates(candidate_id), chain_role VARCHAR(16) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS stock_trace_chain_nodes (node_id UUID PRIMARY KEY, chain_id UUID NOT NULL REFERENCES stock_trace_chains(chain_id), stage VARCHAR(24) NOT NULL, stage_order SMALLINT NOT NULL, epistemic_type VARCHAR(12) NOT NULL, status VARCHAR(20) NOT NULL, claim TEXT NOT NULL, evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb, counter_evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(chain_id, stage), UNIQUE(chain_id, stage_order))`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_stock_trace_results_event ON stock_trace_results(event_id, created_at DESC)');
    }

    static async generateForSnapshot(snapshotId: string, analysisVersion = ANALYSIS_VERSION): Promise<StockTraceResult> {
        await this.ensureSchema();
        const existing = await this.getBySnapshot(snapshotId, analysisVersion);
        if (existing) return existing;
        const snapshot = await this.loadSnapshot(snapshotId);
        if (!snapshot) throw new Error('snapshot_not_found');
        const triggerSource = snapshot.sourceRecords.find((source) => source.kind === 'trigger_fact');
        if (!triggerSource) throw new Error('snapshot_missing_trigger_fact');
        const companyEvidence = snapshot.sourceRecords.filter((source) => (source.kind === 'announcement' || source.kind === 'news') && source.occurredAt && source.occurredAt.getTime() <= snapshot.windowEndAt.getTime());
        const sectorFacts = snapshot.sourceRecords.filter((source) => source.kind === 'sector_fact' && source.occurredAt && source.occurredAt.getTime() <= snapshot.windowEndAt.getTime());
        const marketFacts = snapshot.sourceRecords.filter((source) => source.kind === 'market_fact' && source.occurredAt && source.occurredAt.getTime() <= snapshot.windowEndAt.getTime());
        const sectorEvidence = sectorFacts.filter((source) => valueDirection(source) === snapshot.direction);
        const marketEvidence = marketFacts.filter((source) => valueDirection(source) === snapshot.direction);
        const sectorCounter = sectorFacts.filter((source) => valueDirection(source) !== null && valueDirection(source) !== 'neutral' && valueDirection(source) !== snapshot.direction);
        const marketCounter = marketFacts.filter((source) => valueDirection(source) !== null && valueDirection(source) !== 'neutral' && valueDirection(source) !== snapshot.direction);
        const candidates = [buildCandidate('company', companyEvidence), buildCandidate('sector', sectorEvidence, sectorCounter), buildCandidate('market', marketEvidence, marketCounter)];
        const supported = candidates.filter((candidate) => candidate.status === 'supported');
        const primaryCandidate = supported[0];
        const alternativeCandidate = supported[1];
        const chains = primaryCandidate ? [buildChain(primaryCandidate, triggerSource.sourceId)] : [];
        if (alternativeCandidate) {
            const alternative = buildChain(alternativeCandidate, triggerSource.sourceId);
            alternative.role = 'alternative';
            chains.push(alternative);
        }
        const companyA = companyEvidence.some((source) => source.sourceLevel === 'A');
        const companyB = companyEvidence.some((source) => source.sourceLevel === 'B' && valueDirection(source) === snapshot.direction);
        const independentFact = sectorEvidence.length > 0 || marketEvidence.length > 0;
        const attributionStatus: AttributionStatus = companyA || (companyB && independentFact) ? 'confirmed' : primaryCandidate ? 'hypothesis' : 'insufficient';
        const confidenceScore = attributionStatus === 'confirmed' ? 0.78 : attributionStatus === 'hypothesis' ? 0.55 : 0.2;
        const validationErrors = validateStockTraceResult({ attributionStatus, confidenceScore, candidates, chains, sources: snapshot.sourceRecords, windowEndAt: snapshot.windowEndAt, direction: snapshot.direction, missingCapabilities: ['capital_flow_disabled'] });
        const result: StockTraceResult = {
            resultId: randomUUID(), eventId: snapshot.eventId, snapshotId, analysisVersion,
            processingStatus: validationErrors.length ? 'partial' : 'completed', attributionStatus: validationErrors.length && attributionStatus === 'confirmed' ? 'hypothesis' : attributionStatus,
            primaryChainId: chains.find((chain) => chain.role === 'primary')?.chainId, alternativeChainId: chains.find((chain) => chain.role === 'alternative')?.chainId,
            confidenceScore, confidenceLevel: confidenceScore >= 0.75 ? 'high' : confidenceScore >= 0.5 ? 'medium' : 'low', confidenceConfigVersion: CONFIDENCE_CONFIG_VERSION,
            contradictions: [...sectorCounter, ...marketCounter].map((source) => `Opposite-direction contextual fact: ${source.sourceId}`), unresolvedQuestions: attributionStatus === 'insufficient' ? ['No timely company, sector, or market evidence establishes a causal explanation.'] : ['Transmission and exposure stages are not established by the current snapshot.'],
            missingCapabilities: ['capital_flow_disabled'], suggestedActions: attributionStatus === 'confirmed' ? ['verify_announcement', 'observe'] : ['observe', 'read_evidence'],
            validationStatus: validationErrors.length ? 'rejected' : 'passed', validationErrors, candidates, chains,
        };
        await this.persist(result);
        return result;
    }

    static async acceptExternalResult(input: ExternalResultInput): Promise<StockTraceResult> {
        await this.ensureSchema();
        const existing = await this.getBySnapshot(input.snapshot_id, input.analysis_version);
        if (existing) return existing;
        const snapshot = await this.loadSnapshot(input.snapshot_id);
        if (!snapshot || snapshot.eventId !== input.event_id) throw new Error('snapshot_not_found');
        const candidateIds = new Map(input.candidates.map((candidate) => [candidate.candidate_id, randomUUID()]));
        const chainIds = new Map(input.chains.map((chain) => [chain.chain_id, randomUUID()]));
        if (input.chains.some((chain) => !candidateIds.has(chain.candidate_id))) {
            throw new Error('external_result_invalid_chain_candidate');
        }
        if (input.primary_chain_id && !chainIds.has(input.primary_chain_id)) {
            throw new Error('external_result_invalid_primary_chain');
        }
        if (input.alternative_chain_id && !chainIds.has(input.alternative_chain_id)) {
            throw new Error('external_result_invalid_alternative_chain');
        }
        const candidates: TraceCandidate[] = input.candidates.map((candidate) => ({
            candidateId: candidateIds.get(candidate.candidate_id) || randomUUID(), layer: candidate.layer,
            rank: candidate.rank, status: candidate.status, verdict: candidate.verdict,
            supportingEvidenceIds: candidate.supporting_evidence_ids, counterEvidenceIds: candidate.counter_evidence_ids,
        }));
        const chains: TraceChain[] = input.chains.map((chain) => ({
            chainId: chainIds.get(chain.chain_id) || randomUUID(),
            candidateId: candidateIds.get(chain.candidate_id) || randomUUID(), role: chain.role,
            nodes: chain.nodes.map((node) => ({
                nodeId: randomUUID(), stage: node.stage, stageOrder: node.stage_order,
                epistemicType: node.epistemic_type, status: node.status, claim: node.claim,
                evidenceIds: node.evidence_ids, counterEvidenceIds: node.counter_evidence_ids,
            })),
        }));
        const validationErrors = validateStockTraceResult({
            attributionStatus: input.attribution_status, confidenceScore: input.confidence_score,
            candidates, chains, sources: snapshot.sourceRecords, windowEndAt: snapshot.windowEndAt,
            direction: snapshot.direction,
            // 与下方落库的 missingCapabilities 保持一致：当前所有外部（agent）归因均视为资金流不可用
            missingCapabilities: ['capital_flow_disabled'],
        });
        const result: StockTraceResult = {
            resultId: randomUUID(), eventId: input.event_id, snapshotId: input.snapshot_id,
            analysisVersion: input.analysis_version,
            processingStatus: validationErrors.length ? 'partial' : 'completed',
            attributionStatus: validationErrors.length && input.attribution_status === 'confirmed'
                ? 'hypothesis' : input.attribution_status,
            primaryChainId: input.primary_chain_id ? chainIds.get(input.primary_chain_id) : undefined,
            alternativeChainId: input.alternative_chain_id ? chainIds.get(input.alternative_chain_id) : undefined,
            confidenceScore: input.confidence_score, confidenceLevel: input.confidence_level,
            confidenceConfigVersion: CONFIDENCE_CONFIG_VERSION,
            contradictions: input.contradictions || [], unresolvedQuestions: input.unresolved_questions || [],
            missingCapabilities: ['capital_flow_disabled'], suggestedActions: input.suggested_actions || [],
            validationStatus: validationErrors.length ? 'rejected' : 'passed', validationErrors,
            primaryPhrase: input.primary_phrase || undefined,
            candidates, chains,
        };
        await this.persist(result, 'python_stock_trace_worker', 'llm-stock-trace-v1');
        return result;
    }

    private static async loadSnapshot(snapshotId: string): Promise<SnapshotInput | null> {
        const snapshotResult = await pool.query(`SELECT event_id, trigger_revision, trigger_event_json FROM stock_trace_snapshots WHERE snapshot_id = $1 LIMIT 1`, [snapshotId]);
        const snapshot = snapshotResult.rows[0] as { event_id: string; trigger_revision: number; trigger_event_json: Record<string, unknown> } | undefined;
        if (!snapshot) return null;
        const trigger = snapshot.trigger_event_json;
        const sourcesResult = await pool.query(`SELECT source_id, kind, provider, source_level, title, content_excerpt, canonical_url, source_ref, symbol, window_start, window_end, occurred_at, captured_at, freshness_seconds, payload, content_hash FROM stock_trace_source_records WHERE snapshot_id = $1`, [snapshotId]);
        const sources = sourcesResult.rows.map((row: Record<string, unknown>): StockSourceRecord => ({
            sourceId: String(row.source_id), kind: row.kind as StockSourceRecord['kind'], provider: String(row.provider), sourceLevel: row.source_level as StockSourceRecord['sourceLevel'], title: String(row.title), contentExcerpt: String(row.content_excerpt), canonicalUrl: row.canonical_url ? String(row.canonical_url) : undefined, sourceRef: row.source_ref ? String(row.source_ref) : undefined, symbol: row.symbol ? String(row.symbol).trim() : undefined, windowStart: row.window_start ? asDate(row.window_start) : undefined, windowEnd: row.window_end ? asDate(row.window_end) : undefined, occurredAt: row.occurred_at ? asDate(row.occurred_at) : undefined, capturedAt: asDate(row.captured_at), freshnessSeconds: row.freshness_seconds === null ? undefined : Number(row.freshness_seconds), payload: (row.payload || {}) as Record<string, unknown>, contentHash: String(row.content_hash),
        }));
        return { snapshotId, eventId: snapshot.event_id, triggerRevision: snapshot.trigger_revision, windowEndAt: asDate(trigger.windowEndAt || trigger.window_end_at), direction: trigger.direction as TraceDirection, sourceRecords: sources };
    }

    private static async persist(
        result: StockTraceResult,
        modelProvider = 'rule_engine',
        modelVersion = 'six-stage-v1',
    ): Promise<void> {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`INSERT INTO stock_trace_results (result_id, event_id, snapshot_id, analysis_version, model_provider, model_version, processing_status, attribution_status, primary_chain_id, alternative_chain_id, confidence_score, confidence_level, confidence_config_version, contradictions, unresolved_questions, missing_capabilities, suggested_actions, validation_status, validation_errors, primary_phrase) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19::jsonb,$20)`, [result.resultId, result.eventId, result.snapshotId, result.analysisVersion, modelProvider, modelVersion, result.processingStatus, result.attributionStatus, result.primaryChainId || null, result.alternativeChainId || null, result.confidenceScore || null, result.confidenceLevel || null, result.confidenceConfigVersion, JSON.stringify(result.contradictions), JSON.stringify(result.unresolvedQuestions), JSON.stringify(result.missingCapabilities), JSON.stringify(result.suggestedActions), result.validationStatus, JSON.stringify(result.validationErrors), result.primaryPhrase || '']);
            for (const candidate of result.candidates) await client.query(`INSERT INTO stock_trace_candidates (candidate_id, result_id, layer, rank, status, verdict, supporting_evidence_ids, counter_evidence_ids) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`, [candidate.candidateId, result.resultId, candidate.layer, candidate.rank, candidate.status, candidate.verdict, JSON.stringify(candidate.supportingEvidenceIds), JSON.stringify(candidate.counterEvidenceIds)]);
            for (const chain of result.chains) {
                await client.query(`INSERT INTO stock_trace_chains (chain_id, result_id, candidate_id, chain_role) VALUES ($1,$2,$3,$4)`, [chain.chainId, result.resultId, chain.candidateId, chain.role]);
                for (const node of chain.nodes) await client.query(`INSERT INTO stock_trace_chain_nodes (node_id, chain_id, stage, stage_order, epistemic_type, status, claim, evidence_ids, counter_evidence_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`, [node.nodeId, chain.chainId, node.stage, node.stageOrder, node.epistemicType, node.status, node.claim, JSON.stringify(node.evidenceIds), JSON.stringify(node.counterEvidenceIds)]);
            }
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }

    static async getBySnapshot(snapshotId: string, analysisVersion = ANALYSIS_VERSION): Promise<StockTraceResult | null> {
        await this.ensureSchema();
        const result = await pool.query(`SELECT result_id, event_id, snapshot_id, analysis_version, processing_status, attribution_status, primary_chain_id, alternative_chain_id, confidence_score, confidence_level, confidence_config_version, contradictions, unresolved_questions, missing_capabilities, suggested_actions, validation_status, validation_errors, primary_phrase FROM stock_trace_results WHERE snapshot_id = $1 AND analysis_version = $2 LIMIT 1`, [snapshotId, analysisVersion]);
        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (!row) return null;
        const candidatesResult = await pool.query(`SELECT candidate_id, layer, rank, status, verdict, supporting_evidence_ids, counter_evidence_ids FROM stock_trace_candidates WHERE result_id = $1 ORDER BY layer, rank`, [row.result_id]);
        const chainsResult = await pool.query(`SELECT c.chain_id, c.candidate_id, c.chain_role, n.node_id, n.stage, n.stage_order, n.epistemic_type, n.status, n.claim, n.evidence_ids, n.counter_evidence_ids FROM stock_trace_chains c LEFT JOIN stock_trace_chain_nodes n ON n.chain_id = c.chain_id WHERE c.result_id = $1 ORDER BY c.chain_role, n.stage_order`, [row.result_id]);
        const chainsById = new Map<string, TraceChain>();
        for (const item of chainsResult.rows as Record<string, unknown>[]) {
            const chainId = String(item.chain_id); if (!chainsById.has(chainId)) chainsById.set(chainId, { chainId, candidateId: String(item.candidate_id), role: item.chain_role as TraceChain['role'], nodes: [] });
            if (item.node_id) chainsById.get(chainId)!.nodes.push({ nodeId: String(item.node_id), stage: item.stage as ChainStage, stageOrder: Number(item.stage_order), epistemicType: item.epistemic_type as TraceChainNode['epistemicType'], status: item.status as TraceChainNode['status'], claim: String(item.claim), evidenceIds: item.evidence_ids as string[], counterEvidenceIds: item.counter_evidence_ids as string[] });
        }
        return { resultId: String(row.result_id), eventId: String(row.event_id), snapshotId: String(row.snapshot_id), analysisVersion: String(row.analysis_version), processingStatus: row.processing_status as StockTraceResult['processingStatus'], attributionStatus: row.attribution_status as AttributionStatus, primaryChainId: row.primary_chain_id ? String(row.primary_chain_id) : undefined, alternativeChainId: row.alternative_chain_id ? String(row.alternative_chain_id) : undefined, confidenceScore: row.confidence_score === null ? undefined : Number(row.confidence_score), confidenceLevel: row.confidence_level as StockTraceResult['confidenceLevel'], confidenceConfigVersion: String(row.confidence_config_version), contradictions: row.contradictions as string[], unresolvedQuestions: row.unresolved_questions as string[], missingCapabilities: row.missing_capabilities as string[], suggestedActions: row.suggested_actions as string[], validationStatus: row.validation_status as StockTraceResult['validationStatus'], validationErrors: row.validation_errors as string[], primaryPhrase: row.primary_phrase ? String(row.primary_phrase) : undefined, candidates: candidatesResult.rows.map((item: Record<string, unknown>) => ({ candidateId: String(item.candidate_id), layer: item.layer as CandidateLayer, rank: Number(item.rank), status: item.status as CandidateStatus, verdict: String(item.verdict), supportingEvidenceIds: item.supporting_evidence_ids as string[], counterEvidenceIds: item.counter_evidence_ids as string[] })), chains: [...chainsById.values()] };
    }

    static async getById(resultId: string): Promise<StockTraceResult | null> {
        await this.ensureSchema();
        const result = await pool.query<{ snapshot_id: string; analysis_version: string }>(
            'SELECT snapshot_id, analysis_version FROM stock_trace_results WHERE result_id = $1 LIMIT 1',
            [resultId],
        );
        const row = result.rows[0];
        return row ? this.getBySnapshot(row.snapshot_id, row.analysis_version) : null;
    }

    static async getLatestForEventRevision(
        eventId: string,
        triggerRevision: number,
    ): Promise<StockTraceResult | null> {
        await this.ensureSchema();
        const result = await pool.query<{ result_id: string }>(`
            SELECT r.result_id
            FROM stock_trace_results r
            INNER JOIN stock_trace_snapshots s ON s.snapshot_id = r.snapshot_id
            WHERE r.event_id = $1 AND s.trigger_revision = $2
            ORDER BY r.created_at DESC
            LIMIT 1
        `, [eventId, triggerRevision]);
        return result.rows[0] ? this.getById(result.rows[0].result_id) : null;
    }
}
