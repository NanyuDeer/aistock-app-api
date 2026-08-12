/**
 * Task 7 — stock_trace 事件库优先、缺库降级测试（统一事件抓取中台）
 *
 * 覆盖：
 * 1. `loadEventStoreEvidence` 命中：事件映射为 StockSourceRecord（读库优先）
 * 2. 空事件库 → []（缺库）
 * 3. 读失败（fetch 抛错 / HTTP 500 / 未配置）→ []，绝不抛异常（降级）
 * 4. `collectCompanySources` 事件库命中 → 直接用事件库，不调用原采集
 * 5. `collectCompanySources` 缺库 → 完整回到原采集（ClsStockNews + StockInfo）
 *
 * Mock 策略：沿 stockTraceTrigger.spec.ts 先例，mock globalThis.fetch。
 * `collectCompanySources` 是 TS private，测试经 any 访问（target=ES2022，
 * private 仅编译期约束）。
 *
 * 运行：node --import tsx --test src/modules/stock-trace/__tests__/eventStoreEvidence.spec.ts
 */
import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ClsStockNewsService } from '../../monitor/ClsStockNewsService';
import { StockInfoService } from '../../crawler/StockInfoService';
import { StockTraceSnapshotService, loadEventStoreEvidence } from '../StockTraceSnapshotService';
import type { TriggerEvent } from '../types';

const _envBackup: Record<string, string | undefined> = {};

before(() => {
    _envBackup.PYTHON_AGENT_URL = process.env.PYTHON_AGENT_URL;
    _envBackup.AGENT_PY_URL = process.env.AGENT_PY_URL;
    _envBackup.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
    _envBackup.INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;
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
                new Response(data.body, { status: data.status, statusText: data.status >= 200 && data.status < 300 ? 'OK' : 'Error' }),
        );
    }) as typeof fetch;
}

// 事件库 EventRecord（Task 1/6 契约）
const EVENT_A = {
    event_id: '2026-08-12-0123456789abcdef',
    title: '央行宣布降准',
    summary: '中国人民银行决定下调存款准备金率0.5个百分点',
    url: 'https://www.cls.cn/detail/12345',
    impact_score: 5,
    direction: 'positive',
    source: 'cls',
    source_level: 'C',
    content_hash: 'hash-a',
    scrape_at: '2026-08-12 09:00:00',
    score_date: '2026-08-12',
    payload: { symbol: '600519' },
};

const EVENT_B = {
    event_id: '2026-08-12-fedcba9876543210',
    title: '公司发布重大合同公告',
    summary: '公司公告签订重大合同，合同金额 10 亿元',
    url: 'https://example.com/announcement',
    impact_score: 4,
    direction: 'positive',
    source: 'announcement',
    source_level: 'A',
    content_hash: 'hash-b',
    scrape_at: '2026-08-12 08:30:00',
    score_date: '2026-08-12',
    payload: { symbol: '600519' },
};

function makeTriggerEvent(): TriggerEvent {
    const base = new Date('2026-08-12T02:00:00.000Z');
    return {
        eventId: 'mv:600519:2026-08-12:1:up',
        triggerRevision: 1,
        symbol: '600519',
        stockName: '贵州茅台',
        tradingDate: '2026-08-12',
        direction: 'up',
        triggeredAt: base,
        windowStartAt: new Date(base.getTime() - 60_000),
        windowEndAt: base,
        latestPrice: 1700,
        previousClose: 1600,
        actualValue: 6.25,
        thresholdValue: 5,
        severity: 'medium',
        ruleVersion: 'price-v1',
    };
}

