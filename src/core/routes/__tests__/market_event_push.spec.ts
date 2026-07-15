/**
 * Market Event Push API — acceptance tests
 *
 * Tests:
 * 1. 403 without/with wrong token
 * 2. 400 if missing market/title/cause
 * 3. 200, WeChat + Feishu both called with correct payload fields
 * 4. WeChat failure → route survives, Feishu still called
 * 5. Both channels fail → ok=false
 *
 * Uses __marketEventHandlers injection for reliable stubbing (no require.cache hacks).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../db';
import redis from '../../redis';

const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

// ── Mock pool.query ──
let originalQuery: any;
before(() => {
    originalQuery = (pool as any).query.bind(pool);
    (pool as any).query = () => Promise.resolve({ rows: [], rowCount: 0 });
});
after(() => {
    (pool as any).query = originalQuery;
    redis?.disconnect?.();
});

// ── Helpers ──
function buildApp(router: any): Express {
    const app = express();
    app.use(express.json());
    app.use('/internal', router);
    return app;
}

interface CallResult { status: number; json: unknown }

function postReq(app: Express, path: string, body: unknown, token?: string): Promise<CallResult> {
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (token) headers['X-Internal-Token'] = token;
            const req = http.request(
                { method: 'POST', hostname: '127.0.0.1', port: addr.port, path, headers },
                (res) => {
                    let raw = '';
                    res.on('data', (c: Buffer) => { raw += c.toString(); });
                    res.on('end', () => {
                        server.close();
                        let json: unknown = null;
                        try { json = JSON.parse(raw); } catch { /* */ }
                        resolve({ status: res.statusCode ?? 500, json });
                    });
                },
            );
            req.on('error', () => { server.close(); resolve({ status: 0, json: null }); });
            req.write(JSON.stringify(body));
            req.end();
        });
    });
}

const VALID = {
    market: '美股', direction: 'up', indices: '纳斯达克,标普500',
    change_pct: 2.0, cause: '美联储暗示年内降息',
    evidence_url: 'https://example.com/fed',
    evidence_summary: '鲍威尔Jackson Hole讲话确认通胀回落路径',
    title: '纳指大涨2.0%', event_time: '2026-07-15T05:30:00Z',
};

// ── Tests ──
describe('POST /internal/push/market-event', () => {
    let internal: any;
    let handlers: any;

    // Fresh import per describe to avoid stale __marketEventHandlers
    before(async () => {
        delete require.cache[require.resolve('../internal')];
        internal = await import('../internal');
    });

    after(() => {
        delete internal.__marketEventHandlers.dispatchWechat;
        delete internal.__marketEventHandlers.dispatchFeishu;
    });

    it('returns 403 without X-Internal-Token', async () => {
        delete internal.__marketEventHandlers.dispatchWechat;
        delete internal.__marketEventHandlers.dispatchFeishu;
        const { status } = await postReq(buildApp(internal.default), '/internal/push/market-event', VALID);
        assert.equal(status, 403);
    });

    it('returns 403 with wrong token', async () => {
        delete internal.__marketEventHandlers.dispatchWechat;
        delete internal.__marketEventHandlers.dispatchFeishu;
        const { status } = await postReq(buildApp(internal.default), '/internal/push/market-event', VALID, 'wrong');
        assert.equal(status, 403);
    });

    it('returns 400 when market missing', async () => {
        const { market, ...rest } = VALID;
        const { status } = await postReq(buildApp(internal.default), '/internal/push/market-event', rest, INTERNAL_TOKEN);
        assert.equal(status, 400);
    });

    it('returns 400 when title missing', async () => {
        const { title, ...rest } = VALID;
        const { status } = await postReq(buildApp(internal.default), '/internal/push/market-event', rest, INTERNAL_TOKEN);
        assert.equal(status, 400);
    });

    it('returns 400 when cause missing', async () => {
        const { cause, ...rest } = VALID;
        const { status } = await postReq(buildApp(internal.default), '/internal/push/market-event', rest, INTERNAL_TOKEN);
        assert.equal(status, 400);
    });

    it('returns 200, both channels receive correct payload', async () => {
        let wxPayload: any = null;
        let feishuPayload: any = null;
        internal.__marketEventHandlers.dispatchWechat = async (p: any) => { wxPayload = p; return { sent: 3, failed: 0 }; };
        internal.__marketEventHandlers.dispatchFeishu = async (p: any) => { feishuPayload = p; return { sent: 2, failed: 0 }; };

        const { status, json } = await postReq(
            buildApp(internal.default), '/internal/push/market-event', VALID, INTERNAL_TOKEN,
        );
        assert.equal(status, 200);
        const data = (json as any)?.data;
        assert.equal(data?.ok, true);
        assert.equal(data?.wx_sent, 3);
        assert.equal(data?.feishu_sent, 2);

        assert.ok(wxPayload, 'WeChat handler should be called');
        assert.equal(wxPayload.title, '纳指大涨2.0%');
        assert.equal(wxPayload.cause, '美联储暗示年内降息');
        assert.equal(wxPayload.indices, '纳斯达克,标普500');
        assert.ok(feishuPayload, 'Feishu handler should be called');
        assert.equal(feishuPayload.title, '纳指大涨2.0%');
    });

    it('WeChat failure: route returns 200, Feishu still called', async () => {
        let feishuCalled = false;
        internal.__marketEventHandlers.dispatchWechat = async () => { throw new Error('WeChat down'); };
        internal.__marketEventHandlers.dispatchFeishu = async () => { feishuCalled = true; return { sent: 5, failed: 0 }; };

        const { status, json } = await postReq(
            buildApp(internal.default), '/internal/push/market-event', VALID, INTERNAL_TOKEN,
        );
        assert.equal(status, 200);
        assert.equal((json as any)?.data?.ok, true);
        assert.ok(feishuCalled, 'Feishu should still be called');
    });

    it('both channels fail: ok=false', async () => {
        internal.__marketEventHandlers.dispatchWechat = async () => { throw new Error('WeChat down'); };
        internal.__marketEventHandlers.dispatchFeishu = async () => { throw new Error('Feishu down'); };

        const { status, json } = await postReq(
            buildApp(internal.default), '/internal/push/market-event', VALID, INTERNAL_TOKEN,
        );
        assert.equal(status, 200);
        const data = (json as any)?.data;
        assert.equal(data?.ok, false);
        assert.equal(data?.wx_sent, 0);
        assert.equal(data?.feishu_sent, 0);
    });
});
