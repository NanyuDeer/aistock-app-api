import assert from 'node:assert/strict';
import test from 'node:test';
import { mock } from 'node:test';
import fs from 'node:fs';
import pool from '../../../core/db';
import { queryTopTrendScore } from '../WindLeaderAnalyzerService';
import { WindLeaderService } from '../WindLeaderService';

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

// getAnalysis：接口返回板块时必须保留 long_leader 字段（读时显式枚举曾遗漏该字段导致前端恒为 null）
test('getAnalysis preserves long_leader field in response sectors', async () => {
    const fakeData = {
        update_time: '2026-08-14 13:00:00',
        hot_sectors: [{
            code: '881169',
            name: '贵金属',
            long_leader: { code: '600988', name: '赤峰黄金', score: 74, reason: '趋势评分B' },
            main_stocks: [],
            upstream_stocks: [],
            downstream_stocks: [],
        }],
    };
    mock.method(fs, 'existsSync', () => true);
    mock.method(fs, 'readFileSync', () => JSON.stringify(fakeData));
    try {
        const result = await WindLeaderService.getAnalysis(5);
        assert.ok(result, '应返回分析结果');
        const sector = result.hot_sectors[0] as Record<string, unknown>;
        const leader = sector?.long_leader as { code?: string; name?: string } | null | undefined;
        assert.ok(leader, 'long_leader 不应被读时过滤丢弃');
        assert.equal(leader.code, '600988');
        assert.equal(leader.name, '赤峰黄金');
    } finally {
        mock.restoreAll();
    }
});
