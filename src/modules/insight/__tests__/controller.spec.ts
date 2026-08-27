/**
 * InsightController 列表接口最小测试
 *
 * 覆盖：用户身份解析（Authorization Bearer JWT → id/openid，跟随 userController.requireAuth 统一账户模式）、
 * 列表 SQL 的自选股过滤（user_id 优先 + openid 兜底老微信数据）与 LIMIT 100、
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
const TEST_ID = '11111111-2222-4333-8444-555555555555';
const TEST_OPENID = 'test-openid-001';
const ORIGINAL_SECRET = process.env.JWT_SECRET;

/** 统一账户 token（含 id + openid）；openidOnly=true 模拟旧微信 token（无 id，靠 openid 回填） */
function buildToken(openid: string, opts: { id?: string; openidOnly?: boolean } = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = opts.openidOnly
        ? { openid, iat: now, exp: now + 3600 }
        : { id: opts.id ?? TEST_ID, openid, iat: now, exp: now + 3600 };
    return signJwt(payload, TEST_SECRET);
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

    it('登录后按 user_id 过滤 user_stocks 并 LIMIT 100', async () => {
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
            /JOIN user_stocks us ON us\.symbol = e\.symbol AND \(us\.user_id = \$1 OR \(us\.user_id IS NULL AND us\.openid = \$2\)\)/,
            '列表 SQL 应 user_id 优先、openid 兜底过滤自选股',
        );
        assert.match(sql.text, /LIMIT 100/, '列表 SQL 应固定 LIMIT 100');
        assert.equal(sql.params[0], TEST_ID, '第一个参数应为统一账户 id');
        assert.equal(sql.params[1], TEST_OPENID, '第二个参数应为 openid 兜底');
        assert.deepEqual(resState.body, { code: 200, data: fakeRows }, '响应格式应为 { code, data }');
    });

    it('旧微信 token（仅 openid 无 id）回填 openid 仍可访问', async () => {
        process.env.JWT_SECRET = TEST_SECRET;
        const token = buildToken(TEST_OPENID, { openidOnly: true });
        let captured: { text: string; params: unknown[] } | null = null;
        mock.method(pool, 'query', (async (text: string, params?: unknown[]) => {
            captured = { text, params: params ?? [] };
            return { rows: [] };
        }) as unknown as typeof pool.query);

        const req = { headers: { authorization: `Bearer ${token}` } } as Request;
        const resState = makeRes();
        const res = resState as unknown as Response;
        const next: NextFunction = () => {};

        await InsightController.list(req, res, next);

        assert.ok(captured, '旧 token 也应发起数据库查询');
        const sql = captured as { text: string; params: unknown[] };
        assert.equal(sql.params[0], TEST_OPENID, '旧 token 无 id 时应以 openid 回填为第一参数');
        assert.equal(resState.statusCode, 0, '旧 token 不应返回 401');
        assert.equal((resState.body as { code: number }).code, 200);
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

    it('登录且有自选股归属返回 200，SQL 含 user_stocks JOIN 与 id/openid 参数', async () => {
        process.env.JWT_SECRET = TEST_SECRET;
        const token = buildToken(TEST_OPENID);
        const fakeRow = { event_id: EVENT_ID, symbol: '000962', stock_name: '东方钽业' };
        const calls: { text: string; params: unknown[] }[] = [];
        mock.method(pool, 'query', (async (text: string, params?: unknown[]) => {
            calls.push({ text, params: params ?? [] });
            // 第二次调用为最新证据包查询
            if (calls.length > 1) return { rows: [{ evidence: [] }] };
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

        assert.ok(calls.length >= 1, '登录用户应发起数据库查询');
        const sql = calls[0];
        assert.match(
            sql.text,
            /JOIN user_stocks us ON us\.symbol = e\.symbol AND \(us\.user_id = \$1 OR \(us\.user_id IS NULL AND us\.openid = \$2\)\)/,
            '详情 SQL 应 user_id 优先、openid 兜底过滤自选股',
        );
        assert.match(sql.text, /WHERE e\.event_id = \$3/, '详情 SQL 应以 eventId 为第三参数');
        assert.match(sql.text, /LEFT JOIN LATERAL/, '详情 SQL 应包含 LATERAL join 取价格快照');
        assert.match(sql.text, /watchlist_price_snapshots ps/, 'LATERAL join 目标为 watchlist_price_snapshots');
        assert.match(sql.text, /ORDER BY ps\.snapshot_time DESC LIMIT 1/, 'LATERAL join 取最新一条快照');
        assert.equal(sql.params[0], TEST_ID, '第一个参数应为统一账户 id');
        assert.equal(sql.params[1], TEST_OPENID, '第二个参数应为 openid 兜底');
        assert.equal(sql.params[2], EVENT_ID, '第三个参数应为 eventId');
        assert.equal(calls.length, 2, '详情应追加最新证据包查询');
        assert.match(calls[1].text, /watchlist_evidence_packages/, '证据包查询目标为 watchlist_evidence_packages');
        assert.deepEqual(resState.body, { code: 200, data: { ...fakeRow, evidence_package: [] } }, '响应应含证据包字段');
    });
});
