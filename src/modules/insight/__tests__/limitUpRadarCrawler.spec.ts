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
    parseLimitUpSymbolsFromSummary,
    parseListHtml,
    parseTitleKeywords,
    parseTitleStockName,
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

// ==================== parseTitleStockName ====================

describe('parseTitleStockName', () => {
    it('提取"触及涨停"前的主体股票名', () => {
        assert.equal(parseTitleStockName('涨停雷达：人形机器人概念+电子皮肤+汽车内饰 明新旭腾触及涨停'), '明新旭腾');
        assert.equal(parseTitleStockName('涨停雷达：CPO+AI数据中心+半年报预增+海底光缆 亨通光电触及涨停'), '亨通光电');
    });

    it('无关键词前缀时仍能提取股票名', () => {
        assert.equal(parseTitleStockName('涨停雷达：东方钽业触及涨停'), '东方钽业');
    });

    it('股票名带括号代码时去除代码', () => {
        assert.equal(parseTitleStockName('涨停雷达：算力+CPO 中际旭创(300308)触及涨停'), '中际旭创');
        assert.equal(parseTitleStockName('涨停雷达：算力+CPO 中际旭创（300308）触及涨停'), '中际旭创');
    });

    it('负向：涨停复盘类标题（无主体股票）返回 null', () => {
        assert.equal(parseTitleStockName('涨停复盘：科创50指数低开低走跌超5% 核电板块逆势走强'), null);
        assert.equal(parseTitleStockName('涨停复盘：创业板指高开高走大涨5.64% 算力硬件股集体爆发'), null);
        assert.equal(parseTitleStockName(''), null);
        assert.equal(parseTitleStockName('每日早盘资讯'), null);
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

// ==================== parseLimitUpSymbolsFromSummary ====================

describe('parseLimitUpSymbolsFromSummary', () => {
    // 模拟 2026-08-20 涨停复盘文章正文（涨停/涨超/触及跌停/跌幅居前 多种语境并存）
    const content = 'A股三大指数集体上涨。创新药、贵金属板块涨幅居前。'
        + '创新药（002173）板块高开高走掀涨停潮，沃森生物（300142）、智飞生物（300122）、康泰生物（300601）等20余股涨停，'
        + '新开源（300109）、华兰股份（301093）等多股涨超10%。'
        + '贵金属板块表现强势，兴业银钼（000426）、赤峰黄金（600988）涨幅居前。'
        + '小金属板块震荡下行，长缆集团（603407）盘中触及跌停，华阳新材（600281）跌幅居前。';
    const mentioned = [
        { symbol: '002173', name: '创新药' },      // 板块名，先"涨幅居前"后"涨停潮" → 命中
        { symbol: '300142', name: '沃森生物' },    // 涨停
        { symbol: '300122', name: '智飞生物' },    // 涨停
        { symbol: '300601', name: '康泰生物' },    // 涨停
        { symbol: '300109', name: '新开源' },      // 涨超
        { symbol: '301093', name: '华兰股份' },    // 涨超
        { symbol: '000426', name: '兴业银钼' },    // 涨幅居前 → 排除
        { symbol: '600988', name: '赤峰黄金' },    // 涨幅居前 → 排除
        { symbol: '603407', name: '长缆集团' },    // 触及跌停 → 排除
        { symbol: '600281', name: '华阳新材' },    // 跌幅居前 → 排除
        { symbol: '000001', name: '平安银行' },    // 正文未提及 → 排除
    ];

    it('提取"涨停/涨超"语境个股，排除跌停/跌幅/涨幅居前/未提及', () => {
        const result = parseLimitUpSymbolsFromSummary(content, mentioned);
        assert.deepStrictEqual(result.map(s => s.symbol).sort(), ['002173', '300109', '300122', '300142', '300601', '301093']);
    });

    it('个股名先以非涨停语境出现、后以涨停语境出现时命中（检查全部出现位置）', () => {
        // 创新药 开头"涨幅居前"（不命中），后"涨停潮"（命中）
        const hit = parseLimitUpSymbolsFromSummary(content, [{ symbol: '002173', name: '创新药' }]);
        assert.equal(hit.length, 1);
        assert.equal(hit[0].symbol, '002173');
    });

    it('正文为空或个股列表为空返回空数组', () => {
        assert.deepStrictEqual(parseLimitUpSymbolsFromSummary('', mentioned), []);
        assert.deepStrictEqual(parseLimitUpSymbolsFromSummary(content, []), []);
    });

    it('名称含正则特殊字符时安全匹配（防御转义）', () => {
        const c = 'ST某某（000001）涨停。';
        const result = parseLimitUpSymbolsFromSummary(c, [{ symbol: '000001', name: 'ST某某' }]);
        assert.equal(result.length, 1);
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
        assert.ok(capturedSql.includes('ON CONFLICT (article_id) DO UPDATE SET'));
        // 冲突时同步刷新正文/标题/关键词/提及标的/发布时间 + content_hash/parser_version（正文与 hash 一致）
        assert.ok(capturedSql.includes('content = EXCLUDED.content'));
        assert.ok(capturedSql.includes('title = EXCLUDED.title'));
        assert.ok(capturedSql.includes('keywords = EXCLUDED.keywords'));
        assert.ok(capturedSql.includes('mentioned_symbols = EXCLUDED.mentioned_symbols'));
        assert.ok(capturedSql.includes('published_at = EXCLUDED.published_at'));
        assert.ok(capturedSql.includes('content_hash = EXCLUDED.content_hash'));
        assert.ok(capturedSql.includes('parser_version = EXCLUDED.parser_version'));
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
