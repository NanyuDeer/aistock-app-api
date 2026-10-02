/**
 * 重大事件时间线公开 API — 单测（标题对齐 + 影响板块 + calendar 直查，2026-10-01）
 *
 * 覆盖：
 * 1. news 事件标题按事件传导报告 content.title（LLM 提炼）覆盖展示；无传导报告回退
 *    event_entities.title（原始标题）；calendar 事件原样透传（直查源）。
 * 2. impactSectors 优先级：传导 chain（impactStrength 降序 Top3）> event_entities.impact_sectors
 *    列 > []（有 chain→Top3；无 chain→列字段；都无→[]）。
 * 3. 增强查询带全部分页 eventIds 且用 IN 标量参数（记忆：= ANY($n) JS 数组会触发 PG 42P18）；
 *    calendar 直查行不参与报告增强查询（恒无传导报告）。
 * 4. calendar 事件由市场日历表直查提供（物化方案废弃后），event_entities 中残留的
 *    calendar 源行被排除（防重复）。
 *
 * Mock 策略：monkey-patch pool.query（EventTimelinePublicRouter 持有同一对象引用），
 * 按 SQL 文本分派响应，不连数据库。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../../core/db';
import { eventTimelinePublicRouter } from '../EventTimelinePublicRouter';

// ── Mock pool.query ──

interface MockCall {
    sql: string;
    params: unknown[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const originalQuery = pool.query.bind(pool) as any;
let mockCalls: MockCall[] = [];
let mockResponder: ((sql: string, params: unknown[]) => { rows: unknown[] }) | null = null;

/**
 * 安装 pool.query 打桩。
 * 每个 describe 的 after() 会还原为真实 query，故需在各自 before() 重新安装。
 */
function installPoolMock(): void {
    (pool as any).query = function (sql: string, ...rest: unknown[]): Promise<{ rows: unknown[] }> {
        const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
        mockCalls.push({ sql, params });
        if (mockResponder) {
            return Promise.resolve(mockResponder(sql, params));
        }
        return Promise.resolve({ rows: [] });
    };
}

installPoolMock();
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Test helpers ──

function buildApp(): Express {
    const app = express();
    app.use('/api/agent', eventTimelinePublicRouter);
    return app;
}

interface CallResult {
    status: number;
    body: { code: number; data?: { items?: Array<Record<string, unknown>> } };
}

function requestJson(app: Express, path: string): Promise<CallResult> {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            http
                .get({ host: '127.0.0.1', port, path }, (res) => {
                    let raw = '';
                    res.on('data', (chunk) => (raw += chunk));
                    res.on('end', () => {
                        server.close();
                        resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
                    });
                })
                .on('error', (err) => {
                    server.close();
                    reject(err);
                });
        });
    });
}

const NEWS_ENTITY = {
    event_id: 'EVT-news-1',
    title: '财联社9月17日电，央行今日进行1620亿元7天期逆回购操作，操作利率1.4%。',
    summary: null,
    publish_time: '2026-09-17T02:00:00+08:00',
    event_start_time: '2026-09-17T02:00:00+08:00',
    event_end_time: null,
    event_status: 'occurred',
    time_source: 'news_extraction',
    time_confidence: 0.9,
    source_type: 'news',
    source_event_id: 'evt-scrape-1',
    impact_sectors: [], // 列兜底（新闻事件通常无预计算板块；本例由 chain 决定展示）
};

const NEWS_ENTITY_NO_REPORT = {
    ...NEWS_ENTITY,
    event_id: 'EVT-news-2',
    title: '无有效报告内容的新闻事件原始标题',
    // 有报告行但标题/chain 为空 → 标题回退原始、板块回退列字段
    impact_sectors: ['半导体', 'PCB'],
};

/** occurred 但事件传导报告中完全不存在（点击详情 404 → 应被时间线排除） */
const NEWS_ENTITY_NO_REPORT_ROW = {
    ...NEWS_ENTITY,
    event_id: 'EVT-news-3',
    title: '未进入事件传导的新闻事件（应被排除）',
    impact_sectors: [],
};

/** event_entities 中残留的历史物化 calendar 行：新逻辑应排除（由直查替代，防重复） */
const STALE_CALENDAR_ENTITY = {
    event_id: 'EVT-cal-stale',
    title: '中国10月LPR报价（残留物化行）',
    summary: null,
    publish_time: null,
    event_start_time: '2026-10-20T00:00:00+08:00',
    event_end_time: '2026-10-20T00:00:00+08:00',
    event_status: 'scheduled',
    time_source: 'calendar',
    time_confidence: 0.95,
    source_type: 'calendar',
    source_event_id: null,
    impact_sectors: [],
};

/** market_calendar_events 直查行（qualify: importance=high → 通过） */
const CALENDAR_ROW = {
    event_date: '2026-10-20',
    title: '中国10月LPR报价',
    importance: 'high',
    source: 'L4',
    detail: '央行每月20日报价',
};

