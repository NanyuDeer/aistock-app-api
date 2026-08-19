// src/modules/insight/__tests__/evidencePackageService.spec.ts
// 仓库惯例：node:test + assert（非 jest）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeTimeBucket } from '../EvidencePackageService';

describe('computeTimeBucket', () => {
    it('T-1 新闻 → T0', () => assert.equal(computeTimeBucket(1, 'news'), 'T0'));
    it('当日公告 → T0', () => assert.equal(computeTimeBucket(0, 'announcement'), 'T0'));
    it('T-3 研报 → T1', () => assert.equal(computeTimeBucket(3, 'rating'), 'T1'));
    it('T-8 政策 → T2', () => assert.equal(computeTimeBucket(8, 'news'), 'T2'));
    it('业绩类 → earnings 特例（不受 offset 限制，可追溯 T-20）', () => assert.equal(computeTimeBucket(15, 'earnings'), 'earnings'));
});