describe('loadEventStoreEvidence（读库优先、缺库降级）', () => {
    it('命中：映射为 StockSourceRecord（sourceId/kind/provider/sourceLevel/title/contentExcerpt/canonicalUrl/contentHash）', async () => {
        process.env.PYTHON_AGENT_URL = 'http://python-agent:8000';
        process.env.INTERNAL_API_TOKEN = 'test-token-abc';

        let capturedUrl = '';
        mockFetch(async (url, init) => {
            capturedUrl = url;
            const headers = init.headers as Record<string, string>;
            assert.strictEqual(
                headers['X-Internal-Token'] || headers['x-internal-token'],
                'test-token-abc',
                '必须携带 X-Internal-Token',
            );
            return { status: 200, body: JSON.stringify({ events: [EVENT_A, EVENT_B] }) };
        });

        const capturedAt = new Date('2026-08-12T04:00:00.000Z');
        const records = await loadEventStoreEvidence('600519', capturedAt);

        assert.ok(capturedUrl.startsWith('http://python-agent:8000/api/agent/event/scrape-by-symbol/600519?date='), `URL 错误: ${capturedUrl}`);
        assert.strictEqual(records.length, 2);

        const a = records[0];
        assert.strictEqual(a.sourceId, EVENT_A.event_id);
        assert.strictEqual(a.kind, 'news');
        assert.strictEqual(a.provider, 'cls');
        assert.strictEqual(a.sourceLevel, 'C');
        assert.strictEqual(a.title, '央行宣布降准');
        assert.strictEqual(a.contentExcerpt, '中国人民银行决定下调存款准备金率0.5个百分点');
        assert.strictEqual(a.canonicalUrl, 'https://www.cls.cn/detail/12345');
        assert.strictEqual(a.symbol, '600519');
        assert.ok(a.occurredAt instanceof Date);
        assert.strictEqual(a.contentHash.length, 64, 'contentHash 由 sourceRecord 自动计算（sha256）');

        const b = records[1];
        assert.strictEqual(b.kind, 'announcement', 'source=announcement 映射为 announcement');
        assert.strictEqual(b.sourceLevel, 'A');
        assert.strictEqual(b.contentExcerpt, '公司公告签订重大合同，合同金额 10 亿元');
    });

    it('空事件库 → []（缺库）', async () => {
        process.env.PYTHON_AGENT_URL = 'http://python-agent:8000';
        process.env.INTERNAL_API_TOKEN = 'test-token-abc';
        mockFetch(async () => ({ status: 200, body: JSON.stringify({ events: [] }) }));

        const records = await loadEventStoreEvidence('600519', new Date());
        assert.deepStrictEqual(records, []);
    });

    it('fetch 抛错 → [] 且绝不抛异常', async () => {
        process.env.PYTHON_AGENT_URL = 'http://python-agent:8000';
        process.env.INTERNAL_API_TOKEN = 'test-token-abc';
        mockFetch(async () => { throw new Error('ECONNREFUSED'); });

        const records = await loadEventStoreEvidence('600519', new Date());
        assert.deepStrictEqual(records, []);
    });

    it('HTTP 500 → [] 且绝不抛异常', async () => {
        process.env.PYTHON_AGENT_URL = 'http://python-agent:8000';
        process.env.INTERNAL_API_TOKEN = 'test-token-abc';
        mockFetch(async () => ({ status: 500, body: 'internal error' }));

        const records = await loadEventStoreEvidence('600519', new Date());
        assert.deepStrictEqual(records, []);
    });

    it('同时设置 AGENT_PY_URL 与 PYTHON_AGENT_URL → AGENT_PY_URL 胜出（请求 URL 以其为前缀）', async () => {
        process.env.AGENT_PY_URL = 'http://agent-py-primary:9000';
        process.env.PYTHON_AGENT_URL = 'http://python-agent:8000';
        process.env.INTERNAL_API_TOKEN = 'test-token-abc';

        let capturedUrl = '';
        mockFetch(async (url) => {
            capturedUrl = url;
            return { status: 200, body: JSON.stringify({ events: [EVENT_A] }) };
        });

        const records = await loadEventStoreEvidence('600519', new Date());
        assert.strictEqual(records.length, 1);
        assert.ok(
            capturedUrl.startsWith('http://agent-py-primary:9000/api/agent/event/scrape-by-symbol/600519?date='),
            `AGENT_PY_URL 应优先于 PYTHON_AGENT_URL，实际 URL: ${capturedUrl}`,
        );
    });

    it('未配置 PYTHON_AGENT_URL / token → []（静默降级，不尝试请求）', async () => {
        delete process.env.PYTHON_AGENT_URL;
        delete process.env.AGENT_PY_URL;
        delete process.env.INTERNAL_API_TOKEN;
        delete process.env.INTERNAL_TOKEN;

        const records = await loadEventStoreEvidence('600519', new Date());
        assert.deepStrictEqual(records, []);
    });
});

