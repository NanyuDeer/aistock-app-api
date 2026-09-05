/**
 * insight_article 证据域：collectInsightArticleSources 查询当日命中该股的
 * watchlist_insight_sources 文章并映射为 source record；复用域判定含 insight_article。
 * 运行：node --import tsx --test src/modules/stock-trace/__tests__/insightArticleEvidence.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    toInsightArticleSourceRecord,
    pickReusableSources,
} from '../StockTraceSnapshotService';
import type { StockSourceRecord } from '../types';

describe('insight_article 证据域', () => {
    it('toInsightArticleSourceRecord 映射正确', () => {
        const row = {
            article_id: 'art_001',
            source_url: 'https://example.com/article/1',
            title: '涨停雷达：某股票异动分析',
            keywords: ['市场热点', '资金流向', 123, '主力资金', '板块效应', '成交量', '技术形态', '消息面', '龙虎榜', '业绩预告', '行业政策'],
            content: '今日市场出现异动，某股票在盘中快速拉升...',
            published_at: new Date('2026-08-30T10:00:00Z'),
        };
        const symbol = '600000';
        const capturedAt = new Date('2026-08-30T10:05:00Z');
        const record = toInsightArticleSourceRecord(row, symbol, capturedAt);

        // kind 与 sourceId
        assert.equal(record.kind, 'insight_article');
        assert.equal(record.sourceId, 'ths-radar:art_001');

        // 基本信息
        assert.equal(record.title, '涨停雷达：某股票异动分析');
        assert.ok(record.contentExcerpt.length <= 600, 'contentExcerpt 应被截断至 600 字符以内');
        assert.equal(record.canonicalUrl, 'https://example.com/article/1');
        assert.equal(record.sourceRef, 'art_001');

        // 时间
        assert.equal(record.occurredAt?.toISOString(), '2026-08-30T10:00:00.000Z');

        // payload.keywords：过滤非字符串（123 被过滤），截断到 8 条
        assert.ok(Array.isArray(record.payload.keywords));
        // 原始 keywords 有 10 个字符串 + 1 个数字，过滤后剩 10 个字符串，再截断到 8
        assert.equal(record.payload.keywords.length, 8, 'keywords 应截断至 8 条');
        assert.equal(record.payload.keywords[0], '市场热点');
        assert.equal(record.payload.keywords[7], '龙虎榜');
        // 非字符串 123 应被过滤
        assert.ok(record.payload.keywords.every((k: unknown) => typeof k === 'string'), 'keywords 应为纯字符串数组');
    });

    it('toInsightArticleSourceRecord 处理空 source_url 和超长 content', () => {
        const row = {
            article_id: 'art_002',
            source_url: '',
            title: '简短标题',
            keywords: null,
            content: 'A'.repeat(1000),
            published_at: new Date('2026-08-30T11:00:00Z'),
        };
        const symbol = '600001';
        const capturedAt = new Date('2026-08-30T11:05:00Z');
        const record = toInsightArticleSourceRecord(row, symbol, capturedAt);

        // canonicalUrl 为空时应为 undefined
        assert.equal(record.canonicalUrl, undefined);
        // contentExcerpt 截断
        assert.ok(record.contentExcerpt.length <= 600);
        // keywords 为 null 时 payload.keywords 应为空数组
        assert.ok(Array.isArray(record.payload.keywords));
        assert.equal(record.payload.keywords.length, 0);
    });

    it('pickReusableSources 包含 insight_article（盘中文章固定，修订复用）', () => {
        const record = {
            sourceId: 'ths-radar:c680000000', kind: 'insight_article', provider: 'ths_limit_up_radar',
            sourceLevel: 'B' as const, title: 't', contentExcerpt: 'e', symbol: '600000',
            occurredAt: new Date(), capturedAt: new Date(), payload: {},
        } as StockSourceRecord;
        const reused = pickReusableSources([record]);
        assert.equal(reused.length, 1, 'insight_article 应被复用（盘中文章基本不变）');
        assert.equal(reused[0]!.kind, 'insight_article');
    });
});