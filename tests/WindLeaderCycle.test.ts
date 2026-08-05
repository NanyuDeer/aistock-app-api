import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCycle } from '../src/modules/monitor/WindLeaderAnalyzerService';

test('deriveCycle: 长线天数≥30且置信≥0.5 → long', () => {
    assert.equal(deriveCycle({ long_term_days: 45, long_confidence: 0.8, short_term_days: 0, short_heat: 0 }), 'long');
});

test('deriveCycle: 长线置信不足0.5 → 非long', () => {
    assert.notEqual(deriveCycle({ long_term_days: 45, long_confidence: 0.4, short_term_days: 0, short_heat: 0 }), 'long');
});

test('deriveCycle: 短线天数≥1且热度≥0.3 → short', () => {
    assert.equal(deriveCycle({ long_term_days: 0, long_confidence: 0, short_term_days: 5, short_heat: 0.6 }), 'short');
});

test('deriveCycle: 同时满足长短线 → both', () => {
    assert.equal(deriveCycle({ long_term_days: 45, long_confidence: 0.8, short_term_days: 3, short_heat: 0.5 }), 'both');
});

test('deriveCycle: 全 0/缺失 → short（兜底）', () => {
    assert.equal(deriveCycle({}), 'short');
});
