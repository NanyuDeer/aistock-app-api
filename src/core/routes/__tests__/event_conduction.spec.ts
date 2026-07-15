/**
 * Event Conduction Report API — integration tests
 *
 * Tests:
 * 1. Whitelist: event_conduction accepted, unknown types rejected
 * 2. event_conduction requires event_id
 * 3. Same date, different event_id → different user_id params (no overwrite)
 * 4. Same event_id → same user_id param (upsert)
 * 5. Non-event_conduction reports keep original user_id logic (null for public)
 * 6. GET /api/agent/event/list — paginated list with events[] + hasMore
 * 7. GET /api/agent/event/list — pagination boundary: hasMore=true on non-last page
 * 8. GET /api/agent/event/list — pagination boundary: hasMore=false on last page
 * 9. GET /api/agent/event/:eventId — 404 for non-existent
 * 10. GET /api/agent/event/:eventId — full content with four modules + podcast
 * 11. GET /api/agent/event/:eventId — same eventId two dates, returns latest
 * 12. GET /api/agent/report/:intent/:date remains compatible
 *
 * Mock strategy: monkey-patch pool.query on the same object reference that
 * internal.ts captured at import time. No DB connection is made.
 *
 * Cleanup: disconnect Redis in after() to prevent process hang.
 * Root cause: CacheService.ts (transitively imported via internal.ts → services)
 * calls redis.ping() at module load and creates setInterval without unref().
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../db';
import redis from '../../redis';
import internalRouter, { publicRouter } from '../internal';

// ── Mock pool.query ──

interface MockCall {
    sql: string;
    params: unknown[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const originalQuery = pool.query.bind(pool) as any;
let mockCalls: MockCall[] = [];
let mockResponder: ((sql: string, params: unknown[]) => { rows: unknown[] }) | null = null;

// Replace pool.query — works because internal.ts holds the same pool object reference
(pool as any).query = function (sql: string, ...rest: unknown[]): Promise<{ rows: unknown[] }> {
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    mockCalls.push({ sql, params });
    if (mockResponder) {
        return Promise.resolve(mockResponder(sql, params));
    }
    return Promise.resolve({ rows: [] });
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Test helpers ──

const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.use('/api/agent', publicRouter);
    app.use('/internal', internalRouter);
    return app;
}

interface CallResult {
    status: number;
    text: string;
    json: unknown;
}

function call(
    app: Express,
    opts: {
        method: string;
        path: string;
        headers?: http.OutgoingHttpHeaders;
        body?: unknown;
    },
): Promise<CallResult> {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            const req = http.request(
                {
                    method: opts.method,
                    hostname: '127.0.0.1',
                    port: addr.port,
                    path: opts.path,
                    headers: opts.headers,
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => {
                        server.close();
                        const text = Buffer.concat(chunks).toString('utf8');
                        let json: unknown = null;
                        try {
                            json = JSON.parse(text);
                        } catch {
                            /* not JSON */
                        }
                        resolve({ status: res.statusCode ?? 0, text, json });
                    });
                    res.on('error', (err) => {
                        server.close();
                        reject(err);
                    });
                },
            );
            req.on('error', (err) => {
                server.close();
                reject(err);
            });
            if (opts.body !== undefined) {
                req.write(
                    typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
                );
            }
            req.end();
        });
        server.on('error', reject);
    });
}

function postBody(event_id: string, title: string, extra?: Record<string, unknown>) {
    return {
        report_type: 'event_conduction',
        report_date: '2026-07-14',
        event_id,
        content: {
            eventId: event_id,
            title,
            source: 'cls',
            publishTime: '2026-07-14T10:00:00',
            event: 'original event text',
            analysis_reports: {
                event_understanding: { summary: `${title} summary` },
                event_transmission: { mechanism: `${title} mechanism` },
                event_history: [],
                event_investment: { conclusion: `${title} conclusion` },
                event_podcast_brief: `${title} podcast`,
            },
            ...extra,
        },
        data_source: 'event_agent_v3',
        status: 'completed',
    };
}

// ── Tests ──

