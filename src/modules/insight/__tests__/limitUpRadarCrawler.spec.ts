/**
 * 涨停雷达采集器 / 来源持久化 测试
 *
 * 仓库惯例：Node 内建 test runner（node:test）+ .spec.ts 命名 + __tests__ 目录，
 * 与简报中的 jest 写法不同，此处跟随仓库惯例。
 *
 * 运行：`node --import tsx --test src/modules/insight/__tests__/limitUpRadarCrawler.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import pool from '../../../core/db';
import { upsertSources } from '../InsightSourceService';
import {
    extractTradeDate,
    parseDetailHtml,
    parseListHtml,
    parseTitleKeywords,
} from '../LimitUpRadarCrawler';

afterEach(() => {
    mock.restoreAll();
});

// ==================== parseTitleKeywords ====================

describe('parseTitleKeywords', () => {
    it('解析"+"分隔的关键词', () => {
        assert.deepStrictEqual(
            parseTitleKeywords('涨停雷达：半导体靶材+央企+超跌反弹 东方钽业触及涨停'),
            ['半导体靶材', '央企', '超跌反弹'],
        );
    });

    it('支持全角"＋"分隔', () => {
        assert.deepStrictEqual(
            parseTitleKeywords('涨停雷达：算力＋CPO 中际旭创触及涨停'),
            ['算力', 'CPO'],
        );
    });

    it('无关键词前缀返回空数组', () => {
        assert.deepStrictEqual(parseTitleKeywords('涨停雷达：东方钽业触及涨停'), []);
    });

    it('负向：非涨停雷达标题返回空数组', () => {
        assert.deepStrictEqual(parseTitleKeywords('每日早盘资讯 大盘走势分析'), []);
        assert.deepStrictEqual(parseTitleKeywords(''), []);
    });
});

// ==================== extractTradeDate ====================

describe('extractTradeDate', () => {
    it('从详情 URL /YYYYMMDD/ 段提取日期', () => {
        assert.equal(
            extractTradeDate('https://yuanchuang.10jqka.com.cn/20260805/c678683171.shtml'),
            '2026-08-05',
        );
    });

    it('无法提取时返回空串', () => {
        assert.equal(extractTradeDate('https://yuanchuang.10jqka.com.cn/index_2.shtml'), '');
        assert.equal(extractTradeDate(''), '');
    });
});

// ==================== parseListHtml ====================

describe('parseListHtml', () => {
    const listHtml = `<div class="main">
        <a href="https://yuanchuang.10jqka.com.cn/20260805/c678683171.shtml">涨停雷达：半导体靶材+央企+超跌反弹 东方钽业触及涨停</a>
        <a href="https://yuanchuang.10jqka.com.cn/20260804/c678683172.shtml">涨停雷达：算力+CPO 中际旭创触及涨停</a>
        <a href="https://www.10jqka.com.cn/other_page.shtml">非列表链接应被忽略</a>
    </div>`;

    it('提取文章 ID、标题、tradeDate 与规范化 detailUrl', () => {
        const items = parseListHtml(listHtml);
        assert.equal(items.length, 2);

        assert.equal(items[0].articleId, 'c678683171');
        assert.equal(items[0].title, '涨停雷达：半导体靶材+央企+超跌反弹 东方钽业触及涨停');
        assert.equal(items[0].tradeDate, '2026-08-05');
        assert.equal(items[0].detailUrl, 'https://yuanchuang.10jqka.com.cn/20260805/c678683171.shtml');

        assert.equal(items[1].articleId, 'c678683172');
        assert.equal(items[1].tradeDate, '2026-08-04');
    });

    it('空 HTML 返回空数组', () => {
        assert.deepStrictEqual(parseListHtml(''), []);
    });
});

// ==================== parseDetailHtml ====================

describe('parseDetailHtml', () => {
    const detailHtml = `<div class="main">
        <div class="art_p">异动原因揭秘：公司主导产品为半导体级钽材料。</div>
        <p class="pub_time">2026-08-05 11:26:03</p>
        <p>相关标的：<a href="https://stockpage.10jqka.com.cn/000962/">东方钽业（000962）</a></p>
    </div>`;

    it('提取正文、文章提及标的与发布时间', () => {
        const detail = parseDetailHtml(detailHtml);
        assert.equal(detail.content, '异动原因揭秘：公司主导产品为半导体级钽材料。');
        assert.deepStrictEqual(detail.mentionedSymbols, [{ symbol: '000962', name: '东方钽业' }]);
        assert.equal(detail.publishedAt, '2026-08-05 11:26:03');
    });

    it('正文缺失时回退到 body 文本', () => {
        const detail = parseDetailHtml('<html><body>回退正文内容</body></html>');
        assert.equal(detail.content, '回退正文内容');
    });
});

// ==================== upsertSources ====================

describe('upsertSources', () => {
    const sampleArticle = {
        articleId: 'c678683171',
        detailUrl: 'https://yuanchuang.10jqka.com.cn/20260805/c678683171.shtml',
        title: '涨停雷达：半导体靶材+央企+超跌反弹 东方钽业触及涨停',
        keywords: ['半导体靶材', '央企', '超跌反弹'],
        content: '异动原因揭秘正文内容',
        mentionedSymbols: [{ symbol: '000962', name: '东方钽业' }],
        publishedAt: '2026-08-05 11:26:03',
        tradeDate: '2026-08-05',
    };

    it('INSERT 列清单与 016 迁移逐字一致，参数顺序正确，返回插入数', async () => {
        let capturedSql = '';
        let capturedParams: unknown[] = [];
        const mockQuery = (async (text: string, params?: unknown[]) => {
            capturedSql = text;
            capturedParams = params ?? [];
            return { rows: [{ was_inserted: true }] };
        }) as unknown as typeof pool.query;
        mock.method(pool, 'query', mockQuery);

        const inserted = await upsertSources([sampleArticle]);

        assert.equal(inserted, 1);
        assert.ok(capturedSql.includes('INSERT INTO watchlist_insight_sources'));
        assert.ok(capturedSql.includes(
            'source_id, source_url, article_id, trade_date, title, keywords, content, mentioned_symbols, published_at, content_hash, parser_version',
        ));
        assert.ok(capturedSql.includes('ON CONFLICT (article_id) DO UPDATE SET content_hash = EXCLUDED.content_hash'));
        assert.ok(capturedSql.includes('RETURNING xmax = 0 AS was_inserted'));

        const expectedHash = createHash('sha256').update(sampleArticle.content).digest('hex');
        assert.deepStrictEqual(capturedParams, [
            'c678683171',
            'https://yuanchuang.10jqka.com.cn/20260805/c678683171.shtml',
            'c678683171',
            '2026-08-05',
            '涨停雷达：半导体靶材+央企+超跌反弹 东方钽业触及涨停',
            '["半导体靶材","央企","超跌反弹"]',
            '异动原因揭秘正文内容',
            '[{"symbol":"000962","name":"东方钽业"}]',
            '2026-08-05 11:26:03',
            expectedHash,
            'mrnxgg-v1',
        ]);
    });

    it('ON CONFLICT 命中（was_inserted=false）不计入插入数', async () => {
        const mockQuery = (async () => ({ rows: [{ was_inserted: false }] })) as unknown as typeof pool.query;
        mock.method(pool, 'query', mockQuery);

        const inserted = await upsertSources([sampleArticle]);
        assert.equal(inserted, 0);
    });

    it('多篇文章逐条入库并累计插入数', async () => {
        let callCount = 0;
        const mockQuery = (async () => {
            callCount++;
            return { rows: [{ was_inserted: true }] };
        }) as unknown as typeof pool.query;
        mock.method(pool, 'query', mockQuery);

        const inserted = await upsertSources([sampleArticle, { ...sampleArticle, articleId: 'c678683172' }]);
        assert.equal(inserted, 2);
        assert.equal(callCount, 2);
    });
});
