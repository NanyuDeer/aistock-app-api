import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    buildSourceRef,
    dueIndex,
    forwardReturn,
    judge,
    parseSourceRef,
    selectNonOverlapping,
} from '../claimVerification';

test('buildSourceRef 与 parseSourceRef 可往返', () => {
    const ref = buildSourceRef({
        dim: 'breadth', bucket: 0, horizon: 20,
        segment: 'ALL', caliber: 'ew_all', specVersion: 'v1',
    });
    assert.equal(ref, 'frd:breadth|0|20|ALL|ew_all|v1');
    assert.deepEqual(parseSourceRef(ref), {
        dim: 'breadth', bucket: 0, horizon: 20,
        segment: 'ALL', caliber: 'ew_all', specVersion: 'v1',
    });
});

test('parseSourceRef 拒绝畸形输入', () => {
    for (const bad of [null, undefined, '', 'breadth|0|20|ALL|ew_all|v1', 'frd:a|b|20|ALL|ew_all|v1', 'frd:a|0|x|ALL|ew_all|v1', 'frd:a|0|20|ALL|ew_all']) {
        assert.equal(parseSourceRef(bad as string | null | undefined), null);
    }
});

test('judge 判方向与区间', () => {
    assert.deepEqual(judge(0.02, -0.03, 0.06), { isUp: true, inIqr: true });
    assert.deepEqual(judge(-0.02, -0.03, 0.06), { isUp: false, inIqr: true });
    assert.deepEqual(judge(0.09, -0.03, 0.06), { isUp: true, inIqr: false });
    // 边界：正好等于 P25/P75 算在区间内
    assert.deepEqual(judge(0.06, -0.03, 0.06), { isUp: true, inIqr: true });
    assert.deepEqual(judge(0, -0.03, 0.06), { isUp: false, inIqr: true });
});

test('dueIndex 按交易日推进，越界返回 null', () => {
    const dates = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
    assert.equal(dueIndex(dates, '2026-11-02', 2), 2);
    assert.equal(dueIndex(dates, '2026-11-04', 1), 3);
    // 到期日超出已知交易日 → 未到期
    assert.equal(dueIndex(dates, '2026-11-04', 5), null);
    // as_of 不在序列里
    assert.equal(dueIndex(dates, '2026-10-01', 1), null);
});

test('forwardReturn 从 as_of 的次一交易日起复利', () => {
    // as_of 在 idx0；第 1、2 天的收益用于 2 日窗口
    const rets = [0.99, 0.10, -0.05, 0.02];
    const r = forwardReturn(rets, 0, 2) as number;
    assert.ok(Math.abs(r - (1.10 * 0.95 - 1)) < 1e-12);

    // 窗口超界 → null
    assert.equal(forwardReturn(rets, 0, 4), null);
    // 窗口内有 NaN → null（不插值、不跳过）
    assert.equal(forwardReturn([0, 0.1, Number.NaN, 0.02], 0, 2), null);
});

test('selectNonOverlapping 按窗口去重叠', () => {
    // 20 日窗口：取 idx0 后，idx1..19 都应被跳过，idx20 才是下一条独立样本
    const rows = [0, 1, 5, 19, 20, 21, 40].map((asOfIdx) => ({ asOfIdx, horizonDays: 20 }));
    const kept = selectNonOverlapping(rows).map((r) => r.asOfIdx);
    assert.deepEqual(kept, [0, 20, 40]);
});
