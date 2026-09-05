// src/modules/stock-trace/__tests__/snapshotDomain.spec.ts
// 仓库惯例：node:test + assert，运行 node --import tsx --test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// 待实现：从 StockTraceSnapshotService 导出的 readiness 判定纯函数
import { buildDataReadiness } from '../StockTraceSnapshotService';

describe('buildDataReadiness（六域数据就绪判定，2026-08-30 增 article 域）', () => {
    it('六域各有 complete/partial/missing 判定', () => {
        const r = buildDataReadiness([
            { layer: 'company', count: 2 }, { layer: 'sector', count: 0 },
            { layer: 'market', count: 3 }, { layer: 'capital', count: 1 },
            { layer: 'technical', count: 4 }, { layer: 'article', count: 1 },
        ]);
        assert.deepEqual(r, {
            company: 'complete', sector: 'missing', market: 'complete',
            capital: 'partial', technical: 'complete', article: 'complete',
        });
    });
    it('未提供 article 输入时默认 missing（不阻塞归因）', () => {
        const r = buildDataReadiness([{ layer: 'capital', count: 1 }]);
        assert.equal(r.article, 'missing');
    });
    it('capital 无数据为 missing 而非 complete', () => {
        const r = buildDataReadiness([{ layer: 'capital', count: 0 }]);
        assert.equal(r.capital, 'missing');
    });
});