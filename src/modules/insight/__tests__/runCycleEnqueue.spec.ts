/**
 * InsightService.runCycle 链路合并后：涨停雷达命中自选股 → stock-trace mv 事件
 *
 * 背景：2026-08-30 链路合并后，runCycle 命中自选股不再走 createEvent/enqueue（watchlist_insight_events）
 * 而是调用 radarHitToPriceEvent → StockTraceService.processPriceFact(immediateEnqueue=true)，
 * 由 stock-trace revision 机制天然去重。
 *
 * Mock 策略：mock StockTraceService 静态方法 + TencentQuoteService.getBatchQuotes 返回值，
 * 验证 runCycle 的 events 计数正确。
 *
 * 仓库惯例：Node 内建 test runner（node:test）+ .spec.ts 命名 + __tests__ 目录。
 * 运行：`node --import tsx --test src/modules/insight/__tests__/runCycleEnqueue.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import pool from '../../../core/db';
import redis from '../../../core/redis';
import { StockTraceService } from '../../stock-trace/StockTraceService';
import { TencentQuoteService } from '../../quote/TencentQuoteService';
import { runCycle } from '../InsightService';

const req = createRequire(__filename);

afterEach(() => {
    mock.restoreAll();
});

// 列表页 fixture：同花顺涨停雷达列表（含 1 篇文章，href 满足 parseListHtml 的 /YYYYMMDD/c\d+.shtml 模式）
const LIST_PAGE_HTML = `<html><body>
  <a href="https://yuanchuang.10jqka.com.cn/20260805/c678683171.shtml">涨停雷达：半导体靶材 东方钽业触及涨停</a>
</body></html>`;

// 空列表页：第 2+ 页无新文章，让 fetchLatest 连续 2 个空页后停止
const EMPTY_PAGE_HTML = '<html><body></body></html>';

// 详情页 fixture：正文 + 提及标的（000962 东方钽业）+ 发布时间
const DETAIL_PAGE_HTML = `<html><body>
  <div class="art_p">半导体靶材板块异动，东方钽业(000962)涨停。</div>
  <span class="time">2026-08-05 11:26:03</span>
  <a href="https://stockpage.10jqka.com.cn/000962/">东方钽业</a>
</body></html>`;

const TEST_SECURITY = {
    symbol: '000962',
    stockName: '东方钽业',
    market: 'sz',
    listDate: '20200101',
};

const TEST_QUOTE = {
    '股票代码': '000962',
    '股票简称': '东方钽业',
    '最新价': 10.8,
    '昨收价': 10,
    '涨跌幅': 8.0,
};

/**
 * 模拟一轮采集：1 篇文章提及 000962，用户自选股包含 000962。
 * opts.triggerHit 控制是否触发 stock-trace 事件（true → 返回 mutation: 'created'，false → 返回 mutation: 'ignored'）。
 * opts.quoteFields 可覆盖行情返回字段（用于测试行情缺失等场景）。
 * 返回 events 计数与 mock 调用记录。
 */
async function runOneCycle(
    opts: {
        triggerHit?: boolean;
        quoteFields?: Record<string, unknown>;
    } = {},
): Promise<{
    result: { collected: number; events: number };
    processPriceFactCalls: number;
    getBatchQuotesCalls: number;
    getFavoriteSecuritiesCalls: number;
    setHighWatermarkCalls: () => number;
}> {
    const { triggerHit = true, quoteFields } = opts;

    // 爬虫：列表/详情 HTML 按 URL 分发（fetchLatest 最多取 2 个空页后停止）
    const crawlerUtils = req('../../../shared/utils/crawler');
    const thsCrawlerInstance = crawlerUtils.thsCrawler;
    mock.method(thsCrawlerInstance, 'fetchHtml', (async (url: string) => {
        if (url.includes('mrnxgg_list/index')) return EMPTY_PAGE_HTML; // 第 2+ 页
        if (url.includes('mrnxgg_list')) return LIST_PAGE_HTML; // 第 1 页
        return DETAIL_PAGE_HTML;
    }) as unknown as typeof thsCrawlerInstance.fetchHtml);

    // Redis：高水位
    mock.method(redis, 'get', (async () => '2026-08-04') as unknown as typeof redis.get);
    const setHighWatermarkMock = mock.method(redis, 'set', (async () => 'OK') as unknown as typeof redis.set);

    // pool.query：known 集合 / 自选股 / 来源入库
    const poolQueryMock = (async (text: string) => {
        if (text.includes('FROM watchlist_insight_sources')) return { rows: [] };
        if (text.includes('FROM user_stocks')) return { rows: [{ symbol: '000962' }] };
        return { rows: [] };
    }) as unknown as typeof pool.query;
    mock.method(pool, 'query', poolQueryMock);

    // StockTraceService.getFavoriteSecurities：返回预定义的自选股列表
    const getFavSecMock = mock.method(StockTraceService, 'getFavoriteSecurities', async () => [TEST_SECURITY]);

    // TencentQuoteService.getBatchQuotes：返回预定义行情
    const getBatchQuotesMock = mock.method(TencentQuoteService, 'getBatchQuotes', async (symbols: string[], level: string) => {
        return quoteFields ? [quoteFields] : [TEST_QUOTE];
    });

    // StockTraceService.processPriceFact：模拟触发或跳过
    const processPriceFactMock = mock.method(StockTraceService, 'processPriceFact', async () => {
        if (triggerHit) {
            return { mutation: 'created' as const, event: null };
        }
        return { mutation: 'ignored' as const, event: null };
    });

    const result = await runCycle();

    return {
        result,
        processPriceFactCalls: processPriceFactMock.mock.callCount(),
        getBatchQuotesCalls: getBatchQuotesMock.mock.callCount(),
        getFavoriteSecuritiesCalls: getFavSecMock.mock.callCount(),
        setHighWatermarkCalls: () => setHighWatermarkMock.mock.callCount(),
    };
}

