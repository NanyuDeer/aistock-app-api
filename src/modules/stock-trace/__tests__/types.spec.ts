import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createEventId,
    getSeverity,
    isEligiblePriceSecurity,
    isRevisionNeeded,
} from '../types';

test('price event id is stable for the original trigger instant', () => {
    const triggeredAt = new Date('2026-07-30T02:15:00.123Z');
    const first = createEventId('600519', '2026-07-30', triggeredAt, 'up');
    const second = createEventId('600519', '2026-07-30', triggeredAt, 'up');

    assert.equal(first, 'mv:600519:2026-07-30:1785377700123:up');
    assert.equal(second, first);
});

test('price revision requires a two percentage point expansion or severity upgrade', () => {
    assert.equal(isRevisionNeeded(7, 8.99, 'medium', getSeverity(8.99)), true);
    assert.equal(isRevisionNeeded(7, 8.5, 'medium', getSeverity(8.5)), true);
    assert.equal(isRevisionNeeded(7, 7.5, 'medium', getSeverity(7.5)), false);
    assert.equal(isRevisionNeeded(-7, -10, 'medium', getSeverity(-10)), true);
});

test('price eligibility excludes BSE, ST, new and delisting securities', () => {
    const observedAt = new Date('2026-07-30T06:00:00Z');
    const base = { symbol: '600519', stockName: '贵州茅台', market: 'sh', listDate: '20010827' };

    assert.equal(isEligiblePriceSecurity(base, observedAt), true);
    assert.equal(isEligiblePriceSecurity({ ...base, symbol: '830001' }, observedAt), false);
    assert.equal(isEligiblePriceSecurity({ ...base, stockName: '*ST示例' }, observedAt), false);
    assert.equal(isEligiblePriceSecurity({ ...base, stockName: '退市示例' }, observedAt), false);
    assert.equal(isEligiblePriceSecurity({ ...base, listDate: '20260701' }, observedAt), false);
    assert.equal(isEligiblePriceSecurity({ ...base, listDate: null }, observedAt), false);
});