/** 直查行映射后的稳定 eventId（与路由内构造口径一致） */
const CALENDAR_EVENT_ID = 'CAL-2026-10-20-中国10月LPR报价';

const REFINED_TITLE = '央行开展7620亿元逆回购，含6000亿隔夜操作';

/** EVT-news-1 的传导 chain（未排序，验证按 impactStrength 降序取 Top3） */
const NEWS_CHAIN = [
    { industry: 'PCB', direction: 'bullish', impactStrength: 0.3, reason: '' },
    { industry: '光模块', direction: 'bullish', impactStrength: 0.9, reason: '' },
    { industry: 'AI算力', direction: 'bullish', impactStrength: 0.7, reason: '' },
    { industry: '半导体', direction: 'bullish', impactStrength: 0.6, reason: '' },
];

describe('EventTimelinePublicRouter 标题对齐 + 影响板块 + calendar 直查', () => {
    before(() => {
        installPoolMock();
        mockResponder = (sql: string) => {
            // 事件传导报告增强查询（标题 + chain，最新一份）
            if (sql.includes('agent_analysis_reports')) {
                return {
                    rows: [
                        { user_id: 'EVT-news-1', title: REFINED_TITLE, chain: NEWS_CHAIN },
                        // 空标题 + 空 chain 行应被忽略（标题回退原始、板块回退列字段）
                        { user_id: 'EVT-news-2', title: '', chain: null },
                    ],
                };
            }
            // 日历直查（market_calendar_events）
            if (sql.includes('market_calendar_events')) {
                return { rows: [CALENDAR_ROW] };
            }
            // listEventEntities（event_entities 全量查询，含残留物化 calendar 行）
            return {
                rows: [
                    NEWS_ENTITY,
                    NEWS_ENTITY_NO_REPORT,
                    NEWS_ENTITY_NO_REPORT_ROW,
                    STALE_CALENDAR_ENTITY,
                ],
            };
        };
        mockCalls = [];
    });
    after(() => {
        (pool as any).query = originalQuery;
        mockResponder = null;
    });

    it('news 事件标题被传导报告提炼标题覆盖；calendar 原样透传（直查源）', async () => {
        const app = buildApp();
        const result = await requestJson(
            app,
            '/api/agent/event/timeline?dateFrom=2026-09-01&dateTo=2026-12-31&pageSize=100',
        );
        assert.equal(result.status, 200);
        assert.equal(result.body.code, 0);
        const items = result.body.data?.items ?? [];
        // EVT-news-3（occurred 且无传导报告行）被传导存在性过滤排除；STALE_CALENDAR_ENTITY
        // 残留物化行被排除（直查替代）→ 剩余 3 条：news×2 + 直查 calendar×1
        assert.equal(items.length, 3);

        const byId = new Map(items.map((it) => [it.eventId, it]));
        // 有传导报告 → 提炼标题
        assert.equal(byId.get('EVT-news-1')?.title, REFINED_TITLE);
        // 有报告行但标题为空 → 回退原始标题
        assert.equal(byId.get('EVT-news-2')?.title, '无有效报告内容的新闻事件原始标题');
        // calendar 事件不参与标题增强，原样透传（由直查源提供）
        assert.equal(byId.get(CALENDAR_EVENT_ID)?.title, '中国10月LPR报价');
        assert.equal(byId.has('EVT-news-3'), false, '无传导报告的 occurred 事件被排除');
        assert.equal(
            byId.has('EVT-cal-stale'),
            false,
            'event_entities 残留物化 calendar 行被排除（直查替代）',
        );
    });

    it('impactSectors 优先级：chain Top3 > 列字段 > 空', async () => {
        const app = buildApp();
        const result = await requestJson(
            app,
            '/api/agent/event/timeline?dateFrom=2026-09-01&dateTo=2026-12-31&pageSize=100',
        );
        const items = result.body.data?.items ?? [];
        const byId = new Map(items.map((it) => [it.eventId, it]));

        // 有传导 chain → 按 impactStrength 降序 Top3（不重算 KG）
        assert.deepEqual(byId.get('EVT-news-1')?.impactSectors, ['光模块', 'AI算力', '半导体']);
        // 有报告行但 chain 空 → 回退 event_entities.impact_sectors 列
        assert.deepEqual(byId.get('EVT-news-2')?.impactSectors, ['半导体', 'PCB']);
        // 直查 calendar 行无 chain 也无列值 → []
        assert.deepEqual(byId.get(CALENDAR_EVENT_ID)?.impactSectors, []);
    });

    it('增强查询带全部实体 eventIds（不含直查 calendar 行）且用 IN 标量参数（非 = ANY）', async () => {
        const app = buildApp();
        await requestJson(
            app,
            '/api/agent/event/timeline?dateFrom=2026-09-01&dateTo=2026-12-31&pageSize=100',
        );
        const enrichCall = mockCalls.find((c) => c.sql.includes('agent_analysis_reports'));
        assert.ok(enrichCall, '应发起事件传导报告增强查询');
        assert.ok(!enrichCall.sql.includes('= ANY'), '禁止 = ANY($n) 数组参数');
        assert.ok(enrichCall.sql.includes('IN ($1, $2, $3)'), '应用 IN 标量参数');
        assert.deepEqual(
            (enrichCall.params as string[]).slice().sort(),
            ['EVT-news-1', 'EVT-news-2', 'EVT-news-3'].sort(),
            '只查询实体源 eventId（calendar 直查行恒无报告，不参与增强查询）',
        );
    });

    it('传导存在性过滤：occurred 无报告被排除；occurred 有报告与未来事件保留', async () => {
        const app = buildApp();
        const result = await requestJson(
            app,
            '/api/agent/event/timeline?dateFrom=2026-09-01&dateTo=2026-12-31&pageSize=100',
        );
        const items = result.body.data?.items ?? [];
        const byId = new Map(items.map((it) => [it.eventId, it]));
        // occurred + 无传导报告行 → 排除
        assert.equal(byId.has('EVT-news-3'), false, 'occurred 无报告必须排除');
        // occurred + 有传导报告行 → 保留
        assert.equal(byId.has('EVT-news-1'), true, 'occurred 有报告必须保留');
        // scheduled 未来事件（含直查 calendar）无报告 → 保留（点击就地展开不跳详情，不报错）
        assert.equal(byId.has(CALENDAR_EVENT_ID), true, '未来事件无报告必须保留');
    });
});