describe('Event Conduction Report API', () => {
    before(() => {
        mockCalls = [];
        mockResponder = null;
    });

    after(() => {
        // Restore pool.query
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (pool as any).query = originalQuery;
        /* eslint-enable @typescript-eslint/no-explicit-any */

        // Disconnect Redis — CacheService.ts calls redis.ping() at module load,
        // which creates a connection that keeps the process alive.
        redis.disconnect();
    });

    // ── 1. Whitelist ──

    it('accepts event_conduction as valid report_type', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [
                { id: 1, report_type: 'event_conduction', report_date: '2026-07-14', created_at: '2026-07-14T10:00:00Z' },
            ],
        });

        const app = buildApp();
        const res = await call(app, {
            method: 'POST',
            path: '/internal/analysis-reports',
            headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: postBody('evt_001', 'Test Event'),
        });

        assert.strictEqual(res.status, 201);
        const body = res.json as { code: number; data: { report_type: string } };
        assert.strictEqual(body.code, 201);
        assert.strictEqual(body.data.report_type, 'event_conduction');
    });

    it('rejects unknown report_type', async () => {
        const app = buildApp();
        const res = await call(app, {
            method: 'POST',
            path: '/internal/analysis-reports',
            headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: { report_type: 'unknown_type', report_date: '2026-07-14', content: {} },
        });

        assert.strictEqual(res.status, 400);
    });

    // ── 2. event_conduction requires event_id ──

    it('rejects event_conduction without event_id', async () => {
        const app = buildApp();
        const res = await call(app, {
            method: 'POST',
            path: '/internal/analysis-reports',
            headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: { report_type: 'event_conduction', report_date: '2026-07-14', content: {} },
        });

        assert.strictEqual(res.status, 400);
        const body = res.json as { message: string };
        assert.match(body.message, /event_id/i);
    });

    // ── 3. Different event_id → different user_id (no overwrite) ──

    it('uses event_id as user_id isolation key — different event_ids produce different user_id params', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [{ id: 1, report_type: 'event_conduction', report_date: '2026-07-14', created_at: '2026-07-14T10:00:00Z' }],
        });

        const app = buildApp();

        await call(app, {
            method: 'POST',
            path: '/internal/analysis-reports',
            headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: postBody('evt_aaa', 'Event A'),
        });

        await call(app, {
            method: 'POST',
            path: '/internal/analysis-reports',
            headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: postBody('evt_bbb', 'Event B'),
        });

        const insertCalls = mockCalls.filter((c) => c.sql.includes('INSERT'));
        assert.strictEqual(insertCalls.length, 2, 'expected 2 INSERT calls');
        // SQL params: [report_type, report_date, user_id, content_json, ...]
        assert.strictEqual(insertCalls[0].params[2], 'evt_aaa', 'first call user_id should be evt_aaa');
        assert.strictEqual(insertCalls[1].params[2], 'evt_bbb', 'second call user_id should be evt_bbb');
    });

    // ── 4. Same event_id → same user_id (upsert) ──

    it('same event_id produces same user_id param (upsert)', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [{ id: 1, report_type: 'event_conduction', report_date: '2026-07-14', created_at: '2026-07-14T10:00:00Z' }],
        });

        const app = buildApp();

        await call(app, {
            method: 'POST',
            path: '/internal/analysis-reports',
            headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: postBody('evt_same', 'Original'),
        });

        await call(app, {
            method: 'POST',
            path: '/internal/analysis-reports',
            headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: postBody('evt_same', 'Updated'),
        });

        const insertCalls = mockCalls.filter((c) => c.sql.includes('INSERT'));
        assert.strictEqual(insertCalls.length, 2, 'expected 2 INSERT calls (upsert)');
        assert.strictEqual(insertCalls[0].params[2], 'evt_same');
        assert.strictEqual(insertCalls[1].params[2], 'evt_same');
    });

    // ── 5. Non-event_conduction keeps original user_id logic ──

    it('non-event_conduction reports keep original user_id logic (null for public)', async () => {
        mockCalls = [];
        mockResponder = () => ({
            rows: [{ id: 1, report_type: 'morning', report_date: '2026-07-14', created_at: '2026-07-14T10:00:00Z' }],
        });

        const app = buildApp();
        await call(app, {
            method: 'POST',
            path: '/internal/analysis-reports',
            headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: { report_type: 'morning', report_date: '2026-07-14', content: { summary: 'morning briefing' } },
        });

        const insertCalls = mockCalls.filter((c) => c.sql.includes('INSERT'));
        assert.strictEqual(insertCalls.length, 1);
        // user_id should be null (no event_id, no user_id in body)
        assert.strictEqual(insertCalls[0].params[2], null);
    });

    // ── 6. List endpoint: events[] + hasMore ──

    it('GET /api/agent/event/list returns events[] with hasMore (frontend contract)', async () => {
        mockCalls = [];
        mockResponder = (sql: string) => {
            if (sql.includes('COUNT')) {
                return { rows: [{ total: 2 }] };
            }
            return {
                rows: [
                    {
                        id: 1,
                        report_date: '2026-07-14',
                        user_id: 'evt_001',
                        content: {
                            eventId: 'evt_001',
                            title: 'Event 1',
                            source: 'cls',
                            publishTime: '2026-07-14T10:00:00',
                            analysis_reports: {
                                event_understanding: { summary: 'Summary 1' },
                                event_investment: { conclusion: 'Conclusion 1' },
                            },
                        },
                        created_at: '2026-07-14T10:00:00Z',
                    },
                    {
                        id: 2,
                        report_date: '2026-07-14',
                        user_id: 'evt_002',
                        content: {
                            eventId: 'evt_002',
                            title: 'Event 2',
                            source: 'sina',
                            publishTime: '2026-07-14T11:00:00',
                            analysis_reports: {
                                event_understanding: { summary: 'Summary 2' },
                                event_investment: { conclusion: 'Conclusion 2' },
                            },
                        },
                        created_at: '2026-07-14T11:00:00Z',
                    },
                ],
            };
        };

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/event/list?page=1&pageSize=10',
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as {
            code: number;
            data: {
                events: Record<string, unknown>[];
                total: number;
                page: number;
                pageSize: number;
                hasMore: boolean;
            };
        };
        assert.strictEqual(body.code, 0);
        assert.ok(Array.isArray(body.data.events), 'data.events should be an array');
        assert.strictEqual(body.data.events.length, 2);
        assert.strictEqual(body.data.total, 2);
        assert.strictEqual(body.data.page, 1);
        assert.strictEqual(body.data.pageSize, 10);
        assert.strictEqual(body.data.hasMore, false, 'hasMore should be false when all items fit on one page');

        const event0 = body.data.events[0];
        assert.ok(event0['eventId'], 'event should have eventId');
        assert.ok(event0['title'], 'event should have title');
        assert.ok('source' in event0, 'event should have source');
        assert.ok('publishTime' in event0, 'event should have publishTime');
    });

    // ── 7. Pagination boundary: hasMore=true on non-last page ──

    it('GET /api/agent/event/list hasMore=true when more pages exist', async () => {
        mockResponder = (sql: string) => {
            if (sql.includes('COUNT')) {
                return { rows: [{ total: 5 }] };
            }
            // pageSize=2, page=1 → returns 2 items, total=5 → hasMore=true
            return {
                rows: [
                    {
                        id: 1, report_date: '2026-07-14', user_id: 'evt_001',
                        content: { eventId: 'evt_001', title: 'A', source: 'cls', publishTime: '2026-07-14T10:00:00' },
                        created_at: '2026-07-14T10:00:00Z',
                    },
                    {
                        id: 2, report_date: '2026-07-14', user_id: 'evt_002',
                        content: { eventId: 'evt_002', title: 'B', source: 'cls', publishTime: '2026-07-14T11:00:00' },
                        created_at: '2026-07-14T11:00:00Z',
                    },
                ],
            };
        };

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/event/list?page=1&pageSize=2',
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { data: { events: unknown[]; total: number; hasMore: boolean } };
        assert.strictEqual(body.data.events.length, 2);
        assert.strictEqual(body.data.total, 5);
        assert.strictEqual(body.data.hasMore, true, 'hasMore should be true when page < totalPages');
    });

    // ── 8. Pagination boundary: hasMore=false on last page ──

    it('GET /api/agent/event/list hasMore=false on last page', async () => {
        mockResponder = (sql: string) => {
            if (sql.includes('COUNT')) {
                return { rows: [{ total: 5 }] };
            }
            // pageSize=2, page=3 → returns 1 item, total=5 → hasMore=false
            return {
                rows: [
                    {
                        id: 5, report_date: '2026-07-14', user_id: 'evt_005',
                        content: { eventId: 'evt_005', title: 'E', source: 'cls', publishTime: '2026-07-14T14:00:00' },
                        created_at: '2026-07-14T14:00:00Z',
                    },
                ],
            };
        };

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/event/list?page=3&pageSize=2',
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as { data: { events: unknown[]; total: number; hasMore: boolean } };
        assert.strictEqual(body.data.events.length, 1);
        assert.strictEqual(body.data.total, 5);
        assert.strictEqual(body.data.hasMore, false, 'hasMore should be false on last page');
    });

    // ── 9. Detail 404 ──

    it('GET /api/agent/event/:eventId returns 404 for non-existent event', async () => {
        mockResponder = () => ({ rows: [] });

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/event/nonexistent',
        });

        assert.strictEqual(res.status, 404);
    });

    // ── 10. Detail returns full content ──

    it('GET /api/agent/event/:eventId returns full content with four modules + podcast', async () => {
        mockResponder = () => ({
            rows: [
                {
                    id: 1,
                    report_date: '2026-07-14',
                    user_id: 'evt_001',
                    content: {
                        eventId: 'evt_001',
                        title: 'Test Event',
                        source: 'cls',
                        publishTime: '2026-07-14T10:00:00',
                        event: 'original event text',
                        analysis_reports: {
                            event_understanding: { summary: 'Test summary' },
                            event_transmission: { mechanism: 'Test mechanism' },
                            event_history: [],
                            event_investment: { conclusion: 'Test conclusion' },
                            event_podcast_brief: 'Test podcast',
                        },
                    },
                    created_at: '2026-07-14T10:00:00Z',
                },
            ],
        });

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/event/evt_001',
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as {
            code: number;
            data: { content: { analysis_reports: Record<string, unknown> } };
        };
        assert.strictEqual(body.code, 0);
        const ar = body.data.content.analysis_reports;
        assert.ok('event_understanding' in ar, 'should have event_understanding');
        assert.ok('event_transmission' in ar, 'should have event_transmission');
        assert.ok('event_history' in ar, 'should have event_history');
        assert.ok('event_investment' in ar, 'should have event_investment');
        assert.ok('event_podcast_brief' in ar, 'should have event_podcast_brief');
    });

    // ── 11. Detail: same eventId two dates, returns latest ──

    it('GET /api/agent/event/:eventId returns latest record when same eventId spans multiple dates', async () => {
        let detailCallSql = '';
        mockResponder = (sql: string) => {
            if (sql.includes('event_conduction') && sql.includes('user_id')) {
                detailCallSql = sql;
                // Simulate DB returning the latest record (because SQL should have ORDER BY created_at DESC)
                return {
                    rows: [
                        {
                            id: 2,
                            report_date: '2026-07-15',
                            user_id: 'evt_dup',
                            content: {
                                eventId: 'evt_dup',
                                title: 'Updated Event (day 2)',
                                source: 'cls',
                                publishTime: '2026-07-15T10:00:00',
                                analysis_reports: {
                                    event_understanding: { summary: 'Day 2 summary' },
                                    event_transmission: { mechanism: 'Day 2 mechanism' },
                                    event_history: [],
                                    event_investment: { conclusion: 'Day 2 conclusion' },
                                    event_podcast_brief: 'Day 2 podcast',
                                },
                            },
                            created_at: '2026-07-15T10:00:00Z',
                        },
                    ],
                };
            }
            return { rows: [] };
        };

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/event/evt_dup',
        });

        assert.strictEqual(res.status, 200);
        // Verify SQL has ORDER BY created_at DESC for stable latest selection
        assert.match(detailCallSql, /ORDER BY created_at DESC/i, 'SQL must have ORDER BY created_at DESC');
        const body = res.json as { data: { content: { title: string }; report_date: string } };
        assert.strictEqual(body.data.content.title, 'Updated Event (day 2)');
        assert.strictEqual(body.data.report_date, '2026-07-15');
    });

    // ── 12. Existing /api/agent/report/:intent/:date still works ──

    it('GET /api/agent/report/:intent/:date remains compatible (event_conduction intent)', async () => {
        mockResponder = () => ({
            rows: [
                {
                    id: 1,
                    report_type: 'event_conduction',
                    report_date: '2026-07-14',
                    content: { eventId: 'evt_001', title: 'Test' },
                    created_at: '2026-07-14T10:00:00Z',
                },
            ],
        });

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/report/event_conduction/2026-07-14',
        });

        // Should not return 400 (whitelist accepts event_conduction)
        assert.notStrictEqual(res.status, 400);
    });

    // ── 13. Dedup: same eventId multiple records → only latest in list ──

    it('GET /api/agent/event/list deduplicates by user_id (eventId) — returns latest per eventId', async () => {
        let listSql = '';
        let countSql = '';
        mockResponder = (sql: string) => {
            if (sql.includes('COUNT')) {
                countSql = sql;
                return { rows: [{ total: 2 }] };
            }
            listSql = sql;
            // Return the latest record for each of 2 eventIds
            return {
                rows: [
                    {
                        id: 3,
                        report_date: '2026-07-15',
                        user_id: 'evt_aaa',
                        content: {
                            eventId: 'evt_aaa',
                            title: 'Event AAA (latest)',
                            source: 'cls',
                            publishTime: '2026-07-15T10:00:00',
                            analysis_reports: {
                                event_understanding: { summary: 'AAA latest' },
                                event_investment: { conclusion: 'AAA conclusion' },
                            },
                        },
                        created_at: '2026-07-15T10:00:00Z',
                    },
                    {
                        id: 4,
                        report_date: '2026-07-15',
                        user_id: 'evt_bbb',
                        content: {
                            eventId: 'evt_bbb',
                            title: 'Event BBB',
                            source: 'sina',
                            publishTime: '2026-07-15T09:00:00',
                            analysis_reports: {
                                event_understanding: { summary: 'BBB summary' },
                                event_investment: { conclusion: 'BBB conclusion' },
                            },
                        },
                        created_at: '2026-07-15T09:00:00Z',
                    },
                ],
            };
        };

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/event/list?page=1&pageSize=10',
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as {
            data: { events: Record<string, unknown>[]; total: number; hasMore: boolean };
        };
        assert.strictEqual(body.data.events.length, 2);
        assert.strictEqual(body.data.total, 2);
        assert.strictEqual(body.data.hasMore, false);
        // Verify SQL uses DISTINCT ON for deduplication
        assert.match(listSql, /DISTINCT ON\s*\(user_id\)/i, 'SQL must use DISTINCT ON (user_id)');
        // Verify count uses DISTINCT user_id
        assert.match(countSql, /COUNT\s*\(\s*DISTINCT\s+user_id\s*\)/i, 'COUNT must use DISTINCT user_id');
    });

    // ── 14. Dedup: pagination works correctly on deduplicated results ──

    it('GET /api/agent/event/list pagination after dedup — hasMore based on distinct count', async () => {
        mockResponder = (sql: string) => {
            if (sql.includes('COUNT')) {
                // 5 unique eventIds total
                return { rows: [{ total: 5 }] };
            }
            // pageSize=2 → return 2 unique events
            return {
                rows: [
                    {
                        id: 1, report_date: '2026-07-15', user_id: 'evt_01',
                        content: { eventId: 'evt_01', title: 'E1', source: 'cls', publishTime: '2026-07-15T10:00:00' },
                        created_at: '2026-07-15T10:00:00Z',
                    },
                    {
                        id: 3, report_date: '2026-07-15', user_id: 'evt_02',
                        content: { eventId: 'evt_02', title: 'E2', source: 'sina', publishTime: '2026-07-15T09:00:00' },
                        created_at: '2026-07-15T09:00:00Z',
                    },
                ],
            };
        };

        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/api/agent/event/list?page=1&pageSize=2',
        });

        assert.strictEqual(res.status, 200);
        const body = res.json as {
            data: { events: unknown[]; total: number; hasMore: boolean };
        };
        assert.strictEqual(body.data.events.length, 2);
        assert.strictEqual(body.data.total, 5);
        assert.strictEqual(body.data.hasMore, true);
    });
});
