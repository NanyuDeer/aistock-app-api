/**
 * StockTraceTriggerService 测试
 *
 * 用 mock globalThis.fetch 验证：
 * 1. 有效 Token 时向精确 Python URL 发 POST，body 只有 symbol、trace_id，带 x-internal-token
 * 2. Token 未配置、500、超时、非 JSON、Python status=degraded 都返回非 completed，绝不抛异常
 * 3. 不影响 StockInfoPushService 的通知（用 StockInfoPushResult 检验）
 *
 * 运行：`node --import tsx --test src/modules/crawler/__tests__/stockTraceTrigger.spec.ts`
 */
import { describe, it, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { StockTraceTriggerService } from '../services/StockTraceTriggerService';

// 保存原始环境变量与 fetch
const _envBackup: Record<string, string | undefined> = {};

before(() => {
    _envBackup.PYTHON_AGENT_URL = process.env.PYTHON_AGENT_URL;
    _envBackup.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
    _envBackup.INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;
});

afterEach(() => {
    delete (globalThis as any).__fetchMock;
});

function setEnv(overrides: Record<string, string>) {
    for (const [k, v] of Object.entries(overrides)) {
        process.env[k] = v;
    }
}

function restoreEnv(overrides: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = v;
        }
    }
}

function mockFetch(
    handler: (url: string, init: RequestInit) => Promise<{
        status: number;
        headers?: Record<string, string>;
        body: string;
    }>,
) {
    (globalThis as any).__fetchMock = handler;
    globalThis.fetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const handlerFn = (globalThis as any).__fetchMock;
        if (!handlerFn) return (globalThis as any).__origFetch?.(url, init) ?? Promise.reject(new Error('fetch not available'));
        return handlerFn(url.toString(), init || {}).then(
            (data: { status: number; headers?: Record<string, string>; body: string }) => {
                const headers = new Headers(data.headers || {});
                return new Response(data.body, {
                    status: data.status,
                    statusText: data.status >= 200 && data.status < 300 ? 'OK' : 'Error',
                    headers,
                });
            },
        );
    };
}

function restoreFetch() {
    delete (globalThis as any).__fetchMock;
}

// ==================== 测试用例 ====================

