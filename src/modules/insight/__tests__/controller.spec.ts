/**
 * InsightController 列表接口最小测试
 *
 * 覆盖：用户身份解析（Authorization Bearer JWT → openid，跟随旧模块模式）、
 * 列表 SQL 的自选股过滤（JOIN user_stocks us ON us.symbol = e.symbol AND us.openid = $1）与 LIMIT 100、
 * 未登录返回 401 且不触库。
 *
 * Mock 策略：mock pool.query（core/db 默认导出），直接调用 controller 静态方法，不启动 HTTP 服务。
 * 仓库惯例：Node 内建 test runner（node:test）+ .spec.ts + __tests__ 目录。
 * 运行：`node --import tsx --test src/modules/insight/__tests__/controller.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import pool from '../../../core/db';
import { signJwt } from '../../../shared/utils/jwt';
import { InsightController } from '../controller';

const TEST_SECRET = 'controller-test-secret';
const TEST_OPENID = 'test-openid-001';
const ORIGINAL_SECRET = process.env.JWT_SECRET;

function buildToken(openid: string): string {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({ openid, iat: now, exp: now + 3600 }, TEST_SECRET);
}

/** 最小可用的 res 模拟：status 记录状态码并返回自身，json 记录响应体 */
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

afterEach(() => {
    mock.restoreAll();
    if (ORIGINAL_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_SECRET;
});

describe('InsightController.list', () => {
    it('未登录（无 Bearer token）返回 401 且不查询数据库', async () => {
        process.env.JWT_SECRET = TEST_SECRET;
        let queryCalled = false;
        mock.method(pool, 'query', (async () => {
            queryCalled = true;
            return { rows: [] };
        }) as unknown as typeof pool.query);

        const req = { headers: {} } as Request;
        const resState = makeRes();
        const res = resState as unknown as Response;
        const next: NextFunction = () => {};

        await InsightController.list(req, res, next);

        const body = resState.body as { code?: number } | undefined;
        assert.equal(body?.code, 401, '未登录应返回 code 401');
        assert.equal(queryCalled, false, '未登录不应发起数据库查询');
    });

    it('登录后按 openid 过滤 user_stocks 并 LIMIT 100', async () => {
        process.env.JWT_SECRET = TEST_SECRET;
        const token = buildToken(TEST_OPENID);
        const fakeRows = [
            { event_id: 'wi_20260805_000962_limit_up', symbol: '000962', stock_name: '东方钽业' },
        ];
        let captured: { text: string; params: unknown[] } | null = null;
        mock.method(pool, 'query', (async (text: string, params?: unknown[]) => {
            captured = { text, params: params ?? [] };
            return { rows: fakeRows };
        }) as unknown as typeof pool.query);

        const req = { headers: { authorization: `Bearer ${token}` } } as Request;
        const resState = makeRes();
        const res = resState as unknown as Response;
        const next: NextFunction = () => {};

        await InsightController.list(req, res, next);

        assert.ok(captured, '登录用户应发起数据库查询');
        const sql = captured as { text: string; params: unknown[] };
        assert.match(
            sql.text,
            /JOIN user_stocks us ON us\.symbol = e\.symbol AND us\.openid = \$1/,
            '列表 SQL 应按登录用户自选股过滤',
        );
        assert.match(sql.text, /LIMIT 100/, '列表 SQL 应固定 LIMIT 100');
        assert.equal(sql.params[0], TEST_OPENID, '第一个参数应为 openid');
        assert.deepEqual(resState.body, { code: 200, data: fakeRows }, '响应格式应为 { code, data }');
    });
});

describe('InsightController.get', () => {
    const EVENT_ID = 'wi_20260805_000962_limit_up';

    it('未登录（无 Bearer token）返回 401 且不查询数据库', async () => {
        process.env.JWT_SECRET = TEST_SECRET;
        let queryCalled = false;
        mock.method(pool, 'query', (async () => {
            queryCalled = true;
            return { rows: [] };
        }) as unknown as typeof pool.query);

        const req = { params: { eventId: EVENT_ID }, headers: {} } as unknown as Request;
        const resState = makeRes();
        const res = resState as unknown as Response;
        const next: NextFunction = () => {};

        await InsightController.get(req, res, next);

        const body = resState.body as { code?: number } | undefined;
        assert.equal(body?.code, 401, '未登录应返回 code 401');
        assert.equal(queryCalled, false, '未登录不应发起数据库查询');
    });

    it('登录但无自选股归属返回 404', async () => {
        process.env.JWT_SECRET = TEST_SECRET;
        const token = buildToken(TEST_OPENID);
        mock.method(pool, 'query', (async () => ({ rows: [] })) as unknown as typeof pool.query);

        const req = {
            params: { eventId: EVENT_ID },
            headers: { authorization: `Bearer ${token}` },
        } as unknown as Request;
        const resState = makeRes();
        const res = resState as unknown as Response;
        const next: NextFunction = () => {};

        await InsightController.get(req, res, next);

        const body = resState.body as { code?: number } | undefined;
        assert.equal(body?.code, 404, '无自选股归属应返回 code 404');
    });

    it('登录且有自选股归属返回 200，SQL 含 user_stocks JOIN 与 openid 参数', async () => {
        process.env.JWT_SECRET = TEST_SECRET;
        const token = buildToken(TEST_OPENID);
        const fakeRow = { event_id: EVENT_ID, symbol: '000962', stock_name: '东方钽业' };
        let captured: { text: string; params: unknown[] } | null = null;
        mock.method(pool, 'query', (async (text: string, params?: unknown[]) => {
            captured = { text, params: params ?? [] };
            return { rows: [fakeRow] };
        }) as unknown as typeof pool.query);

        const req = {
            params: { eventId: EVENT_ID },
            headers: { authorization: `Bearer ${token}` },
        } as unknown as Request;
        const resState = makeRes();
        const res = resState as unknown as Response;
        const next: NextFunction = () => {};

        await InsightController.get(req, res, next);

        assert.ok(captured, '登录用户应发起数据库查询');
        const sql = captured as { text: string; params: unknown[] };
        assert.match(
            sql.text,
            /JOIN user_stocks us ON us\.symbol = e\.symbol AND us\.openid = \$1/,
            '详情 SQL 应按登录用户自选股过滤',
        );
        assert.match(sql.text, /WHERE e\.event_id = \$2/, '详情 SQL 应以 eventId 为第二参数');
        assert.equal(sql.params[0], TEST_OPENID, '第一个参数应为 openid');
        assert.equal(sql.params[1], EVENT_ID, '第二个参数应为 eventId');
        assert.deepEqual(resState.body, { code: 200, data: fakeRow }, '响应格式应为 { code, data }');
    });
});
