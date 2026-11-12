/**
 * 板块消息 → 关联个股（sector_news 证据域）测试。
 *
 * 覆盖：
 * 1. `loadEventStoreEvidence(symbol, capturedAt, sectors)` 透传 sectors，
 *    并把「仅板块命中」（match_type=sector）的事件映射为 `kind='sector_news'`
 * 2. 不传 sectors：URL 不含 sectors，kind 保持 news/announcement（旧行为不变）
 * 3. 增量修订复用：sector_news 可被复用，且单独存在也能把 sector 域读为可用
 *
 * Mock 策略：沿用 eventStoreEvidence.spec.ts 的 globalThis.fetch mock。
 *
 * 运行：node --import tsx --test src/modules/stock-trace/__tests__/sectorNewsEvidence.spec.ts
 */
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    isBroadSectorName,
    loadEventStoreEvidence,
    pickReusableSources,
    reusedDomainAvailability,
    selectSectorBoardNames,
} from '../StockTraceSnapshotService';
import type { StockSourceRecord } from '../types';

const _envBackup: Record<string, string | undefined> = {};

before(() => {
    _envBackup.PYTHON_AGENT_URL = process.env.PYTHON_AGENT_URL;
    _envBackup.AGENT_PY_URL = process.env.AGENT_PY_URL;
    _envBackup.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
    _envBackup.INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;
});

beforeEach(() => {
    process.env.AGENT_PY_URL = 'http://python-agent:8000';
    process.env.PYTHON_AGENT_URL = 'http://python-agent:8000';
    process.env.INTERNAL_API_TOKEN = 'test-token-sector';
});

