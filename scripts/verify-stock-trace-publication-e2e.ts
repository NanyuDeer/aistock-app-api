/**
 * E2E contract check against the QA Node service and a seeded user event.
 * Required: STOCK_TRACE_E2E_EVENT_ID, STOCK_TRACE_E2E_BEARER_TOKEN.
 * Optional: STOCK_TRACE_E2E_BASE_URL (default http://127.0.0.1:3001),
 * STOCK_TRACE_E2E_EXPECTED_STATUS (completed | unavailable).
 */
import assert from 'node:assert/strict';

const eventId = process.env.STOCK_TRACE_E2E_EVENT_ID;
const bearerToken = process.env.STOCK_TRACE_E2E_BEARER_TOKEN;
const baseUrl = process.env.STOCK_TRACE_E2E_BASE_URL || 'http://127.0.0.1:3001';
const expected = process.env.STOCK_TRACE_E2E_EXPECTED_STATUS as 'completed' | 'unavailable' | undefined;

if (!eventId || !bearerToken || !expected) {
    throw new Error('Set STOCK_TRACE_E2E_EVENT_ID, STOCK_TRACE_E2E_BEARER_TOKEN and STOCK_TRACE_E2E_EXPECTED_STATUS');
}

async function main(): Promise<void> {
    const response = await fetch(`${baseUrl}/api/cn/favorites/movements/${encodeURIComponent(eventId)}/analysis`, {
        headers: { Authorization: `Bearer ${bearerToken}` },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { code: number; data: Record<string, unknown> };
    assert.equal(payload.code, 200);
    assert.equal(payload.data.processing_status, expected);

    if (expected === 'completed') {
        const artifact = payload.data.artifact as { movementView?: { schemaVersion?: string } } | null;
        assert.ok(artifact);
        assert.equal(artifact.movementView?.schemaVersion, 'movement-view-v2');
        assert.equal(payload.data.unavailable, undefined);
    } else {
        assert.equal(payload.data.artifact, null);
        const unavailable = payload.data.unavailable as { message?: string; triggerFacts?: Record<string, unknown> } | undefined;
        assert.equal(unavailable?.message, '原因暂不可用');
        assert.ok(unavailable?.triggerFacts?.event_id);
        const rendered = JSON.stringify(payload.data);
        assert.doesNotMatch(rendered, /"candidates"|"chains"|"evidence_index"/);
    }

    console.log(`[stock-trace-e2e] ${expected} contract passed for ${eventId}`);
}

void main().catch((error: unknown) => {
    console.error('[stock-trace-e2e] failed:', error);
    process.exitCode = 1;
});
