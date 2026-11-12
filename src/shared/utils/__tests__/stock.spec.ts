/**
 * getStockIdentity：A 股代码段归属
 *
 * 回归：605 段（沪市主板，2019 年起启用）此前未覆盖 → 落到 unknown，
 * TushareService.toTsCode 生成 `605xxx.UNKNOWN` → 日线接口返回空 →
 * 趋势股技术面 NaN（实测 605006/605058 等 9 只、96 行全部 NaN）。
 *
 * 运行：node --import tsx --test src/shared/utils/__tests__/stock.spec.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getStockIdentity } from '../stock';

describe('getStockIdentity：沪市主板 605 段', () => {
    it('605xxx 归入沪市主板 sh', () => {
        const identity = getStockIdentity('605058');
        assert.equal(identity.market, 'sh');
        assert.equal(identity.board, '沪市主板');
        assert.equal(identity.eastmoneyId, 1);
        assert.equal(identity.tencentPrefix, 'sh');
    });
});
