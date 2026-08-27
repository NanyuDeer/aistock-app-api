import assert from 'node:assert/strict';
import test from 'node:test';
import { canPublishStockTraceArtifact } from '../StockTraceArtifactService';
import type { StockTraceResult } from '../types';

function result(validationStatus: StockTraceResult['validationStatus']): StockTraceResult {
    return {
        resultId: 'result-1', eventId: 'event-1', snapshotId: 'snapshot-1', analysisVersion: 'v1',
        processingStatus: validationStatus === 'passed' ? 'completed' : 'partial',
        attributionStatus: 'insufficient', confidenceConfigVersion: 'v1', contradictions: [],
        unresolvedQuestions: [], missingCapabilities: [], suggestedActions: [], validationStatus,
        validationErrors: validationStatus === 'passed' ? [] : ['candidate:evidence_not_found'],
        candidates: [], chains: [],
    };
}

test('unit: Artifact publication is allowed only for a passed result', () => {
    assert.equal(canPublishStockTraceArtifact(result('passed')), true);
    assert.equal(canPublishStockTraceArtifact(result('pending')), false);
    assert.equal(canPublishStockTraceArtifact(result('rejected')), false);
    assert.equal(canPublishStockTraceArtifact(null), false);
});