describe('collectCompanySources（事件库优先、缺库降级到原采集）', () => {
    it('事件库命中 → 直接返回事件库记录，不调用原采集', async () => {
        process.env.PYTHON_AGENT_URL = 'http://python-agent:8000';
        process.env.INTERNAL_API_TOKEN = 'test-token-abc';
        mockFetch(async () => ({ status: 200, body: JSON.stringify({ events: [EVENT_A] }) }));

        const newsMock = mock.method(ClsStockNewsService, 'getStockNews', async () => {
            throw new Error('getStockNews 不应被调用（事件库命中）');
        });
        const judgementMock = mock.method(StockInfoService, 'queryJudgements', async () => {
            throw new Error('queryJudgements 不应被调用（事件库命中）');
        });

        try {
            const records = await (StockTraceSnapshotService as any).collectCompanySources(makeTriggerEvent(), new Date('2026-08-12T04:00:00.000Z'));
            assert.strictEqual(records.length, 1);
            assert.strictEqual(records[0].sourceId, EVENT_A.event_id);
            assert.strictEqual(newsMock.mock.calls.length, 0, '事件库命中时不得调用 ClsStockNewsService');
            assert.strictEqual(judgementMock.mock.calls.length, 0, '事件库命中时不得调用 StockInfoService');
        } finally {
            newsMock.mock.restore();
            judgementMock.mock.restore();
        }
    });

    it('事件库空 → 完整回到原采集（ClsStockNews + StockInfo）', async () => {
        process.env.PYTHON_AGENT_URL = 'http://python-agent:8000';
        process.env.INTERNAL_API_TOKEN = 'test-token-abc';
        mockFetch(async () => ({ status: 200, body: JSON.stringify({ events: [] }) }));

        const newsMock = mock.method(ClsStockNewsService, 'getStockNews', async () => ({
            items: [{ id: 'n1', title: '财联社个股新闻', content: '新闻内容', time: '2026-08-12 10:00:00', link: 'https://www.cls.cn/detail/n1' }],
        }));
        const judgementMock = mock.method(StockInfoService, 'queryJudgements', async () => ({
            total: 1,
            items: [{ id: 'j1', title: '公司公告', ai_summary: '公告摘要', published_at: '2026-08-12 09:00:00', url: 'https://example.com/j1', source_id: 'src1', source: 'sse', ai_impact: '中性', ai_horizon: '短期', ai_keywords: [] }],
        }));

        try {
            const records = await (StockTraceSnapshotService as any).collectCompanySources(makeTriggerEvent(), new Date('2026-08-12T04:00:00.000Z'));
            assert.ok(records.some((r: { sourceId: string }) => r.sourceId.startsWith('cls:')), '缺库时应含原财联社采集记录');
            assert.ok(records.some((r: { sourceId: string }) => r.sourceId.startsWith('announcement:')), '缺库时应含原公告采集记录');
            assert.strictEqual(newsMock.mock.calls.length, 1, '缺库时必须调用 ClsStockNewsService');
            assert.strictEqual(judgementMock.mock.calls.length, 1, '缺库时必须调用 StockInfoService');
        } finally {
            newsMock.mock.restore();
            judgementMock.mock.restore();
        }
    });
});
