// src/modules/stock-trace/__tests__/snapshotDomain.spec.ts
// 仓库惯例：node:test + assert，运行 node --import tsx --test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// 待实现：从 StockTraceSnapshotService 导出的 readiness 判定纯函数
import { buildDataReadiness } from '../StockTraceSnapshotService';

describe('buildDataReadiness（五域数据就绪判定）', () => {
    it('五域各有 complete/partial/missing 判定', () => {
        const r = buildDataReadiness([
            { layer: 'company', count: 2 }, { layer: 'sector', count: 0 },
            { layer: 'market', count: 3 }, { layer: 'capital', count: 1 },
            { layer: 'technical', count: 4 },
        ]);
        assert.deepEqual(r, {
            company: 'complete', sector: 'missing', market: 'complete',
            capital: 'partial', technical: 'complete',
        });
    });
    it('capital 无数据为 missing 而非 complete', () => {
        const r = buildDataReadiness([{ layer: 'capital', count: 0 }]);
        assert.equal(r.capital, 'missing');
    });
});