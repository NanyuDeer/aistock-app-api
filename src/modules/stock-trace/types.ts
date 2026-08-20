import { shanghaiDateStr } from '../../shared/utils/shanghaiTime';

export const PRICE_TRIGGER_PERCENT = 7;
export const PRICE_RULE_VERSION = 'price-v1';
export const PRICE_REVISION_DELTA_PERCENT = 2;
export const PRICE_RESET_WINDOW_MS = 5 * 60 * 1000;
export const NEW_STOCK_EXCLUSION_DAYS = 60;

export type TraceDirection = 'up' | 'down';
export type TraceSeverity = 'medium' | 'high' | 'critical';
export type EventMutation = 'created' | 'revised' | 'unchanged' | 'ignored';

export interface FavoriteSecurity {
    symbol: string;
    stockName: string;
    market: string;
    listDate: string | null;
}

export interface PriceFact {
    symbol: string;
    stockName: string;
    latestPrice: number;
    previousClose: number;
    changePct: number;
    observedAt: Date;
}

export interface TriggerEvent {
    eventId: string;
    triggerRevision: number;
    symbol: string;
    stockName: string;
    tradingDate: string;
    direction: TraceDirection;
    triggeredAt: Date;
    windowStartAt: Date;
    windowEndAt: Date;
    latestPrice: number;
    previousClose: number;
    actualValue: number;
    thresholdValue: number;
    severity: TraceSeverity;
    ruleVersion: string;
}

export interface PriceMutationResult {
    mutation: EventMutation;
    event: TriggerEvent | null;
}

export type SnapshotStage = 'initial' | 'enriched' | 'corrected';
export type SourceLevel = 'A' | 'B' | 'C' | 'D';
export type DataReadiness = 'complete' | 'partial' | 'missing';

export type SourceKind =
    | 'trigger_fact' | 'quote_fact' | 'sector_fact' | 'market_fact'
    | 'announcement' | 'news' | 'capital_fact' | 'technical_fact';

export interface StockSourceRecord {
    sourceId: string;
    kind: SourceKind;
    provider: string;
    sourceLevel: SourceLevel;
    title: string;
    contentExcerpt: string;
    canonicalUrl?: string;
    sourceRef?: string;
    symbol?: string;
    windowStart?: Date;
    windowEnd?: Date;
    occurredAt?: Date;
    capturedAt: Date;
    freshnessSeconds?: number;
    payload: Record<string, unknown>;
    contentHash: string;
}

export interface StockTraceSnapshot {
    snapshotId: string;
    eventId: string;
    triggerRevision: number;
    snapshotStage: SnapshotStage;
    sourceRevisionHash: string;
    triggerEvent: TriggerEvent;
    missingFields: string[];
    dataReadiness: Record<DataReadinessDomains, DataReadiness>;
    collectorVersions: Record<string, string>;
    capturedAt: Date;
    supersedesSnapshotId?: string;
    sourceRecords: StockSourceRecord[];
}

export type DataReadinessDomains = 'company' | 'sector' | 'market' | 'capital' | 'technical';
export type AttributionStatus = 'confirmed' | 'hypothesis' | 'insufficient' | 'not_applicable';
export type CandidateLayer = 'company' | 'sector' | 'market' | 'capital' | 'technical';
export type CandidateStatus = 'supported' | 'weak' | 'rejected' | 'insufficient';
export type ChainStage = 'structural_root' | 'trigger' | 'transmission' | 'exposure' | 'repricing' | 'observable_result';
export type EpistemicType = 'fact' | 'inference' | 'hypothesis';
export type ChainNodeStatus = 'established' | 'partial' | 'not_established';

export interface TraceCandidate {
    candidateId: string;
    layer: CandidateLayer;
    rank: number;
    status: CandidateStatus;
    verdict: string;
    supportingEvidenceIds: string[];
    counterEvidenceIds: string[];
}

