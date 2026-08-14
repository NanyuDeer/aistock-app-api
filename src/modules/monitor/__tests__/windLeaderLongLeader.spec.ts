import assert from 'node:assert/strict';
import test from 'node:test';
import { mock } from 'node:test';
import pool from '../../../core/db';
import { queryTopTrendScore } from '../WindLeaderAnalyzerService';

// queryTopTrendScore：板块成分股中长期趋势龙头（trend_scores 评分最高）查询

test('queryTopTrendScore returns null for empty codes', async () => {
    assert.equal(await queryTopTrendScore([]), null);
    assert.equal(await queryTopTrendScore(null as unknown as string[]), null);
});

test('queryTopTrendScore returns highest scored trend stock from DB rows', async () => {
    const queryMock = mock.method(pool, 'query', async () => ({
        rows: [{
            symbol: '300750',
            score: 81,
            label: 'A',
            name: '宁德时代',
            industry: '电池',
        }],
    }));
    try {
        const result = await queryTopTrendScore(['300750', '600519']);
        assert.ok(result, '应返回命中的趋势股');
        assert.equal(result!.code, '300750');
        assert.equal(result!.name, '宁德时代');
        assert.equal(result!.score, 81);
        assert.equal(result!.reason_tag, 'A');
        assert.equal(result!.source, 'trend_score');
        // SQL 应带评分日期/评级/60日线过滤
        const sql = String(queryMock.mock.calls[0]?.arguments?.[0] ?? '');
        assert.ok(sql.includes('MAX(score_date)'), 'SQL 应取最新评分日');
        assert.ok(sql.includes("NOT IN ('D')"), 'SQL 应排除 D 评级');
        assert.ok(sql.includes('ma60_excluded'), 'SQL 应排除 MA60 剔除股');
    } finally {
        queryMock.mock.restore();
    }
});

test('queryTopTrendScore returns null when no trend score hit', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    try {
        assert.equal(await queryTopTrendScore(['000001']), null);
    } finally {
        mock.restoreAll();
    }
});

test('queryTopTrendScore returns null on DB error (fallback path)', async () => {
    mock.method(pool, 'query', async () => { throw new Error('db down'); });
    try {
        assert.equal(await queryTopTrendScore(['600519']), null);
    } finally {
        mock.restoreAll();
    }
});
