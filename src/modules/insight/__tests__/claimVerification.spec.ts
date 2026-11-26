import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    buildSourceRef,
    judge,
    parseSourceRef,
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