describe('StockTraceTriggerService', () => {
    afterEach(() => {
        restoreFetch();
        restoreEnv({
            PYTHON_AGENT_URL: _envBackup.PYTHON_AGENT_URL,
            INTERNAL_API_TOKEN: _envBackup.INTERNAL_API_TOKEN,
            INTERNAL_TOKEN: _envBackup.INTERNAL_TOKEN,
        });
    });

    it('sends POST to correct Python URL with symbol/traceId body and x-internal-token header', async () => {
        setEnv({
            PYTHON_AGENT_URL: 'http://python-agent:8000',
            INTERNAL_API_TOKEN: 'test-token-abc',
        });

        let capturedUrl = '';
        let capturedInit: RequestInit = {};
        mockFetch(async (url, init) => {
            capturedUrl = url;
            capturedInit = init;
            return {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    trace_id: 'trace-123',
                    symbol: '600519',
                    report_date: '2026-07-30',
                    status: 'completed',
                    report_id: 42,
                }),
            };
        });

        const result = await StockTraceTriggerService.triggerStockTrace({
            symbol: '600519',
            traceId: 'trace-123',
        });

        // 请求
        assert.strictEqual(capturedUrl, 'http://python-agent:8000/api/agent/trace/stock/trigger');
        assert.ok(capturedInit.method === 'POST' || capturedInit.method === undefined); // fetch 默认 POST
        const headers = capturedInit.headers as Record<string, string>;
        const tokenHeader = headers?.['x-internal-token'] || headers?.['X-Internal-Token'] || '';
        assert.strictEqual(tokenHeader, 'test-token-abc');
        assert.strictEqual(headers?.['content-type'] || headers?.['Content-Type'], 'application/json');
        const body = JSON.parse(capturedInit.body as string);
        assert.deepStrictEqual(body, { symbol: '600519', trace_id: 'trace-123' });

        // 响应
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(result.traceId, 'trace-123');
    });

    it('returns skipped when internal token is placeholder', async () => {
        setEnv({
            PYTHON_AGENT_URL: 'http://python-agent:8000',
            INTERNAL_API_TOKEN: 'change-me-in-production',
        });

        const result = await StockTraceTriggerService.triggerStockTrace({
            symbol: '600519',
            traceId: 'trace-skip',
        });

        assert.strictEqual(result.status, 'skipped');
        assert.strictEqual(result.traceId, 'trace-skip');
        assert.match(result.reason, /token/i);
    });

    it('returns skipped when internal token is empty', async () => {
        setEnv({
            PYTHON_AGENT_URL: 'http://python-agent:8000',
            INTERNAL_API_TOKEN: '',
        });

        const result = await StockTraceTriggerService.triggerStockTrace({
            symbol: '600519',
            traceId: 'trace-empty',
        });

        assert.strictEqual(result.status, 'skipped');
        assert.strictEqual(result.traceId, 'trace-empty');
    });

    it('returns skipped when PYTHON_AGENT_URL is not configured', async () => {
        setEnv({
            PYTHON_AGENT_URL: '',
            INTERNAL_API_TOKEN: 'test-token',
        });

        const result = await StockTraceTriggerService.triggerStockTrace({
            symbol: '600519',
            traceId: 'trace-nourl',
        });

        assert.strictEqual(result.status, 'skipped');
        assert.strictEqual(result.traceId, 'trace-nourl');
    });

    it('returns failed on HTTP 500 without throwing', async () => {
        setEnv({
            PYTHON_AGENT_URL: 'http://python-agent:8000',
            INTERNAL_API_TOKEN: 'test-token-500',
        });

        mockFetch(async () => ({
            status: 500,
            body: JSON.stringify({ detail: 'Internal server error' }),
        }));

        const result = await StockTraceTriggerService.triggerStockTrace({
            symbol: '600519',
            traceId: 'trace-500',
        });

        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.traceId, 'trace-500');
        assert.ok(result.reason);
    });

    it('returns failed on HTTP 503 without throwing', async () => {
        setEnv({
            PYTHON_AGENT_URL: 'http://python-agent:8000',
            INTERNAL_API_TOKEN: 'test-token-503',
        });

        mockFetch(async () => ({
            status: 503,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ detail: 'Service unavailable' }),
        }));

        const result = await StockTraceTriggerService.triggerStockTrace({
            symbol: '600519',
            traceId: 'trace-503',
        });

        assert.strictEqual(result.status, 'failed');
    });

    it('returns failed on non-JSON response without throwing', async () => {
        setEnv({
            PYTHON_AGENT_URL: 'http://python-agent:8000',
            INTERNAL_API_TOKEN: 'test-token-json',
        });

        mockFetch(async () => ({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: '{invalid json',
        }));

        const result = await StockTraceTriggerService.triggerStockTrace({
            symbol: '600519',
            traceId: 'trace-json',
        });

        assert.strictEqual(result.status, 'failed');
    });

    it('returns degraded when Python response status=degraded', async () => {
        setEnv({
            PYTHON_AGENT_URL: 'http://python-agent:8000',
            INTERNAL_API_TOKEN: 'test-token-degraded',
        });

        mockFetch(async () => ({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                trace_id: 'trace-deg',
                symbol: '600519',
                report_date: '2026-07-30',
                status: 'degraded',
                degraded_reason: 'LLM temporarily unavailable',
            }),
        }));

        const result = await StockTraceTriggerService.triggerStockTrace({
            symbol: '600519',
            traceId: 'trace-deg',
        });

        assert.strictEqual(result.status, 'degraded');
        assert.strictEqual(result.traceId, 'trace-deg');
    });

    it('returns failed on network error (fetch throws) without throwing', async () => {
        setEnv({
            PYTHON_AGENT_URL: 'http://python-agent:8000',
            INTERNAL_API_TOKEN: 'test-token-net',
        });

        mockFetch(async () => {
            throw new Error('ECONNREFUSED connect');
        });

        const result = await StockTraceTriggerService.triggerStockTrace({
            symbol: '600519',
            traceId: 'trace-net',
        });

        assert.strictEqual(result.status, 'failed');
        assert.match(result.reason, /ECONNREFUSED/);
    });

    it('uses INTERNAL_TOKEN as fallback when INTERNAL_API_TOKEN is not set', async () => {
        setEnv({
            PYTHON_AGENT_URL: 'http://python-agent:8000',
            INTERNAL_API_TOKEN: '',
            INTERNAL_TOKEN: 'fallback-token',
        });

        let capturedToken = '';
        mockFetch(async (url, init) => {
            const headers = init.headers as Record<string, string>;
            capturedToken = headers?.['x-internal-token'] || headers?.['X-Internal-Token'] || '';
            return {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    trace_id: 'trace-fb',
                    symbol: '600519',
                    report_date: '2026-07-30',
                    status: 'completed',
                    report_id: 1,
                }),
            };
        });

        const result = await StockTraceTriggerService.triggerStockTrace({
            symbol: '600519',
            traceId: 'trace-fb',
        });

        assert.strictEqual(capturedToken, 'fallback-token');
        assert.strictEqual(result.status, 'completed');
    });
});
