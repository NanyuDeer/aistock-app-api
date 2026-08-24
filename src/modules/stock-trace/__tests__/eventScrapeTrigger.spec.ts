import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { triggerEventScrape } from '../StockTraceService';

describe('triggerEventScrape (P0-3)', () => {
    afterEach(() => {
        mock.restoreAll();
        delete process.env.AGENT_PY_URL;
        delete process.env.PYTHON_AGENT_URL;
        delete process.env.INTERNAL_API_TOKEN;
    });

    it('posts event_triggered with symbol and score_date', async () => {
        process.env.AGENT_PY_URL = 'http://agent:8080/';
        process.env.INTERNAL_API_TOKEN = 'tok';
        const calls: Array<{ url: string; init: RequestInit }> = [];
        mock.method(global, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(url), init: init ?? {} });
            return { ok: true } as Response;
        });

        await triggerEventScrape({
            event_id: 'e1', symbol: '600000', stock_name: '浦发银行',
            trading_date: '2026-08-12', direction: 'up' as never,
            first_triggered_at: new Date(), window_start_at: new Date(),
            window_end_at: new Date(), current_trigger_revision: 1,
            current_severity: 'high' as never, recovery_started_at: null,
        });

        assert.equal(calls.length, 1, 'fetch not called');
        const captured = calls[0]!;
        assert.equal(captured.url, 'http://agent:8080/api/agent/briefing/event-scrape/trigger');
        const body = JSON.parse(String(captured.init.body));
        assert.equal(body.scrape_mode, 'event_triggered');
        assert.equal(body.event.symbol, '600000');
        assert.equal(body.event.score_date, '2026-08-12');
        assert.equal((captured.init.headers as Record<string, string>)['X-Internal-Token'], 'tok');
    });

    it('no-ops when base url unset', async () => {
        let called = false;
        mock.method(global, 'fetch', async () => { called = true; return { ok: true } as Response; });
        await triggerEventScrape({
            event_id: 'e2', symbol: '000001', stock_name: '平安银行',
            trading_date: '2026-08-12', direction: 'up' as never,
            first_triggered_at: new Date(), window_start_at: new Date(),
            window_end_at: new Date(), current_trigger_revision: 1,
            current_severity: 'high' as never, recovery_started_at: null,
        });
        assert.equal(called, false);
    });

    it('no-ops when token is placeholder (E-3 加固)', async () => {
        process.env.AGENT_PY_URL = 'http://agent:8080/';
        process.env.INTERNAL_API_TOKEN = 'change-me-in-production';
        let called = false;
        mock.method(global, 'fetch', async () => { called = true; return { ok: true } as Response; });
        await triggerEventScrape({
            event_id: 'e3', symbol: '600000', stock_name: '浦发银行',
            trading_date: '2026-08-12', direction: 'up' as never,
            first_triggered_at: new Date(), window_start_at: new Date(),
            window_end_at: new Date(), current_trigger_revision: 1,
            current_severity: 'high' as never, recovery_started_at: null,
        });
        assert.equal(called, false, '占位 token 不应发起无效 POST');
    });

    it('no-ops when token missing (E-3 加固)', async () => {
        process.env.AGENT_PY_URL = 'http://agent:8080/';
        delete process.env.INTERNAL_API_TOKEN;
        let called = false;
        mock.method(global, 'fetch', async () => { called = true; return { ok: true } as Response; });
        await triggerEventScrape({
            event_id: 'e4', symbol: '600000', stock_name: '浦发银行',
            trading_date: '2026-08-12', direction: 'up' as never,
            first_triggered_at: new Date(), window_start_at: new Date(),
            window_end_at: new Date(), current_trigger_revision: 1,
            current_severity: 'high' as never, recovery_started_at: null,
        });
        assert.equal(called, false, '缺失 token 不应发起无效 POST');
    });

    it('sends with 5s timeout signal (E-3 加固)', async () => {
        process.env.AGENT_PY_URL = 'http://agent:8080/';
        process.env.INTERNAL_API_TOKEN = 'tok';
        const calls: Array<{ url: string; init: RequestInit }> = [];
        mock.method(global, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(url), init: init ?? {} });
            return { ok: true } as Response;
        });

        await triggerEventScrape({
            event_id: 'e5', symbol: '600000', stock_name: '浦发银行',
            trading_date: '2026-08-12', direction: 'up' as never,
            first_triggered_at: new Date(), window_start_at: new Date(),
            window_end_at: new Date(), current_trigger_revision: 1,
            current_severity: 'high' as never, recovery_started_at: null,
        });

        assert.equal(calls.length, 1);
        assert.ok(calls[0]!.init.signal instanceof AbortSignal, '应携带超时信号');
    });

    it('fetch 失败重试 2 次后成功（共 3 次调用）', async () => {
        process.env.AGENT_PY_URL = 'http://agent:8080/';
        process.env.INTERNAL_API_TOKEN = 'tok';
        let call = 0;
        const calls: Array<{ url: string; init: RequestInit }> = [];
        mock.method(global, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
            call += 1;
            calls.push({ url: String(url), init: init ?? {} });
            if (call < 3) return { ok: false, status: 502 } as Response;
            return { ok: true } as Response;
        });

        await triggerEventScrape({
            event_id: 'e6', symbol: '600000', stock_name: '浦发银行',
            trading_date: '2026-08-12', direction: 'up' as never,
            first_triggered_at: new Date(), window_start_at: new Date(),
            window_end_at: new Date(), current_trigger_revision: 1,
            current_severity: 'high' as never, recovery_started_at: null,
        }, { retryDelaysMs: [0, 0] });

        assert.equal(calls.length, 3, '失败应重试 2 次');
    });

    it('fetch 全部失败仅记日志不抛异常', async () => {
        process.env.AGENT_PY_URL = 'http://agent:8080/';
        process.env.INTERNAL_API_TOKEN = 'tok';
        mock.method(global, 'fetch', async () => ({ ok: false, status: 500 }) as Response);

        await assert.doesNotReject(triggerEventScrape({
            event_id: 'e7', symbol: '000001', stock_name: '平安银行',
            trading_date: '2026-08-12', direction: 'up' as never,
            first_triggered_at: new Date(), window_start_at: new Date(),
            window_end_at: new Date(), current_trigger_revision: 1,
            current_severity: 'high' as never, recovery_started_at: null,
        }, { retryDelaysMs: [0, 0] }));
    });
});