export interface TraceChainNode {
    nodeId: string;
    stage: ChainStage;
    stageOrder: number;
    epistemicType: EpistemicType;
    status: ChainNodeStatus;
    claim: string;
    evidenceIds: string[];
    counterEvidenceIds: string[];
}

export interface TraceChain {
    chainId: string;
    candidateId: string;
    role: 'primary' | 'alternative';
    nodes: TraceChainNode[];
}

export interface StockTraceResult {
    resultId: string;
    eventId: string;
    snapshotId: string;
    analysisVersion: string;
    processingStatus: 'completed' | 'partial' | 'failed';
    attributionStatus: AttributionStatus;
    primaryChainId?: string;
    alternativeChainId?: string;
    confidenceScore?: number;
    confidenceLevel?: 'high' | 'medium' | 'low';
    confidenceConfigVersion: string;
    contradictions: string[];
    unresolvedQuestions: string[];
    missingCapabilities: string[];
    suggestedActions: string[];
    validationStatus: 'pending' | 'passed' | 'rejected';
    validationErrors: string[];
    /** 简短主因短语（≤20 字，LLM 生成），供列表/卡片展示 */
    primaryPhrase?: string;
    candidates: TraceCandidate[];
    chains: TraceChain[];
}

export interface MovementViewV2 {
    schemaVersion: 'movement-view-v2';
    eventId: string;
    artifactId: string;
    artifactVersion: number;
    status: AttributionStatus;
    confidenceScore?: number;
    confidenceLevel?: 'high' | 'medium' | 'low';
    primaryCandidate?: Pick<TraceCandidate, 'layer' | 'status' | 'verdict' | 'supportingEvidenceIds'>;
    alternatives: Array<Pick<TraceCandidate, 'layer' | 'status' | 'verdict' | 'supportingEvidenceIds'>>;
    unresolvedQuestions: string[];
    suggestedActions: string[];
    evidenceCount: number;
    generatedAt: string;
}

export interface StockTraceArtifact {
    artifactId: string;
    eventId: string;
    snapshotId: string;
    resultId: string;
    artifactVersion: number;
    analysisVersion: string;
    artifactJson: Record<string, unknown>;
    movementView: MovementViewV2;
    validationReport: { status: 'passed'; errors: string[] };
    isEffective: boolean;
    supersedesArtifactId?: string;
    createdAt: string;
    expiresAt: string;
}

export function formatChinaTradingDate(date: Date): string {
    return shanghaiDateStr(date);
}

export function createEventId(symbol: string, tradingDate: string, firstTriggeredAt: Date, direction: TraceDirection): string {
    return `mv:${symbol}:${tradingDate}:${firstTriggeredAt.getTime()}:${direction}`;
}

export function getSeverity(changePct: number): TraceSeverity {
    const magnitude = Math.abs(changePct);
    if (magnitude >= 10) return 'critical';
    if (magnitude >= 8) return 'high';
    return 'medium';
}

export function isRevisionNeeded(previousChangePct: number, nextChangePct: number, previousSeverity: TraceSeverity, nextSeverity: TraceSeverity): boolean {
    const rank: Record<TraceSeverity, number> = { medium: 1, high: 2, critical: 3 };
    return Math.abs(nextChangePct) - Math.abs(previousChangePct) >= PRICE_REVISION_DELTA_PERCENT
        || rank[nextSeverity] > rank[previousSeverity];
}

export function isEligiblePriceSecurity(security: FavoriteSecurity, observedAt: Date): boolean {
    if (/^[48]/.test(security.symbol)) return false;
    if (/\*?ST|退/.test(security.stockName.toUpperCase())) return false;
    if (!security.listDate || !/^\d{8}$/.test(security.listDate)) return false;

    const listedAt = Date.UTC(
        Number(security.listDate.slice(0, 4)),
        Number(security.listDate.slice(4, 6)) - 1,
        Number(security.listDate.slice(6, 8)),
    );
    if (!Number.isFinite(listedAt)) return false;
    return observedAt.getTime() - listedAt >= NEW_STOCK_EXCLUSION_DAYS * 24 * 60 * 60 * 1000;
}
