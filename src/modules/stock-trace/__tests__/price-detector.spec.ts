/**
 * PriceTriggerDetector.detect 分批并发（Task 5）
 *
 * 覆盖 splitIntoBatches 纯函数：自选股按 DETECT_CONCURRENCY(=5) 分批、保留顺序、
 * 空数组与超大批均正确的行为。
 *
 * 运行：node --import tsx --test src/modules/stock-trace/__tests__/price-detector.spec.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitIntoBatches } from '../PriceTriggerDetector';

describe('splitIntoBatches（detect 并发分批）', () => {
    it('按 size 分批且保留顺序', () => {
        assert.deepEqual(splitIntoBatches([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]]);
    });
    it('空数组返回空', () => {
        assert.deepEqual(splitIntoBatches([], 5), []);
    });
    it('size 大于长度时单批', () => {
        assert.deepEqual(splitIntoBatches(['a', 'b'], 5), [['a', 'b']]);
    });
});