/**
 * 回归测试：node-postgres 对 TIMESTAMPTZ 返回 **Date 对象**（非字符串）。
 *
 * 2026-09-25 线上 500 根因：handler 曾用 `event_start_time.localeCompare(...)` 排序，
 * Date 无 localeCompare → TypeError → 500。上方用例 mock 全用字符串，掩盖了真实 DB
 * 行为，故此处显式用 Date 复现（isDateOnly/computeEventStatus 已支持 Date 输入）。
 */
describe('EventTimelinePublicRouter TIMESTAMPTZ=Date 兼容（回归）', () => {
    before(() => {
        installPoolMock();
        // 夹具必须用「相对当前时间」的未来日期（date-only，上海墙钟 00:00）：
        // 硬编码绝对日期会随时钟推进过期 —— date-only 事件次日 0 点起变 occurred，
        // 随即命中「occurred 必须有传导报告」准入被排除（2026-10-02 本用例即因此失败：
        // 夹具 2026-10-01 已变成已发生）。本用例只验证 TIMESTAMPTZ 返回 Date 时
        // 排序不抛 500，与「事件是否已发生」无关，故用相对日期保证永不随时间失效。
        const shanghaiDateStr = (offsetDays: number): string =>
            new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10)
        const start1 = new Date(`${shanghaiDateStr(7)}T00:00:00+08:00`) // EVT-d-1（较早）
        const start2 = new Date(`${shanghaiDateStr(14)}T00:00:00+08:00`) // EVT-d-2（较晚）
        mockResponder = (sql: string) => {
            // 无传导报告 → occurred 过滤不生效，纯验证排序不抛错
            if (sql.includes('agent_analysis_reports')) return { rows: [] };
            // 日历直查无数据（本用例只验证实体源 Date 排序）
            if (sql.includes('market_calendar_events')) return { rows: [] };
            return {
                rows: [
                    {
                        event_id: 'EVT-d-2',
                        title: '实体事件2',
                        summary: null,
                        publish_time: null,
                        event_start_time: start2,
                        event_end_time: start2,
                        event_status: 'scheduled',
                        time_source: 'calendar',
                        time_confidence: 0.95,
                        source_type: 'news',
                        source_event_id: null,
                        impact_sectors: [],
                    },
                    {
                        event_id: 'EVT-d-1',
                        title: '实体事件1',
                        summary: null,
                        publish_time: null,
                        event_start_time: start1,
                        event_end_time: start1,
                        event_status: 'scheduled',
                        time_source: 'news_extraction',
                        time_confidence: 0.9,
                        source_type: 'news',
                        source_event_id: null,
                        impact_sectors: [],
                    },
                ],
            };
        };
        mockCalls = [];
    });
    after(() => {
        (pool as any).query = originalQuery;
        mockResponder = null;
    });

    it('event_start_time 为 Date 时返回 200 且按时间升序', async () => {
        const app = buildApp();
        const result = await requestJson(
            app,
            '/api/agent/event/timeline?dateFrom=2026-09-01&dateTo=2026-12-31&pageSize=100',
        );
        assert.equal(result.status, 200, 'Date 类型 event_start_time 不应导致 500');
        assert.equal(result.body.code, 0);
        const items = result.body.data?.items ?? [];
        assert.deepEqual(
            items.map((it) => it.eventId),
            ['EVT-d-1', 'EVT-d-2'],
            '应按 event_start_time 升序（时间戳比较，非 localeCompare）',
        );
    });
});
