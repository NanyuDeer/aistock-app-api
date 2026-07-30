import assert from 'node:assert/strict';
import test from 'node:test';
import { stockTraceStableHash } from '../StockTraceSnapshotService';

test('snapshot source hash is key-order independent and preserves trigger time', () => {
    const first = stockTraceStableHash({ b: 2, a: 1, triggered_at: new Date('2026-07-30T02:15:00.000Z') });
    const reordered = stockTraceStableHash({ a: 1, triggered_at: new Date('2026-07-30T02:15:00.000Z'), b: 2 });
    const later = stockTraceStableHash({ a: 1, b: 2, triggered_at: new Date('2026-07-30T02:15:01.000Z') });

    assert.equal(first, reordered);
    assert.notEqual(first, later);
});
