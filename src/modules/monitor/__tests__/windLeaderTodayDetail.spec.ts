/**
 * 今日板块详情：GET /api/cn/wind-leaders/today/detail
 *
 * 背景：
 *  - 今日榜来自 mrpm 当日全量概念榜，很多板块不在 /cn/wind-leaders 的 40 条里，
 *    详情页按名称匹配会落到「未找到该板块数据」。
 *  - 新增详情接口把今日快照组装成与 hot_sectors 同构的对象，前端复用同一个详情页。
 *
 * 运行：node --import tsx --test src/modules/monitor/__tests__/windLeaderTodayDetail.spec.ts
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { WindLeaderService, type TodayHotSpotsResult } from '../WindLeaderService';
import { WindLeaderController } from '../windLeaderController';

type WindLeaderStock = { code: string; name: string; price: number | null; change_pct: number | null };

const SNAPSHOT = {
    trading_date: '2026-11-13',
    is_live: true,
    update_time: '2026-11-13 14:30:00',
    source: 'realtime',
    boards: [
        {
            board_code: '885517',
            board_name: '人形机器人',
            rank: 1,
            change_pct: 6.2,
            amount: 123456789,
            change_source: 'realtime',
            leading_stock: { code: '300308', name: '中际旭创', change_pct: 5.12 },
        },
        {
            board_code: '885520',
            board_name: '低空经济',
            rank: 2,
            change_pct: -1.4,
            amount: 98765432,
            change_source: 'realtime',
            leading_stock: null,
        },
    ],
} as unknown as TodayHotSpotsResult;

type PrivateService = {
    readTodaySnapshot: () => Promise<TodayHotSpotsResult | null>;
    loadBoardConstituents: (boardCode: string) => Promise<WindLeaderStock[]>;
};
const privateService = WindLeaderService as unknown as PrivateService;
const originalRead = privateService.readTodaySnapshot;
const originalLoad = privateService.loadBoardConstituents;

afterEach(() => {
    privateService.readTodaySnapshot = originalRead;
    privateService.loadBoardConstituents = originalLoad;
});

function mockRes() {
    return {
        statusCode: 0,
        body: null as null | { code: number; message: string; data: unknown },
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(payload: { code: number; message: string; data: unknown }) {
            this.body = payload;
            return this;
        },
    };
}

describe('WindLeaderService.getTodayHotSpotDetail', () => {
    it('按 code 命中，组装与 hot_sectors 同构的板块对象', async () => {
        privateService.readTodaySnapshot = async () => SNAPSHOT;
        privateService.loadBoardConstituents = async () => [
            { code: '300308', name: '中际旭创', price: 128.5, change_pct: 5.12 },
            { code: '002050', name: '三花智控', price: 33.2, change_pct: -1.3 },
        ];

        const detail = await WindLeaderService.getTodayHotSpotDetail('885517');

        assert.equal(detail?.trading_date, '2026-11-13');
        assert.equal(detail?.sector.name, '人形机器人');
        assert.equal(detail?.sector.code, '885517');
        assert.equal(detail?.sector.today_change, 6.2);
        assert.equal(detail?.sector.amount, 123456789);
        assert.deepEqual(detail?.sector.leading_stock_info, {
            code: '300308',
            name: '中际旭创',
            change_pct: 5.12,
            price: null,
        });
        assert.equal(detail?.sector.main_stocks?.length, 2);
        assert.equal(detail?.sector.up_count, 1);
        assert.equal(detail?.sector.down_count, 1);
        assert.equal(detail?.sector.freq10, 0);
        assert.equal(detail?.sector.freq120, 0);
    });

    it('code 未命中时按 name 兜底，仍未命中返回 null', async () => {
        privateService.readTodaySnapshot = async () => SNAPSHOT;
        privateService.loadBoardConstituents = async () => [];

        const byName = await WindLeaderService.getTodayHotSpotDetail('nope', '低空经济');
        assert.equal(byName?.sector.code, '885520');
        assert.equal(byName?.sector.up_count, undefined);

        assert.equal(await WindLeaderService.getTodayHotSpotDetail('nope', '不存在'), null);
    });

    it('成分股为空时降级：main_stocks 为空、涨跌家数为 undefined', async () => {
        // 换交易日避开上一条用例写入的详情缓存（缓存 key = 交易日 + 板块）
        privateService.readTodaySnapshot = async () => ({ ...SNAPSHOT, trading_date: '2026-11-14' });
        privateService.loadBoardConstituents = async () => [];

        const detail = await WindLeaderService.getTodayHotSpotDetail('885517');
        assert.deepEqual(detail?.sector.main_stocks, []);
        assert.equal(detail?.sector.up_count, undefined);
        assert.equal(detail?.sector.down_count, undefined);
    });

    it('今日快照不可用返回 null', async () => {
        privateService.readTodaySnapshot = async () => null;
        assert.equal(await WindLeaderService.getTodayHotSpotDetail('885517'), null);
    });
});

describe('WindLeaderController.getTodayHotSpotDetail', () => {
    const originalDetail = WindLeaderService.getTodayHotSpotDetail;
    afterEach(() => {
        WindLeaderService.getTodayHotSpotDetail = originalDetail;
    });

    it('code 与 name 都缺失返回 400', async () => {
        const res = mockRes();
        await WindLeaderController.getTodayHotSpotDetail({ query: {} } as never, res as never, (() => {}) as never);
        assert.equal(res.statusCode, 400);
    });

    it('未命中返回 404', async () => {
        WindLeaderService.getTodayHotSpotDetail = async () => null;
        const res = mockRes();
        await WindLeaderController.getTodayHotSpotDetail(
            { query: { code: '999999' } } as never,
            res as never,
            (() => {}) as never,
        );
        assert.equal(res.statusCode, 404);
        assert.equal(res.body?.data, null);
    });

    it('命中返回 200 与详情数据', async () => {
        WindLeaderService.getTodayHotSpotDetail = async () => ({
            trading_date: '2026-11-13',
            is_live: true,
            update_time: '2026-11-13 14:30:00',
            source: 'realtime',
            sector: { code: '885517', name: '人形机器人' },
        }) as never;
        const res = mockRes();
        await WindLeaderController.getTodayHotSpotDetail(
            { query: { code: '885517' } } as never,
            res as never,
            (() => {}) as never,
        );
        assert.equal(res.statusCode, 200);
        assert.equal((res.body?.data as { sector: { name: string } }).sector.name, '人形机器人');
    });
});
