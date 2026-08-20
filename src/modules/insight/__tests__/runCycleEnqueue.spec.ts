/**
 * InsightService.runCycle 事件创建后接入任务队列（enqueue）的接线测试
 *
 * 背景：runCycle 命中自选股创建事件后必须把 event_id 入队（watchlist_insight_jobs + outbox → Redis Stream），
 * 否则 `watchlist-insight.jobs` Stream 永远没有消息，Python 消费端无法工作。
 *
 * Mock 策略：模块为 CJS（tsconfig module: commonjs），tsx 的命名导出是 configurable:false 的 getter，
 * 无法用 mock.method/属性覆盖拦截（Node mock 校验 descriptor.value 时拿到 undefined）。
 * 因此本测试不 mock 任何命名导出函数，而是让真实模块代码运行，仅 mock I/O 层：
 *   - thsCrawler.fetchHtml（爬虫实例方法）返回列表/详情 fixture
 *   - redis.get / set / xadd
 *   - pool.query / pool.connect（含 enqueue 事务的客户端）
 * 断言真实 enqueue 执行后 watchlist_insight_jobs 的 INSERT 参数，验证 event_id 接线正确。
 *
 * 仓库惯例：Node 内建 test runner（node:test）+ .spec.ts + __tests__ 目录。
 * 运行：`node --import tsx --test src/modules/insight/__tests__/runCycleEnqueue.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import pool from '../../../core/db';
import redis from '../../../core/redis';
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

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const EXPECTED_EVENT_ID = 'wi_20260805_000962_limit_up';
const VERSION = 'watchlist-insight-v1';

/**
 * 模拟一轮采集：1 篇文章提及 000962，用户自选股包含 000962。
 * eventExists 控制 createEvent 是否新建成功（false 模拟幂等已存在路径）。
 * opts.enqueueThrows=true 时模拟 enqueue 抛错（如 DB 抖动）。
 * 返回 enqueue 事务中 watchlist_insight_jobs / outbox 的 INSERT 调用记录。
 */
async function runOneCycle(
    eventExists: boolean,
    opts: { enqueueThrows?: boolean } = {},
): Promise<{
    result: { collected: number; events: number };
    jobInserts: { text: string; params: unknown[] }[];
    outboxInserts: { text: string; params: unknown[] }[];
    setHighWatermarkCalls: () => number;
}> {
    // 爬虫：列表/详情 HTML 按 URL 分发（fetchLatest 最多取 2 个空页后停止）
    const crawlerUtils = req('../../../shared/utils/crawler');
    const thsCrawlerInstance = crawlerUtils.thsCrawler;
    mock.method(thsCrawlerInstance, 'fetchHtml', (async (url: string) => {
        if (url.includes('mrnxgg_list/index')) return EMPTY_PAGE_HTML; // 第 2+ 页
        if (url.includes('mrnxgg_list')) return LIST_PAGE_HTML; // 第 1 页
        return DETAIL_PAGE_HTML;
    }) as unknown as typeof thsCrawlerInstance.fetchHtml);

    // Redis：高水位 / 写入
    mock.method(redis, 'get', (async () => '2026-08-04') as unknown as typeof redis.get);
    const setHighWatermarkMock = mock.method(redis, 'set', (async () => 'OK') as unknown as typeof redis.set);
    mock.method(redis, 'xadd', (async () => '0-0') as unknown as typeof redis.xadd);

    // pool.query：known 集合 / 自选股 / createEvent / publishPending（无 pending）
    const poolQueryMock = (async (text: string) => {
        if (text.includes('FROM watchlist_insight_sources')) return { rows: [] };
        if (text.includes('FROM user_stocks')) return { rows: [{ symbol: '000962' }] };
        if (text.includes('INSERT INTO watchlist_insight_events')) {
            return eventExists ? { rows: [{ event_id: EXPECTED_EVENT_ID }] } : { rows: [] };
        }
        return { rows: [] };
    }) as unknown as typeof pool.query;
    mock.method(pool, 'query', poolQueryMock);

    // pool.connect：enqueue 事务客户端（记录 job/outbox INSERT）；enqueueThrows 时模拟连接抛错
    const jobInserts: { text: string; params: unknown[] }[] = [];
    const outboxInserts: { text: string; params: unknown[] }[] = [];
    const clientQuery = (async (text: string, params?: unknown[]) => {
        if (text.includes('INSERT INTO watchlist_insight_jobs')) {
            jobInserts.push({ text, params: params ?? [] });
            return { rows: [{ job_id: JOB_ID }] };
        }
        if (text.includes('INSERT INTO watchlist_insight_outbox')) {
            outboxInserts.push({ text, params: params ?? [] });
            return { rows: [] };
        }
        return { rows: [] };
    }) as unknown as typeof pool.query;
    mock.method(pool, 'connect', opts.enqueueThrows
        ? (async () => { throw new Error('connection lost'); }) as unknown as typeof pool.connect
        : (async () => ({ query: clientQuery, release: () => {} })) as unknown as typeof pool.connect);

    const result = await runCycle();
    return { result, jobInserts, outboxInserts, setHighWatermarkCalls: () => setHighWatermarkMock.mock.callCount() };
}

