// src/modules/insight/__tests__/priceMoveService.spec.ts
// 仓库惯例：node:test + assert（非 jest），运行 node --import tsx --test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeMoveBps, extractPrices } from '../PriceMoveService';

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

describe('extractPrices', () => {
    it('解析 TencentQuoteService 键名：最新价/今开价/昨收价/涨跌幅（activity 字段集）', () => {
        assert.deepEqual(
            extractPrices({ '股票代码': 'sh600519', '最新价': 685, '今开价': 680, '昨收价': 660, '涨跌幅': 3.79 }),
            { latest: 685, open: 680, prevClose: 660, changePct: 3.79 },
        );
    });
    it('兼容英文键 latest/open/prevClose/changePct', () => {
        assert.deepEqual(
            extractPrices({ symbol: '600519', latest: 10.5, open: 10, prevClose: 9.8, changePct: 7.14 }),
            { latest: 10.5, open: 10, prevClose: 9.8, changePct: 7.14 },
        );
    });
    it('昨收/涨跌幅缺失返回 null（无法按相对昨收判定则不触发）', () => {
        assert.deepEqual(
            extractPrices({ '股票代码': '600519', '最新价': 685, '今开价': 680 }),
            { latest: 685, open: 680, prevClose: null, changePct: null },
        );
    });
    it('字段缺失返回 null', () => {
        assert.deepEqual(
            extractPrices({ '股票代码': '600519' }),
            { latest: null, open: null, prevClose: null, changePct: null },
        );
    });
});