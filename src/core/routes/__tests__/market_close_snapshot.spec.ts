/**
 * GET /internal/market/close-snapshot?date=YYYY-MM-DD — 三期 Task 1：按日期回补
 *
 * 用例：
 * 1. ?date=2026-08-07 → 200，快照 trade_date 等于请求日期（date 透传）
 * 2. 无 date → 200，快照按 deps.now 的上海日期构建（无 date 回归：仍走当日路径）
 * 3. ?date=非法格式 → 409 market_not_closed（MarketSnapshotUnavailableError）
 *
 * Mock 策略（沿仓库既有惯例，见 tests/MarketSnapshotService.test.ts 与
 * insightPushService.spec.ts 顶部注释）：tsx 的 CJS 互操作把模块级导出编译成
 * 命名空间上的不可配置 getter，Node mock.method 无法补丁此类导出（internal.ts
 * 经 `import * as MarketSnapshotService` 引用同一批 getter）。因此不 mock
 * 模块级函数，而是替换导出对象 __marketSnapshotDependencies 的字段（数据属性，
 * 可写），让路由走真实 getCloseSnapshotByDate / getTodayCloseSnapshot 构建链路，
 * 以"响应 trade_date"断言路由的 date 分发行为。
 *
 * Cleanup：after() 中 redis.disconnect() 防进程挂起（CacheService 在模块加载时
 * 调用 redis.ping() 并创建未 unref 的 setInterval，同 event_conduction.spec.ts）。
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import redis from '../../redis';
import internalRouter from '../internal';
import { __marketSnapshotDependencies } from '../../../modules/quote/MarketSnapshotService';
import type {
    IndexDailyRow,
    DailyPriceRow,
    CompleteDailyResult,
} from '../../../modules/quote/TushareService';

const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

// ── app 装配（同 event_conduction.spec.ts） ──

function buildApp(): Express {
    const app = express();
    app.use(express.json());
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

// ── 收盘快照构建 fixture（复用 MarketSnapshotService.test.ts 模式） ──

function makeIndexRow(
    tradeDate: string,
    code: string,
    pctChg = 0.5,
    amount = 50000000,
): IndexDailyRow {
    return {
        ts_code: code,
        trade_date: tradeDate,
        open: 3000,
        high: 3010,
        low: 2985,
        close: 3000,
        pre_close: 2980,
        change: 20,
        pct_chg: pctChg,
        vol: 1000000,
        amount,
    };
}

function makeDailyRow(tradeDate: string, code: string, pctChg: number, amount: number): DailyPriceRow {
    return {
        ts_code: code,
        trade_date: tradeDate,
        open: 10,
        high: 11,
        low: 9,
        close: 10,
        pre_close: 10,
        change: 0,
        pct_chg: pctChg,
        vol: 100,
        amount,
    };
}

function makeCompleteDailyResult(tradeDate: string): CompleteDailyResult {
    return {
        rows: [makeDailyRow(tradeDate, '000001.SZ', 1, 1000)],
        complete: true,
        reason: 'complete',
        page_count: 1,
    };
}

/** 其余 5 个指数各自包含当前交易日行（000001.SH 序列单独提供 current+previous 两行）。 */
function makeIndexRowsByCode(currentTradeDate: string): Record<string, IndexDailyRow[]> {
    return {
        '399001.SZ': [makeIndexRow(currentTradeDate, '399001.SZ', 0.8)],
        '399006.SZ': [makeIndexRow(currentTradeDate, '399006.SZ', 1.1)],
        '000300.SH': [makeIndexRow(currentTradeDate, '000300.SH', 0.5)],
        '000905.SH': [makeIndexRow(currentTradeDate, '000905.SH', 0.7)],
        '000852.SH': [makeIndexRow(currentTradeDate, '000852.SH', 0.9)],
    };
}

interface CloseFixture {
    /** 请求日（route 的 date 参数或 deps.now 的上海日期）对应的交易日期 YYYYMMDD */
    currentTradeDate: string;
    /** 前一交易日期 YYYYMMDD */
    previousTradeDate: string;
    /** deps.now 返回值；date 路径不读取 deps.now */
    now: () => Date;
}

/**
 * 安装 MarketSnapshotService 依赖 mock（写导出对象的数据属性，可恢复）。
 * 返回恢复函数；limit 池 / 连板天梯 / 概念板块 / 主力资金均给空数据（合法）。
 */
