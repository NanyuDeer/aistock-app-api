import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCycle, applyDualRankings } from '../src/modules/monitor/WindLeaderAnalyzerService';

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

test('applyDualRankings: 长线榜按 long_term_days 降序取 top8', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
        name: `s${i}`, cycle: 'long' as const, long_term_days: i, short_term_days: 0,
    }));
    const ranked = applyDualRankings(items);
    const longBoard = ranked.filter(s => s.cycle === 'long');
    assert.equal(longBoard.length, 8);
    assert.equal(longBoard[0].long_term_days, 11); // 最大在前
    assert.ok(longBoard[7].long_term_days <= longBoard[0].long_term_days);
});

test('applyDualRankings: both 同时进两榜但合并去重', () => {
    const items = [
        { name: 'A', cycle: 'both' as const, long_term_days: 40, short_term_days: 5 },
        { name: 'B', cycle: 'long' as const, long_term_days: 35, short_term_days: 0 },
        { name: 'C', cycle: 'short' as const, long_term_days: 0, short_term_days: 8 },
    ];
    const ranked = applyDualRankings(items);
    assert.equal(ranked.length, 3); // A 只出现一次
    assert.ok(ranked.findIndex(s => s.name === 'A') < ranked.findIndex(s => s.name === 'B')); // A 在长线榜位置
});

test('applyDualRankings: 短线上限 8 且按 short_term_days 降序', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
        name: `s${i}`, cycle: 'short' as const, long_term_days: 0, short_term_days: i,
    }));
    const ranked = applyDualRankings(items);
    const shortBoard = ranked.filter(s => s.cycle === 'short');
    assert.equal(shortBoard.length, 8);
    assert.equal(shortBoard[0].short_term_days, 9);
});