describe('runCycle → enqueue 接线', () => {
    it('命中自选股的事件创建成功后，enqueue 事务按 event_id 入队（wi_YYYYMMDD_symbol_limit_up）', async () => {
        const { result, jobInserts, outboxInserts } = await runOneCycle(true);

        assert.equal(result.events, 1, '事件应新建成功');
        assert.equal(jobInserts.length, 1, '应产生一条 watchlist_insight_jobs INSERT');
        assert.deepStrictEqual(
            jobInserts[0].params,
            [EXPECTED_EVENT_ID, VERSION],
            'job 以 (event_id, analysis_version) 入队',
        );
        assert.equal(outboxInserts.length, 1, '应产生一条 outbox INSERT');
        assert.deepStrictEqual(
            outboxInserts[0].params,
            [JOB_ID, 'watchlist-insight.jobs', JSON.stringify({ eventId: EXPECTED_EVENT_ID })],
            'outbox payload 携带 event_id',
        );
    });

    it('事件已存在（createEvent 幂等返回 false）时仍入队（自愈路径）', async () => {
        const { result, jobInserts } = await runOneCycle(false);

        assert.equal(result.events, 0, '事件已存在，不计新事件数');
        assert.equal(jobInserts.length, 1, '幂等路径仍调用 enqueue 入队');
        assert.deepStrictEqual(
            jobInserts[0].params,
            [EXPECTED_EVENT_ID, VERSION],
            '重复入队仍以同一 event_id',
        );
    });

    it('enqueue 抛错（DB 抖动）时仅记日志跳过，不中断整轮循环', async () => {
        const warn = mock.method(console, 'warn', () => {});
        const { result, jobInserts, outboxInserts, setHighWatermarkCalls } = await runOneCycle(true, { enqueueThrows: true });

        assert.equal(result.events, 1, '事件创建计数不受入队失败影响');
        assert.equal(jobInserts.length, 0, '入队失败不应产生 job INSERT');
        assert.equal(outboxInserts.length, 0, '入队失败不应产生 outbox INSERT');
        assert.equal(warn.mock.callCount(), 1, '入队失败应记录告警日志');
        assert.equal(setHighWatermarkCalls(), 1, '高水位仍推进，下轮增量回溯不受影响');
    });

    it('涨停复盘汇总文章：无标题主体，从正文"涨停/涨超"语境提取个股，命中自选股建事件入队（2026-08-20 增强）', async () => {
        // 列表页返回涨停复盘文章（parseTitleStockName=null），正文含多只涨停/跌停个股
        const SUMMARY_LIST_PAGE = `<html><body>
  <a href="https://yuanchuang.10jqka.com.cn/20260805/c678683173.shtml">涨停复盘：创业板指缩量涨0.64% 创新药、贵金属板块涨幅居前</a>
</body></html>`;
        // 详情页：沃森生物(300142)涨停、长缆集团(603407)盘中触及跌停、平安银行(000001)未提及
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
        mock.method(redis, 'xadd', (async () => '0-0') as unknown as typeof redis.xadd);

        // 自选股仅含 300142（沃森生物）→ 应只对沃森建事件；智飞不在自选股、长缆为跌停语境均不建
        const poolQueryMock = (async (text: string) => {
            if (text.includes('INSERT INTO watchlist_insight_sources')) return { rows: [{ was_inserted: true }] };
            if (text.includes('FROM watchlist_insight_sources')) return { rows: [] };
            if (text.includes('FROM user_stocks')) return { rows: [{ symbol: '300142' }] };
            if (text.includes('INSERT INTO watchlist_insight_events')) return { rows: [{ event_id: 'wi_20260805_300142_limit_up' }] };
            return { rows: [] };
        }) as unknown as typeof pool.query;
        mock.method(pool, 'query', poolQueryMock);

        const jobInserts: { text: string; params: unknown[] }[] = [];
        const clientQuery = (async (text: string, params?: unknown[]) => {
            if (text.includes('INSERT INTO watchlist_insight_jobs')) {
                jobInserts.push({ text, params: params ?? [] });
                return { rows: [{ job_id: JOB_ID }] };
            }
            return { rows: [] };
        }) as unknown as typeof pool.query;
        mock.method(pool, 'connect', (async () => ({ query: clientQuery, release: () => {} })) as unknown as typeof pool.connect);

        const result = await runCycle();

        assert.equal(result.collected, 1, '涨停复盘文章应入库');
        assert.equal(result.events, 1, '仅沃森生物命中自选股且为涨停语境');
        assert.equal(jobInserts.length, 1, '只产生一条 job INSERT');
        assert.deepStrictEqual(jobInserts[0].params, ['wi_20260805_300142_limit_up', VERSION]);
        assert.equal(setHighWatermarkMock.mock.callCount(), 1, '高水位正常推进');
    });
});
