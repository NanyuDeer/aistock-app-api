/**
 * internalRouter 集成测试（POST /results/external 推送时序 + context 证据包）
 *
 * 覆盖：
 * 1. POST /results/external：prior 存在时，isSubstantiveChange 的旧值查询必须发生在
 *    INSERT 之前（否则 INSERT 覆写后读到的 old 即新值，changed 恒 false，pushUpdated 永不触发）；
 *    且 INSERT 后触发 push 查询（证明走了 pushUpdated 分支而非不推送）。
 * 2. GET /events/:eventId/context：LEFT JOIN 来源文章 + 追加最新证据包（evidence_package）。
 *
 * Mock 策略：mock pool.query（core/db 默认导出）按调用顺序分发结果；handler 通过
 * router.stack 直接取得（绕过鉴权中间件）。仓库惯例：node:test + .spec.ts + __tests__ 目录。
 * 运行：`node --import tsx --test src/modules/insight/__tests__/internalRouter.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import pool from '../../../core/db';
import * as routerNs from '../internalRouter';

// tsx CJS/ESM 加载差异：CJS 下 namespace.default 即 router 函数；
// ESM 下 default 指向 module.exports={default: router}。兼容两种。
const nsDefault = (routerNs as unknown as { default: unknown }).default;
const router = (
    typeof nsDefault === 'function'
        ? nsDefault
        : (nsDefault as { default: unknown }).default
) as { stack: RouteLayer[] };

interface RouteLayer {
    route?: { path: string; stack: { method: string; handle: unknown }[] };
}

/** 从 router.stack 取指定 path + method 的 handler（直接调用，绕过 x-internal-token 中间件） */
function getHandler(path: string, method: 'get' | 'patch' | 'post'): (...args: unknown[]) => unknown {
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

/** 等待 fire-and-forget 推送链（void ...catch）执行到出现推送查询；条件等待 + 超时，避免固定 sleep 抖动 */
async function waitForPushQuery(calls: string[], timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!calls.some(c => c.includes('event_id = $1 AND (s.enabled')) && Date.now() < deadline) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

afterEach(() => {
    mock.restoreAll();
});

const SUBSTANTIVE_SQL = 'attribution_status, confidence, primary_driver FROM watchlist_insight_results';

describe('POST /results/external 推送时序', () => {
    it('prior 存在时 isSubstantiveChange 查询先于 INSERT，且 INSERT 后触发推送查询', async () => {
        // 按调用顺序记录 SQL，用于断言时序
        const calls: string[] = [];
        mock.method(pool, 'query', (async (text: string) => {
            calls.push(String(text));
            if (calls.length === 1) {
                // 1. prior 查询：有旧记录（非首次落库）
                return { rows: [{}] };
            }
            if (String(text).includes(SUBSTANTIVE_SQL)) {
                // 2. isSubstantiveChange 内部旧值查询：旧状态 unconfirmed/low
                return { rows: [{ attribution_status: 'unconfirmed', confidence: 'low', primary_driver: { label: '旧主因' } }] };
            }
            if (String(text).includes('INSERT INTO watchlist_insight_results')) {
                // 3. upsert
                return { rows: [] };
            }
            // 4+. push 相关查询（pushWithKind 订阅者查询）：无订阅者 → 安静返回 0
            return { rows: [] };
        }) as unknown as typeof pool.query);

        const handler = getHandler('/results/external', 'post') as (
            req: Request, res: Response, nxt: NextFunction,
        ) => Promise<void>;
        const req = {
            body: {
                result: {
                    event_id: 'wi_20260812_000001_pm_up',
                    analysis_version: 'watchlist-insight-v1',
                    attribution_status: 'confirmed',
                    confidence: 'high',
                    primary_driver: { label: '新主因' },
                },
            },
        } as unknown as Request;
        const resState = makeRes();
        await handler(req, resState as unknown as Response, next);

        // 等 fire-and-forget 推送链（void ...catch）执行到推送查询
        await waitForPushQuery(calls);

        const v1Idx = calls.findIndex(c => c.includes(SUBSTANTIVE_SQL));
        const insertIdx = calls.findIndex(c => c.includes('INSERT INTO watchlist_insight_results'));
        const pushIdx = calls.findIndex(c => c.includes('event_id = $1 AND (s.enabled'));
        assert.ok(v1Idx >= 0, 'isSubstantiveChange 旧值查询应发生');
        assert.ok(insertIdx >= 0, 'INSERT upsert 应发生');
        assert.ok(v1Idx < insertIdx, `旧值查询(#${v1Idx})必须先于 INSERT(#${insertIdx})，否则 changed 恒 false`);
        assert.ok(pushIdx > insertIdx, `INSERT(#${insertIdx})后应触发推送查询(#${pushIdx})，证明走了 pushUpdated 分支`);
        assert.equal(resState.statusCode, 201, '应返回 201');
    });

    it('prior 无记录时直接走 pushCreated，不计算 isSubstantiveChange', async () => {
        const calls: string[] = [];
        mock.method(pool, 'query', (async (text: string) => {
            calls.push(String(text));
            if (calls.length === 1) return { rows: [] }; // prior 无记录 → 首次落库
            if (String(text).includes('INSERT INTO watchlist_insight_results')) return { rows: [] };
            return { rows: [] }; // push 查询无订阅者
        }) as unknown as typeof pool.query);

        const handler = getHandler('/results/external', 'post') as (
            req: Request, res: Response, nxt: NextFunction,
        ) => Promise<void>;
        const req = {
            body: { result: { event_id: 'wi_new', analysis_version: 'watchlist-insight-v1', attribution_status: 'unconfirmed' } },
        } as unknown as Request;
        const resState = makeRes();
        await handler(req, resState as unknown as Response, next);
        await waitForPushQuery(calls);

        const v1Idx = calls.findIndex(c => c.includes(SUBSTANTIVE_SQL));
        assert.equal(v1Idx, -1, '首次落库不应计算 isSubstantiveChange（v1 查询不应发生）');
        assert.ok(calls.some(c => c.includes('INSERT INTO watchlist_insight_results')), '应执行 INSERT');
        assert.ok(calls.some(c => c.includes('event_id = $1 AND (s.enabled')), '应触发 pushCreated 推送查询');
        assert.equal(resState.statusCode, 201);
    });
});

describe('GET /events/:eventId/context', () => {
    it('LEFT JOIN 返回事件行（source_id 为 NULL）并追加最新证据包', async () => {
        let call = 0;
        let contextSql = '';
        mock.method(pool, 'query', (async (text: string) => {
            call++;
            if (call === 1) {
                contextSql = String(text);
                // 价格异动事件：source_id 为 NULL，LEFT JOIN 后 s 列为 null
                return { rows: [{ symbol: '000001', stock_name: '测试股', event_type: 'midday_price_move', direction: 'up', title: null, source_id: null }] };
            }
            // 证据包查询：最新 frozen_seq
            return { rows: [{ evidence: [{ source_id: 'quant:sector:x:20260812' }] }] };
        }) as unknown as typeof pool.query);

        const handler = getHandler('/events/:eventId/context', 'get') as (
            req: Request, res: Response, nxt: NextFunction,
        ) => Promise<void>;
        const req = { params: { eventId: 'wi_20260812_000001_pm_up' } } as unknown as Request;
        const resState = makeRes();
        await handler(req, resState as unknown as Response, next);

        assert.match(contextSql, /LEFT JOIN watchlist_insight_sources/, 'context 主查询应为 LEFT JOIN');
        assert.match(contextSql, /FROM watchlist_insight_events e/, '主表为事件表');
        const body = resState.body as { code: number; data: { evidence_package: unknown[] } };
        assert.equal(body.code, 200);
        assert.equal(body.data.evidence_package.length, 1, '应携带最新证据包');
        assert.deepEqual(body.data.evidence_package[0], { source_id: 'quant:sector:x:20260812' });
    });
});

// ── 阶段 2.1：只读端点（insight 读层 skill 用）──

describe('GET /events 只读列表', () => {
    it('openid 缺失 → 400', async () => {
        let queryCalled = false;
        mock.method(pool, 'query', (async () => {
            queryCalled = true;
            return { rows: [] };
        }) as unknown as typeof pool.query);

        const handler = getHandler('/events', 'get') as (
            req: Request, res: Response, nxt: NextFunction,
        ) => Promise<void>;
        const req = { query: {} } as unknown as Request;
        const resState = makeRes();
        await handler(req, resState as unknown as Response, next);

        assert.equal(resState.statusCode, 400);
        assert.equal(queryCalled, false, 'openid 缺失不应触库');
    });

    it('正常返回列表：按 openid 过滤 user_stocks + 可选 symbol/limit', async () => {
        let sql = '';
        mock.method(pool, 'query', (async (text: string) => {
            sql = String(text);
            return {
                rows: [
                    { event_id: 'wi_1', symbol: '000001', stock_name: '测试股', event_type: 'limit_up_radar', direction: 'up', attribution_status: 'confirmed', primary_driver: { label: '涨停主因' } },
                ],
            };
        }) as unknown as typeof pool.query);

        const handler = getHandler('/events', 'get') as (
            req: Request, res: Response, nxt: NextFunction,
        ) => Promise<void>;
        const req = { query: { openid: 'o_test', symbol: '000001', limit: '10' } } as unknown as Request;
        const resState = makeRes();
        await handler(req, resState as unknown as Response, next);

        const body = resState.body as { code: number; data: Array<{ event_id: string }> };
        assert.equal(body.code, 200);
        assert.equal(body.data.length, 1);
        assert.match(sql, /JOIN user_stocks us ON us\.symbol = e\.symbol AND us\.openid/, '按 openid 过滤自选股');
        assert.match(sql, /e\.symbol = \$2/, 'symbol 过滤入参');
    });
});

describe('GET /events/:eventId 只读详情', () => {
    it('归属命中返回详情并追加最新证据包', async () => {
        let call = 0;
        mock.method(pool, 'query', (async (text: string) => {
            call++;
            if (call === 1) {
                return { rows: [{ event_id: 'wi_1', symbol: '000001', stock_name: '测试股', primary_driver: { label: 'x' } }] };
            }
            return { rows: [{ evidence: [{ source_id: 'news:a' }] }] }; // 最新证据包
        }) as unknown as typeof pool.query);

        const handler = getHandler('/events/:eventId', 'get') as (
            req: Request, res: Response, nxt: NextFunction,
        ) => Promise<void>;
        const req = { params: { eventId: 'wi_1' }, query: { openid: 'o_test' } } as unknown as Request;
        const resState = makeRes();
        await handler(req, resState as unknown as Response, next);

        const body = resState.body as { code: number; data: { evidence_package: unknown[]; event_id: string } };
        assert.equal(body.code, 200);
        assert.equal(body.data.event_id, 'wi_1');
        assert.equal(body.data.evidence_package.length, 1);
    });

    it('无归属（user_stocks JOIN 无行）→ 404', async () => {
        mock.method(pool, 'query', (async () => ({ rows: [] })) as unknown as typeof pool.query);

        const handler = getHandler('/events/:eventId', 'get') as (
            req: Request, res: Response, nxt: NextFunction,
        ) => Promise<void>;
        const req = { params: { eventId: 'wi_none' }, query: { openid: 'o_test' } } as unknown as Request;
        const resState = makeRes();
        await handler(req, resState as unknown as Response, next);

        assert.equal(resState.statusCode, 404);
    });
});
