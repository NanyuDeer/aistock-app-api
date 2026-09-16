/**
 * internalRouter 阶段 2.2 只读端点测试：GET /events?openid=&symbol=&limit=（个股溯源列表）
 *
 * Mock 策略：mock StockTraceService.listUserEvents（端点内部唯一依赖），直接取 handler 调用。
 * 仓库惯例：node:test + .spec.ts + __tests__。
 * 运行：`node --import tsx --test src/modules/stock-trace/__tests__/internalRouter-events.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { StockTraceService } from '../StockTraceService';
import * as routerNs from '../internalRouter';

// tsx CJS/ESM 加载差异：兼容 namespace.default 两种形态
const nsDefault = (routerNs as unknown as { default: unknown }).default;
const router = (
    typeof nsDefault === 'function'
        ? nsDefault
        : (nsDefault as { default: unknown }).default
) as { stack: RouteLayer[] };

interface RouteLayer {
    route?: { path: string; stack: { method: string; handle: unknown }[] };
}

function getHandler(path: string, method: 'get' | 'post' | 'patch'): (...args: unknown[]) => unknown {
    const stack = router.stack;
    const layer = stack.find((l: RouteLayer) => l.route?.path === path);
    assert.ok(layer?.route, `route ${path} not found in router stack`);
    const routeLayer = layer.route!.stack.find(r => r.method === method);
    assert.ok(routeLayer, `method ${method} ${path} not found`);
    return routeLayer.handle as (...args: unknown[]) => unknown;
}

interface FakeRes {
    statusCode: number;
    body: unknown;
    status(code: number): FakeRes;
    json(body: unknown): void;
}

function makeRes(): FakeRes {
    const res: FakeRes = {
        statusCode: 0,
        body: undefined,
        status(this: FakeRes, code: number): FakeRes {
            this.statusCode = code;
            return this;
        },
        json(this: FakeRes, body: unknown): void {
            this.body = body;
        },
    };
    return res;
}

const next: NextFunction = () => {};

afterEach(() => {
    mock.restoreAll();
});

function item(symbol: string, cause?: string): Record<string, unknown> {
    return {
        event_id: `mv:${symbol}:2026-08-25:1:up`,
        symbol,
        stock_name: `${symbol} 股`,
        event_type: 'price',
        direction: 'up',
        triggered_at: '2026-08-25T07:05:00.000Z',
        analysis_status: 'completed',
        primary_cause: cause ?? '业绩大增',
    };
}

describe('GET /events 只读列表（阶段 2.2）', () => {
    it('openid 缺失 → 400，不调用 listUserEvents', async () => {
        let called = false;
        mock.method(StockTraceService, 'listUserEvents', (async () => {
            called = true;
            return { items: [], nextCursor: null };
        }) as unknown as typeof StockTraceService.listUserEvents);

        const handler = getHandler('/events', 'get') as (
            req: Request, res: Response, nxt: NextFunction,
        ) => Promise<void>;
        const resState = makeRes();
        await handler({ query: {} } as unknown as Request, resState as unknown as Response, next);

        assert.equal(resState.statusCode, 400);
        assert.equal(called, false, 'openid 缺失不应触库');
    });

    it('正常返回列表（openid 过滤 + limit 透传），无 symbol 不过滤', async () => {
        let capturedOpenid = '';
        let capturedLimit = 0;
        mock.method(StockTraceService, 'listUserEvents', (async (_id: string, openid: string, limit: number) => {
            capturedOpenid = openid;
            capturedLimit = limit;
            return { items: [item('000001'), item('600519', '培育钻石概念')], nextCursor: null };
        }) as unknown as typeof StockTraceService.listUserEvents);

        const handler = getHandler('/events', 'get') as (
            req: Request, res: Response, nxt: NextFunction,
        ) => Promise<void>;
        const resState = makeRes();
        await handler({ query: { openid: 'o_test', limit: '10' } } as unknown as Request, resState as unknown as Response, next);

        const body = resState.body as { code: number; data: Array<{ symbol: string }> };
        assert.equal(body.code, 200);
        assert.equal(body.data.length, 2);
        assert.equal(capturedOpenid, 'o_test');
        assert.equal(capturedLimit, 10);
    });

    it('symbol 过滤：只返回该股票事件', async () => {
        mock.method(StockTraceService, 'listUserEvents', (async () => ({
            items: [item('000001'), item('600519', '培育钻石概念')],
            nextCursor: null,
        })) as unknown as typeof StockTraceService.listUserEvents);

        const handler = getHandler('/events', 'get') as (
            req: Request, res: Response, nxt: NextFunction,
        ) => Promise<void>;
        const resState = makeRes();
        await handler({ query: { openid: 'o_test', symbol: '600519' } } as unknown as Request, resState as unknown as Response, next);

        const body = resState.body as { code: number; data: Array<{ symbol: string; primary_cause: string }> };
        assert.equal(body.data.length, 1);
        assert.equal(body.data[0]!.symbol, '600519');
        assert.equal(body.data[0]!.primary_cause, '培育钻石概念');
    });
});
