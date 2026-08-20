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

test('deriveCycle: 全 0/缺失 → none（四态化兜底，不无条件归 short）', () => {
    assert.equal(deriveCycle({}), 'none');
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

test('applyDualRankings: 短线上限 8 且按上榜次数(freq20)→热度(short_heat) 降序', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
        name: `s${i}`, cycle: 'short' as const, long_term_days: 0, short_term_days: i,
        freq20: i % 3,
        ai_analysis: { short_heat: 0.1 * (i + 1) },
    }));
    const ranked = applyDualRankings(items);
    const shortBoard = ranked.filter(s => s.cycle === 'short');
    assert.equal(shortBoard.length, 8);
    for (let i = 1; i < shortBoard.length; i++) {
        const prev = shortBoard[i - 1];
        const cur = shortBoard[i];
        const prevFreq = prev.freq20 ?? 0;
        const curFreq = cur.freq20 ?? 0;
        assert.ok(prevFreq >= curFreq, `上榜次数应降序: ${prev.name}(${prevFreq}) -> ${cur.name}(${curFreq})`);
        if (prevFreq === curFreq) {
            const prevHeat = prev.ai_analysis?.short_heat ?? 0;
            const curHeat = cur.ai_analysis?.short_heat ?? 0;
            assert.ok(prevHeat >= curHeat, `同上榜次数内热度应降序: ${prev.name}(${prevHeat}) -> ${cur.name}(${curHeat})`);
        }
    }
});
