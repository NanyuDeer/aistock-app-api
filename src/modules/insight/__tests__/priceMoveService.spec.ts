// src/modules/insight/__tests__/priceMoveService.spec.ts
// 仓库惯例：node:test + assert（非 jest），运行 node --import tsx --test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeMoveBps } from '../PriceMoveService';

describe('computeMoveBps', () => {
    it('700 bps 触发（+7%）', () => {
        assert.equal(computeMoveBps(10, 10.7), 700);
    });
    it('699 bps 不触发（+6.99%）', () => {
        assert.equal(computeMoveBps(10000, 10699), 699);
    });
    it('下跌方向', () => {
        assert.equal(computeMoveBps(10, 9.3), -700);
    });
    it('今开无效返回 null（停牌/新股）', () => {
        assert.equal(computeMoveBps(0, 10), null);
    });
});