describe('runCycle → stock-trace 链路', () => {
    it('命中自选股 + 行情正常 → events 递增', async () => {
        const { result, processPriceFactCalls, getBatchQuotesCalls, getFavoriteSecuritiesCalls } = await runOneCycle({ triggerHit: true });

        assert.equal(result.events, 1, '行情足够触发，events 应递增');
        assert.equal(processPriceFactCalls, 1, 'processPriceFact 应被调用一次');
        assert.equal(getBatchQuotesCalls, 1, 'getBatchQuotes 应被调用一次');
        assert.equal(getFavoriteSecuritiesCalls, 1, 'getFavoriteSecurities 应被调用一次');
    });

    it('行情缺失（返回空列表）→ events 不递增', async () => {
        const { result, processPriceFactCalls } = await runOneCycle({
            triggerHit: true,
            quoteFields: { '股票代码': '000962', '错误': '未获取到行情数据' },
        });

        assert.equal(result.events, 0, '行情缺失不应建事件');
        assert.equal(processPriceFactCalls, 0, 'processPriceFact 不应被调用');
    });

    it('涨跌幅低（<7%）→ events 不递增', async () => {
        const { result, processPriceFactCalls } = await runOneCycle({
            triggerHit: true,
            quoteFields: { '股票代码': '000962', '股票简称': '东方钽业', '最新价': 10.3, '昨收价': 10, '涨跌幅': 3.0 },
        });

        assert.equal(result.events, 0, '涨跌幅不足 7% 不应建事件');
        assert.equal(processPriceFactCalls, 0, 'processPriceFact 不应被调用');
    });

    it('涨停复盘汇总文章：无标题主体，从正文"涨停/涨超"语境提取个股，命中自选股建事件', async () => {
        // 列表页返回涨停复盘文章（parseTitleStockName=null），正文含涨停个股
        const SUMMARY_LIST_PAGE = `<html><body>
  <a href="https://yuanchuang.10jqka.com.cn/20260805/c678683173.shtml">涨停复盘：创业板指缩量涨0.64% 创新药、贵金属板块涨幅居前</a>
</body></html>`;
        const SUMMARY_DETAIL_PAGE = `<html><body>
  <div class="art_p">创新药板块高开高走掀涨停潮，沃森生物（300142）、智飞生物（300122）等20余股涨停；小金属板块震荡下行，长缆集团（603407）盘中触及跌停。</div>
  <span class="time">2026-08-05 15:55:28</span>
  <a href="https://stockpage.10jqka.com.cn/300142/">沃森生物</a>
  <a href="https://stockpage.10jqka.com.cn/300122/">智飞生物</a>
  <a href="https://stockpage.10jqka.com.cn/603407/">长缆集团</a>
</body></html>`;

        const crawlerUtils = req('../../../shared/utils/crawler');
        const thsCrawlerInstance = crawlerUtils.thsCrawler;
        mock.method(thsCrawlerInstance, 'fetchHtml', (async (url: string) => {
            if (url.includes('mrnxgg_list/index')) return EMPTY_PAGE_HTML;
            if (url.includes('mrnxgg_list')) return SUMMARY_LIST_PAGE;
            return SUMMARY_DETAIL_PAGE;
        }) as unknown as typeof thsCrawlerInstance.fetchHtml);

        mock.method(redis, 'get', (async () => '2026-08-04') as unknown as typeof redis.get);
        const setHighWatermarkMock = mock.method(redis, 'set', (async () => 'OK') as unknown as typeof redis.set);

        // 自选股仅含 300142（沃森生物）
        const poolQueryMock = (async (text: string) => {
            if (text.includes('INSERT INTO watchlist_insight_sources')) return { rows: [{ was_inserted: true }] };
            if (text.includes('FROM watchlist_insight_sources')) return { rows: [] };
            if (text.includes('FROM user_stocks')) return { rows: [{ symbol: '300142' }] };
            return { rows: [] };
        }) as unknown as typeof pool.query;
        mock.method(pool, 'query', poolQueryMock);

        mock.method(StockTraceService, 'getFavoriteSecurities', async () => [{
            symbol: '300142', stockName: '沃森生物', market: 'sz', listDate: '20100101',
        }]);
        mock.method(TencentQuoteService, 'getBatchQuotes', async () => [{
            '股票代码': '300142', '股票简称': '沃森生物', '最新价': 20.5, '昨收价': 18, '涨跌幅': 13.9,
        }]);
        const processPriceFactMock = mock.method(StockTraceService, 'processPriceFact', async () => ({ mutation: 'created' as const, event: null }));

        const result = await runCycle();

        assert.equal(result.collected, 1, '涨停复盘文章应入库');
        assert.equal(result.events, 1, '仅沃森生物命中自选股且为涨停语境');
        assert.equal(processPriceFactMock.mock.callCount(), 1, 'processPriceFact 应被调用一次');
        assert.equal(setHighWatermarkMock.mock.callCount(), 1, '高水位正常推进');
    });
});