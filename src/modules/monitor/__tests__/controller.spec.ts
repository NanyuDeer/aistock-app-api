/**
 * StockMonitorController.getFavoritesNews（个股情报）自选股归属最小测试
 *
 * 回归背景（2026-10-06）：合并账户（accountMerge）把自选股写成 user_id + openid NULL，
 * 该接口此前只按 openid 过滤 user_stocks，导致手机号登录用户"个股情报"恒为空。
 *
 * 覆盖：用户身份解析（JWT id 优先、openid 回填）、自选股 SQL 走 user_id 优先 / openid 兜底的
 * 双通道、未登录返回 401 且不触库。
 *
 * Mock 策略：mock pool.query（core/db 默认导出），直接调用 controller 静态方法，不启动 HTTP 服务。
 * 运行：`node --import tsx --test src/modules/monitor/__tests__/controller.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import pool from '../../../core/db';
import { signJwt } from '../../../shared/utils/jwt';
import { StockMonitorController } from '../controller';

const TEST_SECRET = 'monitor-controller-test-secret';
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

interface FakeRes {
    statusCode: number;
    body: unknown;
    status(code: number): FakeRes;
    json(body: unknown): void;
}

function makeRes(): FakeRes {
    return {
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
}

/** 只关心自选股查询：命中即记录 SQL/参数并返回 symbols，其余查询返回空集 */
function mockPoolForFavorites(symbols: string[]): { captured: { text: string; params: unknown[] } | null } {
    const state: { captured: { text: string; params: unknown[] } | null } = { captured: null };
    mock.method(pool, 'query', (async (text: string, params?: unknown[]) => {
        if (text.includes('SELECT symbol FROM user_stocks')) {
            state.captured = { text, params: params ?? [] };
            return { rows: symbols.map(symbol => ({ symbol })) };
        }
        return { rows: [] };
    }) as unknown as typeof pool.query);
    return state;
}

afterEach(() => {
    mock.restoreAll();
    if (ORIGINAL_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_SECRET;
});

describe('StockMonitorController.getFavoritesNews 自选股归属', () => {
    it('未登录（无 Bearer token）返回 401 且不查询数据库', async () => {
        process.env.JWT_SECRET = TEST_SECRET;
        let queryCalled = false;
        mock.method(pool, 'query', (async () => {
            queryCalled = true;
            return { rows: [] };
        }) as unknown as typeof pool.query);

        const req = { headers: {}, query: {} } as unknown as Request;
        const resState = makeRes();
        await StockMonitorController.getFavoritesNews(req, resState as unknown as Response, (() => {}) as NextFunction);

        assert.equal((resState.body as { code?: number })?.code, 401, '未登录应返回 code 401');
        assert.equal(queryCalled, false, '未登录不应发起数据库查询');
    });

    it('手机号登录（id 有值、openid 为空串）按 user_id 命中合并账户自选股', async () => {
        process.env.JWT_SECRET = TEST_SECRET;
        const token = buildToken(''); // 手机号账户 openid 签空串
        const state = mockPoolForFavorites(['001267', '002230']);

        const req = {
            headers: { authorization: `Bearer ${token}` },
            query: {},
        } as unknown as Request;
        const resState = makeRes();
        await StockMonitorController.getFavoritesNews(req, resState as unknown as Response, (() => {}) as NextFunction);

        assert.ok(state.captured, '应发起自选股查询');
        const sql = state.captured as { text: string; params: unknown[] };
        assert.match(
            sql.text,
            /WHERE \(user_id = \$1 OR \(user_id IS NULL AND openid = \$2\)\)/,
            '自选股 SQL 应 user_id 优先、openid 兜底',
        );
        assert.equal(sql.params[0], TEST_ID, '第一个参数应为统一账户 id');
        assert.equal(sql.params[1], '', '第二个参数应为 openid（手机号账户为空串）');
    });

    it('旧微信 token（仅 openid 无 id）以 openid 回填 id 仍可访问', async () => {
        process.env.JWT_SECRET = TEST_SECRET;
        const token = buildToken(TEST_OPENID, { openidOnly: true });
        const state = mockPoolForFavorites([]);

        const req = {
            headers: { authorization: `Bearer ${token}` },
            query: {},
        } as unknown as Request;
        const resState = makeRes();
        await StockMonitorController.getFavoritesNews(req, resState as unknown as Response, (() => {}) as NextFunction);

        assert.ok(state.captured, '应发起自选股查询');
        const sql = state.captured as { text: string; params: unknown[] };
        assert.equal(sql.params[0], TEST_OPENID, '旧 token 应以 openid 回填 id');
        assert.equal(sql.params[1], TEST_OPENID, 'openid 兜底参数一致');
    });
});
