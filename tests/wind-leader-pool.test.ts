import test from 'node:test';
import assert from 'node:assert/strict';
import { computePoolNames, rankTrack, LONG_POOL_MIN_FREQ, SHORT_POOL_MIN_FREQ } from '../src/modules/monitor/WindLeaderAnalyzerService';

/**
 * 双池预筛口径（2026-10-11 调整）：
 * - 长线池门槛下调：LONG_POOL_MIN_FREQ 16 → 8（上榜次数改「只算涨幅榜」后数值约减半，等比对齐原强度）
 * - 短线池门槛 = 1：SHORT_WINDOW(20) 内涨幅榜上榜 ≥1 次才入池（排除近 20 日从未上过涨幅榜的板块）
 */

test('computePoolNames：短线池门槛为 1（freq10≥1 入池，freq10=0 不入）', () => {
    assert.equal(SHORT_POOL_MIN_FREQ, 1);
    const cands = [
        { name: 'A', freq120: 5, freq10: 0 },
        { name: 'B', freq120: 3, freq10: 2 },
        { name: 'C', freq120: 1, freq10: 1 },
    ];
    const { shortNames } = computePoolNames(cands);
    assert.deepEqual([...shortNames].sort(), ['B', 'C'], 'freq10≥1 入短线池，freq10=0 不入');
});

test('computePoolNames：长线池门槛为 8（LONG_WINDOW 内涨幅榜上榜 ≥8 次）', () => {
    assert.equal(LONG_POOL_MIN_FREQ, 8);
    const cands = [
        { name: 'A', freq120: 8, freq10: 0 },
        { name: 'B', freq120: 7, freq10: 0 },
        { name: 'C', freq120: 35, freq10: 2 },
    ];
    const { longNames } = computePoolNames(cands);
    assert.deepEqual([...longNames].sort(), ['A', 'C'], 'freq≥8 入长线池，freq=7 不入');
});

test('rankTrack：短线轨道按 freq10 降序（不按 freq120 主导的评分）', () => {
    const items = [
        { name: 'LongHigh', freq120: 35, freq10: 0, score: 300 },
        { name: 'ShortHot', freq120: 6, freq10: 3, score: 120 },
        { name: 'ShortMid', freq120: 5, freq10: 2, score: 100 },
    ];
    // 短线：即便 LongHigh 评分最高，也应按 freq10 排在 ShortHot 之后
    assert.deepEqual(rankTrack(items, 'short', 2).map((x) => x.name), ['ShortHot', 'ShortMid']);
    // 长线：按评分
    assert.deepEqual(rankTrack(items, 'long', 2).map((x) => x.name), ['LongHigh', 'ShortHot']);
});

test('rankTrack：短线 freq10 相同时按评分降序', () => {
    const items = [
        { name: 'X', freq120: 10, freq10: 2, score: 100 },
        { name: 'Y', freq120: 10, freq10: 2, score: 200 },
    ];
    assert.deepEqual(rankTrack(items, 'short', 2).map((x) => x.name), ['Y', 'X']);
});