function applyCloseMocks(fixture: CloseFixture): () => void {
    const deps = __marketSnapshotDependencies;
    const orig = {
        getIndexDaily: deps.getIndexDaily,
        getCompleteDailyByDate: deps.getCompleteDailyByDate,
        getLimitListThs: deps.getLimitListThs,
        getLimitStep: deps.getLimitStep,
        getMoneyflowCntThs: deps.getMoneyflowCntThs,
        getMoneyflowThsByDate: deps.getMoneyflowThsByDate,
        now: deps.now,
    };
    const shRows: IndexDailyRow[] = [
        makeIndexRow(fixture.currentTradeDate, '000001.SH'),
        makeIndexRow(fixture.previousTradeDate, '000001.SH'),
    ];
    const indexRowsByCode = makeIndexRowsByCode(fixture.currentTradeDate);
    const dailyByDate: Record<string, CompleteDailyResult> = {
        [fixture.currentTradeDate]: makeCompleteDailyResult(fixture.currentTradeDate),
        [fixture.previousTradeDate]: makeCompleteDailyResult(fixture.previousTradeDate),
    };

    deps.getIndexDaily = (async (code: string) =>
        code === '000001.SH' ? shRows : (indexRowsByCode[code] ?? [])
    ) as typeof orig.getIndexDaily;
    deps.getCompleteDailyByDate = (async (date: string) =>
        dailyByDate[date] ?? makeCompleteDailyResult(fixture.previousTradeDate)
    ) as typeof orig.getCompleteDailyByDate;
    deps.getLimitListThs = (async () => []) as typeof orig.getLimitListThs;
    deps.getLimitStep = (async () => []) as typeof orig.getLimitStep;
    deps.getMoneyflowCntThs = (async () => []) as typeof orig.getMoneyflowCntThs;
    deps.getMoneyflowThsByDate = (async () => []) as typeof orig.getMoneyflowThsByDate;
    deps.now = fixture.now;

    return () => {
        deps.getIndexDaily = orig.getIndexDaily;
        deps.getCompleteDailyByDate = orig.getCompleteDailyByDate;
        deps.getLimitListThs = orig.getLimitListThs;
        deps.getLimitStep = orig.getLimitStep;
        deps.getMoneyflowCntThs = orig.getMoneyflowCntThs;
        deps.getMoneyflowThsByDate = orig.getMoneyflowThsByDate;
        deps.now = orig.now;
    };
}

// ── Tests ──

describe('GET /internal/market/close-snapshot（date 回补）', () => {
    after(() => {
        // Disconnect Redis — CacheService.ts 在模块加载时 ping 并创建未 unref 的
        // setInterval，显式断开防止测试进程挂起（同 event_conduction.spec.ts）。
        redis.disconnect();
    });

    it('GET /internal/market/close-snapshot?date=2026-08-07 透传 date：快照按 2026-08-07 重建', async () => {
        // deps.now 设为 2026-01-03（周六，非交易日）：若路由误走当日路径（忽略 date），
        // 会因"非交易日"抛 409 而不是 200 —— date 路径不读取 deps.now，仅用 URL date。
        const restore = applyCloseMocks({
            currentTradeDate: '20260807',
            previousTradeDate: '20260806',
            now: () => new Date('2026-01-03T00:00:00.000Z'),
        });
        try {
            const app = buildApp();
            const res = await call(app, {
                method: 'GET',
                path: '/internal/market/close-snapshot?date=2026-08-07',
                headers: { 'x-internal-token': INTERNAL_TOKEN },
            });
            assert.equal(res.status, 200);
            const body = res.json as { code: number; data: { trade_date: string } };
            assert.equal(body.code, 200);
            // 快照 trade_date 为 Tushare YYYYMMDD 格式；等于请求日期即证明 date 已透传到构建链路
            assert.equal(body.data.trade_date, '20260807');
        } finally {
            restore();
        }
    });

    it('GET /internal/market/close-snapshot 无 date 时行为不变：按 deps.now 上海日期构建当日快照', async () => {
        // deps.now = 2026-08-06 16:00 CST（已收盘）：无 date 时路由走
        // getTodayCloseSnapshot()（默认路径），快照 trade_date 应为 2026-08-06。
        const restore = applyCloseMocks({
            currentTradeDate: '20260806',
            previousTradeDate: '20260805',
            now: () => new Date('2026-08-06T08:00:00.000Z'),
        });
        try {
            const app = buildApp();
            const res = await call(app, {
                method: 'GET',
                path: '/internal/market/close-snapshot',
                headers: { 'x-internal-token': INTERNAL_TOKEN },
            });
            assert.equal(res.status, 200);
            const body = res.json as { code: number; data: { trade_date: string } };
            assert.equal(body.code, 200);
            // 快照按 deps.now 上海日期构建（无 date 时路由走默认当日路径）
            assert.equal(body.data.trade_date, '20260806');
        } finally {
            restore();
        }
    });

    it('GET /internal/market/close-snapshot?date=非法格式 返回 409 market_not_closed', async () => {
        // 非法日期格式：getCloseSnapshotByDate 抛 MarketSnapshotUnavailableError，
        // 路由 instanceof 判别 → 409（而非 502 通用错误）。
        const app = buildApp();
        const res = await call(app, {
            method: 'GET',
            path: '/internal/market/close-snapshot?date=2026/08/07',
            headers: { 'x-internal-token': INTERNAL_TOKEN },
        });
        assert.equal(res.status, 409);
        const body = res.json as { code: number; data: { status: string; reason: string } };
        assert.equal(body.code, 409);
        assert.equal(body.data.reason, 'market_not_closed');
    });
});