afterEach(() => {
    delete (globalThis as any).__fetchMock;
    for (const [k, v] of Object.entries(_envBackup)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

function mockFetch(
    handler: (url: string, init: RequestInit) => Promise<{ status: number; body: string }>,
): void {
    (globalThis as any).__fetchMock = handler;
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const handlerFn = (globalThis as any).__fetchMock;
        if (!handlerFn) return Promise.reject(new Error('fetch not mocked'));
        return handlerFn(url.toString(), init || {}).then(
            (data: { status: number; body: string }) =>
                new Response(data.body, {
                    status: data.status,
                    statusText: data.status >= 200 && data.status < 300 ? 'OK' : 'Error',
                }),
        );
    }) as typeof fetch;
}

/** 仅板块命中的板块消息（Python 侧 match_type=sector）。 */
const EVENT_SECTOR_NEWS = {
    event_id: '2026-08-12-sector000000000000',
    title: '半导体设备招标回暖，国产替代加速',
    summary: '多家晶圆厂启动设备招标',
    url: 'https://example.com/sector-news',
    impact_score: 4,
    direction: 'positive',
    source: 'cls',
    source_level: 'C',
    content_hash: 'hash-sector',
    scrape_at: '2026-08-12 09:30:00',
    score_date: '2026-08-12',
    involved_keywords: ['半导体设备'],
    sector_tags: ['半导体'],
    match_type: 'sector',
    payload: {},
};

describe('loadEventStoreEvidence — 板块消息（sector_news）', () => {
    it('传 sectors 时透传参数，并把仅板块命中事件映射为 sector_news', async () => {
        let capturedUrl = '';
        mockFetch(async (url) => {
            capturedUrl = url;
            return { status: 200, body: JSON.stringify({ events: [EVENT_SECTOR_NEWS] }) };
        });

        const capturedAt = new Date('2026-08-12T04:00:00.000Z');
        const records = await loadEventStoreEvidence('600519', capturedAt, ['半导体', '光模块']);

        assert.ok(
            capturedUrl.includes('sectors='),
            `必须透传 sectors 参数: ${capturedUrl}`,
        );
        assert.ok(
            capturedUrl.includes(encodeURIComponent('半导体,光模块')),
            `sectors 应以逗号连接并编码: ${capturedUrl}`,
        );
        assert.strictEqual(records.length, 1);
        assert.strictEqual(records[0].kind, 'sector_news');
        assert.deepEqual(records[0].payload.sector_tags, ['半导体']);
        assert.strictEqual(records[0].payload.match_type, 'sector');
    });

    it('symbol 与板块同时命中（match_type=both）仍归入个股新闻域，不标 sector_news', async () => {
        mockFetch(async () => ({
            status: 200,
            body: JSON.stringify({
                events: [{ ...EVENT_SECTOR_NEWS, event_id: 'both-1', match_type: 'both' }],
            }),
        }));

        const records = await loadEventStoreEvidence('600519', new Date(), ['半导体']);
        assert.strictEqual(records[0].kind, 'news');
        assert.strictEqual(records[0].payload.match_type, 'both');
    });

    it('不传 sectors：URL 不含 sectors，kind 保持 news（旧行为不变）', async () => {
        let capturedUrl = '';
        mockFetch(async (url) => {
            capturedUrl = url;
            return { status: 200, body: JSON.stringify({ events: [{ ...EVENT_SECTOR_NEWS, match_type: undefined }] }) };
        });

        await loadEventStoreEvidence('600519', new Date());
        assert.ok(!capturedUrl.includes('sectors='), `不应透传 sectors: ${capturedUrl}`);
    });
});

function record(kind: StockSourceRecord['kind']): StockSourceRecord {
    return {
        sourceId: `s:${kind}`,
        kind,
        provider: 'cls',
        sourceLevel: 'C',
        title: 't',
        contentExcerpt: 'c',
        capturedAt: new Date(),
        payload: {},
        contentHash: 'h',
    };
}

describe('增量修订复用 — sector_news', () => {
    it('sector_news 属于可复用域', () => {
        const reused = pickReusableSources([record('sector_news'), record('sector_fact')]);
        assert.deepEqual(reused.map((item) => item.kind), ['sector_news', 'sector_fact']);
    });

    it('只有 sector_news 时，sector 域也应读为可用（complete）', () => {
        const counts = reusedDomainAvailability([record('sector_news')]);
        assert.deepEqual(counts, [{ layer: 'sector', count: 1 }]);
    });
});

describe('collectSectorSources — 板块选择口径', () => {
    it('排除宽基指数、两融与互联互通板块', () => {
        assert.equal(isBroadSectorName('上证180成份股'), true);
        assert.equal(isBroadSectorName('沪深300成份股'), true);
        assert.equal(isBroadSectorName('融资融券'), true);
        assert.equal(isBroadSectorName('沪股通'), true);
        assert.equal(isBroadSectorName('换电概念'), false);
        assert.equal(isBroadSectorName('华为汽车'), false);
        assert.equal(isBroadSectorName('   '), false);
    });

    it('剩余板块按成分股数量升序取前 3（越窄越具体）', () => {
        // 江淮汽车 2026-10-17 的真实映射（count 来自 Tushare ths_index）
        const counts: Array<[string, number]> = [
            ['DeepSeek概念', 769], ['上证180成份股', 180], ['低空经济', 498],
            ['华为概念', 1002], ['华为汽车', 174], ['国企改革', 1468],
            ['工业互联网', 439], ['换电概念', 94], ['新能源汽车', 1061],
            ['无人驾驶', 407], ['智能座舱', 171], ['沪股通', 1639],
            ['百度概念', 233], ['融资融券', 3844], ['车联网(车路协同)', 297],
            ['飞行汽车(eVTOL)', 136],
        ];
        const indexByName = new Map(counts.map(([name, count]) => [name, { count }]));

        assert.deepEqual(
            selectSectorBoardNames(counts.map(([name]) => name), indexByName),
            ['换电概念', '飞行汽车(eVTOL)', '智能座舱'],
        );
    });

    it('行情索引缺失的板块排在已收录板块之后', () => {
        const indexByName = new Map([['换电概念', { count: 94 }]]);
        assert.deepEqual(
            selectSectorBoardNames(['未收录板块', '换电概念'], indexByName),
            ['换电概念', '未收录板块'],
        );
    });

    it('全部是宽基板块时返回空数组（不生成板块证据）', () => {
        assert.deepEqual(
            selectSectorBoardNames(['上证180成份股', '融资融券'], new Map()),
            [],
        );
    });
});
