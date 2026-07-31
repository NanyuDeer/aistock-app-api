import assert from 'node:assert/strict';
import test from 'node:test';
import { presentStockTraceAnalysis, TRACE_REASON_UNAVAILABLE } from '../StockTracePresentation';
import type { StockTraceArtifact, StockTraceResult } from '../types';

const event = {
    event_id: 'mv:000004:2026-07-30:1:up', trigger_revision: 2, symbol: '000004',
    stock_name: 'Test Stock', event_type: 'price', direction: 'up',
    triggered_at: '2026-07-30T02:15:00.000Z', window_start_at: '2026-07-30T02:00:00.000Z',
    window_end_at: '2026-07-30T02:15:00.000Z', latest_price: 22, previous_close: 20,
    change_pct: 10, threshold_pct: 7, severity: 'critical', rule_version: 'price-v1',
    fact_status: 'frozen',
};

const rejectedResult = {
    validationStatus: 'rejected', processingStatus: 'partial',
    candidates: [{ verdict: 'raw LLM text must never reach the client' }],
} as unknown as StockTraceResult;

test('integration: rejected result exposes trigger facts and a fixed unavailable message only', () => {
    const response = presentStockTraceAnalysis(event, null, rejectedResult);

    assert.equal(response.processingStatus, 'unavailable');
    assert.equal(response.artifact, null);
    assert.equal(response.unavailable?.message, TRACE_REASON_UNAVAILABLE);
    assert.deepEqual(response.unavailable?.triggerFacts, event);
    assert.doesNotMatch(JSON.stringify(response), /raw LLM text/);
});

test('validated artifact is the only path that exposes Movement View', () => {
    const artifact = {
        artifactId: 'artifact-1', eventId: event.event_id, snapshotId: 'snapshot-1', resultId: 'result-1',
        artifactVersion: 1, analysisVersion: 'llm-stock-trace-v1', artifactJson: {},
        movementView: { schemaVersion: 'movement-view-v2', eventId: event.event_id, artifactId: 'artifact-1', artifactVersion: 1, status: 'confirmed', alternatives: [], unresolvedQuestions: [], suggestedActions: [], evidenceCount: 1, generatedAt: event.triggered_at },
        validationReport: { status: 'passed', errors: [] }, isEffective: true,
        createdAt: event.triggered_at, expiresAt: '2027-01-26T02:15:00.000Z',
    } as StockTraceArtifact;

    const response = presentStockTraceAnalysis(event, artifact, rejectedResult);
    assert.equal(response.processingStatus, 'completed');
    assert.equal(response.artifact?.movementView.schemaVersion, 'movement-view-v2');
    assert.equal(response.unavailable, undefined);
});

test('pending result remains processing and has no Movement View or unavailable payload', () => {
    const response = presentStockTraceAnalysis(event, null, null);
    assert.deepEqual(response, { processingStatus: 'processing', artifact: null });
});
