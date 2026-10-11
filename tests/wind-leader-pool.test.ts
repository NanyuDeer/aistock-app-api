import test from 'node:test';
import assert from 'node:assert/strict';
import { computePoolNames, rankTrack, LONG_POOL_MIN_FREQ } from '../src/modules/monitor/WindLeaderAnalyzerService';

/**
 * 双池预筛口径（2026-10-11 调整）：
 * - 长线池门槛下调：LONG_POOL_MIN_FREQ 16 → 8（上榜次数改「只算涨幅榜」后数值约减半，等比对齐原强度）
 * - 短线池不设门槛：全部候选入池，由下游按 freq20 排序取 top8
 */

test('computePoolNames：短线池不设门槛（全部候选入池，含 freq20=0）', () => {
    const cands = [
        { name: 'A', frequency: 5, freq20: 0 },
        { name: 'B', frequency: 3, freq20: 2 },
        { name: 'C', frequency: 1, freq20: 1 },
    ];
    const { shortNames } = computePoolNames(cands);
    assert.deepEqual([...shortNames].sort(), ['A', 'B', 'C'], '所有候选都应进入短线池');
});

test('computePoolNames：长线池门槛为 8（LONG_WINDOW 内涨幅榜上榜 ≥8 次）', () => {
    assert.equal(LONG_POOL_MIN_FREQ, 8);
    const cands = [
        { name: 'A', frequency: 8, freq20: 0 },
        { name: 'B', frequency: 7, freq20: 0 },
        { name: 'C', frequency: 35, freq20: 2 },
    ];
    const { longNames } = computePoolNames(cands);
    assert.deepEqual([...longNames].sort(), ['A', 'C'], 'freq≥8 入长线池，freq=7 不入');
});

test('rankTrack：短线轨道按 freq20 降序（不按 freq120 主导的评分）', () => {
    const items = [
        { name: 'LongHigh', frequency: 35, freq20: 0, score: 300 },
        { name: 'ShortHot', frequency: 6, freq20: 3, score: 120 },
        { name: 'ShortMid', frequency: 5, freq20: 2, score: 100 },
    ];
    // 短线：即便 LongHigh 评分最高，也应按 freq20 排在 ShortHot 之后
    assert.deepEqual(rankTrack(items, 'short', 2).map((x) => x.name), ['ShortHot', 'ShortMid']);
    // 长线：按评分
    assert.deepEqual(rankTrack(items, 'long', 2).map((x) => x.name), ['LongHigh', 'ShortHot']);
});

test('rankTrack：短线 freq20 相同时按评分降序', () => {
    const items = [
        { name: 'X', frequency: 10, freq20: 2, score: 100 },
        { name: 'Y', frequency: 10, freq20: 2, score: 200 },
    ];
    assert.deepEqual(rankTrack(items, 'short', 2).map((x) => x.name), ['Y', 'X']);
});
