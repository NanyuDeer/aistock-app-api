import test from 'node:test';
import assert from 'node:assert/strict';
import { computePoolNames, LONG_POOL_MIN_FREQ } from '../src/modules/monitor/WindLeaderAnalyzerService';

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
