/**
 * GET /internal/market/sectors — 盘内板块快照（午间报机会/风险候选源）
 *
 * 用例：
 * 1. 正常四源 → 200，indexes[].code 归一化为 6 位（去 .SH/.SZ）
 * 2. breadth.advance_ratio 由 advance_count/total_count 现算
 * 3. gainers[].pct_change 由 Tencent zdf 映射（toSectorFact）
 *
 * Mock 策略：路由在请求时 dynamic-import TencentSnapshotService，测试直接
 * 重赋值其 static 方法（class 静态属性可写），命中同一模块实例。
 */
import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import redis from '../../redis';
import internalRouter from '../internal';
import { TencentSnapshotService } from '../../../modules/quote/TencentSnapshotService';
import type { CloseIndexFact } from '../../../modules/quote/MarketSnapshotService';

const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

// ── app 装配（同 market_close_snapshot.spec.ts） ──
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

function call(app: Express, path: string): Promise<CallResult> {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            const req = http.request(
                {
                    method: 'GET',
                    hostname: '127.0.0.1',
                    port: addr.port,
                    path,
                    headers: { 'X-Internal-Token': INTERNAL_TOKEN },
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
            req.end();
        });
        server.on('error', reject);
    });
}

const ORIG = {
    fetchIndexes: TencentSnapshotService.fetchIndexes,
    fetchMarketBreadth: TencentSnapshotService.fetchMarketBreadth,
    fetchTencentBoardRank: TencentSnapshotService.fetchTencentBoardRank,
};

afterEach(() => {
    TencentSnapshotService.fetchIndexes = ORIG.fetchIndexes;
    TencentSnapshotService.fetchMarketBreadth = ORIG.fetchMarketBreadth;
    TencentSnapshotService.fetchTencentBoardRank = ORIG.fetchTencentBoardRank;
});

after(() => {
    // 防进程挂起：redis.disconnect()（CacheService 在模块加载时创建未 unref 的 setInterval）
    redis.disconnect();
});

describe('GET /internal/market/sectors', () => {
    it('returns code 200 with normalized indexes and computed advance_ratio', async () => {
        TencentSnapshotService.fetchIndexes = async () =>
            ([{ ts_code: '000001.SH', name: '上证指数', trade_date: '', close: 3400, pct_chg: 0.35, amount: 1e8, source: 'tushare:index_daily' }] satisfies CloseIndexFact[]);
        TencentSnapshotService.fetchMarketBreadth = async () =>
            ({ breadth: { total_count: 5000, advance_count: 3100, avg_change_pct: 0.4 } as never, availability: { state: 'available' } });
        TencentSnapshotService.fetchTencentBoardRank = async (_boardType, direct) =>
            ([{ code: 'BK001', name: '半导体', zdf: '3.2', zljlr: '12.3', lzg: { name: '中芯' } }]);

        const app = buildApp();
        const res = await call(app, '/internal/market/sectors');

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: { indexes: { code: string }[]; breadth: { advance_ratio: number }; gainers: { pct_change: number }[]; availability: { state: string } } };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.indexes[0].code, '000001'); // ts_code 归一化去 .SH
        assert.ok(Math.abs(body.data.breadth.advance_ratio - 0.62) < 1e-9); // 3100/5000 现算
        assert.strictEqual(body.data.gainers[0].pct_change, 3.2); // zdf → pct_change
        assert.strictEqual(body.data.availability.state, 'available');
    });

    it('returns partial availability when some sources reject', async () => {
        TencentSnapshotService.fetchIndexes = async () => {
            throw new Error('index fetch failed');
        };
        TencentSnapshotService.fetchMarketBreadth = async () =>
            ({ breadth: { total_count: 5000, advance_count: 3100, avg_change_pct: 0.4 } as never, availability: { state: 'available' } });
        TencentSnapshotService.fetchTencentBoardRank = async () =>
            ([{ code: 'BK001', name: '半导体', zdf: '3.2', zljlr: '12.3', lzg: { name: '中芯' } }]);

        const app = buildApp();
        const res = await call(app, '/internal/market/sectors');

        assert.strictEqual(res.status, 200);
        const body = res.json as { code: number; data: { availability: { state: string } } };
        assert.strictEqual(body.code, 200);
        assert.strictEqual(body.data.availability.state, 'partial');
    });
});
