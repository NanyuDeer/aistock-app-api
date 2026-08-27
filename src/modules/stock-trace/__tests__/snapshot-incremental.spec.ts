// src/modules/stock-trace/__tests__/snapshot-incremental.spec.ts
// 仓库惯例：node:test + assert，运行 node --import tsx --test
// 运行：node --import tsx --test src/modules/stock-trace/__tests__/snapshot-incremental.spec.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickReusableSources, reusedDomainAvailability } from '../StockTraceSnapshotService';
import type { StockSourceRecord } from '../types';

function rec(sourceId: string, kind: string): StockSourceRecord {
    return {
        sourceId, kind: kind as StockSourceRecord['kind'], provider: 't', sourceLevel: 'B', title: sourceId, contentExcerpt: '',
        symbol: '600000', capturedAt: new Date(), payload: {}, contentHash: sourceId,
    };
}

describe('pickReusableSources（增量采集复用域判定）', () => {
    it('复用 news/announcement/sector/market，剔除 capital/technical/trigger/quote', () => {
        const input = [
            rec('t1', 'trigger_fact'), rec('q1', 'quote_fact'),
            rec('n1', 'news'), rec('a1', 'announcement'),
            rec('s1', 'sector_fact'), rec('m1', 'market_fact'),
            rec('c1', 'capital_fact'), rec('k1', 'technical_fact'),
        ];
        const reused = pickReusableSources(input).map((r) => r.kind);
        assert.deepEqual(reused, ['news', 'announcement', 'sector_fact', 'market_fact']);
    });
});

describe('reusedDomainAvailability（增量就绪读数）', () => {
    it('公司域 news/announcement 任一存在即映射 company 层', () => {
        const counts = reusedDomainAvailability([
            rec('a1', 'announcement'), rec('s1', 'sector_fact'), rec('m1', 'market_fact'),
        ]);
        assert.deepEqual(counts, [
            { layer: 'company', count: 1 },
            { layer: 'sector', count: 1 },
            { layer: 'market', count: 1 },
        ]);
    });
    it('无复用 record 时返回空数组', () => {
        assert.deepEqual(reusedDomainAvailability([]), []);
    });
});