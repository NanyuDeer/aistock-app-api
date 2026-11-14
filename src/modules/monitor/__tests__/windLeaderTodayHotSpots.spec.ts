/**
 * WindLeaderService.attachLeadingStocks：今日风口榜「板块名 → 龙头股」匹配（纯函数）
 *
 * 背景：
 *  - 今日风口榜（/api/cn/wind-leaders/today）以同花顺 mrpm 当日板块榜为排名，
 *    需从 hot-sectors.json 的 hot_sectors 里按板块名匹配出龙头股（code + name）。
 *  - 龙头 code 优先取 leading_stock_info.code，但必须校验其股票名与 leading_stock 一致
 *    （历史脏数据曾把新闻标题 / 日期串当 leading_stock），不一致时回退 main_stocks 按名称找。
 *  - 匹配不到一律返回 null，不抓取、不抛错。
 *
 * 运行：node --import tsx --test src/modules/monitor/__tests__/windLeaderTodayHotSpots.spec.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    attachLeadingStocks,
    fillLeadingStocksFromTopGainers,
    resolveStaleBoardClose,
    type HotSectorForLeader,
    type TodayHotSpotBoard,
} from '../WindLeaderService';
import type { BoardRealtime, TodayBoardItem } from '../RotationBoardStore';

function board(board_name: string, rank: number): TodayBoardItem {
    return {
        board_code: `88${String(1000 + rank)}`,
        board_name,
        rank,
        change_pct: 3.14,
        amount: 123,
        change_source: 'realtime',
    };
}

describe('attachLeadingStocks：按板块名匹配龙头股', () => {
    it('精确匹配板块名，leading_stock_info.code 且股票名与 leading_stock 一致 → 取该 code', () => {
        const sectors: HotSectorForLeader[] = [
            {
                name: '影视院线',
                leading_stock: '光线传媒',
                leading_stock_info: { code: '300251', name: '光线传媒' },
                main_stocks: [{ code: '000001', name: '其他股票' }],
            },
        ];
        const result = attachLeadingStocks([board('影视院线', 1)], sectors);
        assert.deepEqual(result[0].leading_stock, { code: '300251', name: '光线传媒', change_pct: null });
    });

    it('leading_stock_info 股票名与 leading_stock 不一致 → 回退 main_stocks 按名称找 code', () => {
        const sectors: HotSectorForLeader[] = [
            {
                name: '影视院线',
                leading_stock: '华谊兄弟',
                // 脏数据：info 指向另一只股票，名称对不上，不得采用
                leading_stock_info: { code: '300251', name: '光线传媒' },
                main_stocks: [{ code: '300027', name: '华谊兄弟' }],
            },
        ];
        const result = attachLeadingStocks([board('影视院线', 1)], sectors);
        assert.deepEqual(result[0].leading_stock, { code: '300027', name: '华谊兄弟', change_pct: null });
    });

    it('main_stocks 中找不到该名称 → leading_stock 为 null', () => {
        const sectors: HotSectorForLeader[] = [
            { name: '影视院线', leading_stock: '不存在股份', main_stocks: [{ code: '300027', name: '华谊兄弟' }] },
        ];
        const result = attachLeadingStocks([board('影视院线', 1)], sectors);
        assert.equal(result[0].leading_stock, null);
    });

    it('保留领涨股当日涨幅（info 与 main_stocks 回退两条路径）', () => {
        const sectors: HotSectorForLeader[] = [
            {
                name: '影视院线',
                leading_stock: '光线传媒',
                leading_stock_info: { code: '300251', name: '光线传媒', change_pct: 5.12 },
            },
            {
                name: '半导体',
                leading_stock: '中芯国际',
                main_stocks: [{ code: '688981', name: '中芯国际', change_pct: -2.5 }],
            },
        ];
        const result = attachLeadingStocks([board('影视院线', 1), board('半导体', 2)], sectors);
        assert.deepEqual(result[0].leading_stock, { code: '300251', name: '光线传媒', change_pct: 5.12 });
        assert.deepEqual(result[1].leading_stock, { code: '688981', name: '中芯国际', change_pct: -2.5 });
    });

    it('板块名无匹配 → leading_stock 为 null', () => {
        const sectors: HotSectorForLeader[] = [{ name: '半导体', leading_stock: '某芯片' }];
        const result = attachLeadingStocks([board('影视院线', 1)], sectors);
        assert.equal(result[0].leading_stock, null);
    });

    it('保留原榜单字段，hot_sectors 缺失/为空也不抛错', () => {
        const result = attachLeadingStocks([board('影视院线', 2)], null);
        assert.equal(result.length, 1);
        assert.deepEqual(result[0], { ...board('影视院线', 2), leading_stock: null });
        assert.deepEqual(attachLeadingStocks([], undefined), []);
    });

    it('多个板块各自匹配，顺序与排名保持不变', () => {
        const sectors: HotSectorForLeader[] = [
            { name: '半导体', leading_stock: '中芯国际', main_stocks: [{ code: '688981', name: '中芯国际' }] },
            { name: '影视院线', leading_stock: '光线传媒', main_stocks: [{ code: '300251', name: '光线传媒' }] },
        ];
        const result = attachLeadingStocks([board('影视院线', 1), board('半导体', 2), board('未知板块', 3)], sectors);
        assert.deepEqual(result.map(b => b.board_name), ['影视院线', '半导体', '未知板块']);
        assert.deepEqual(result.map(b => b.leading_stock?.code ?? null), ['300251', '688981', null]);
    });
});

describe('fillLeadingStocksFromTopGainers：成分股补领涨股', () => {
    function hotspot(board_name: string, rank: number, leading: TodayHotSpotBoard['leading_stock'] = null): TodayHotSpotBoard {
        return { ...board(board_name, rank), leading_stock: leading };
    }

    it('只为 leading_stock 为 null 的板块补，且不改动其他字段', () => {
        const boards = [hotspot('影视院线', 1), hotspot('猪肉', 2)];
        const topByCode = new Map([
            ['881001', { code: '300251', name: '光线传媒', change_pct: 9.98 }],
            ['881002', { code: '000895', name: '双汇发展', change_pct: 4.21 }],
        ]);
        const result = fillLeadingStocksFromTopGainers(boards, topByCode);
        assert.deepEqual(result[0].leading_stock, { code: '300251', name: '光线传媒', change_pct: 9.98 });
        assert.deepEqual(result[1].leading_stock, { code: '000895', name: '双汇发展', change_pct: 4.21 });
        assert.deepEqual(
            result.map(b => ({ code: b.board_code, name: b.board_name, rank: b.rank, pct: b.change_pct, amount: b.amount })),
            boards.map(b => ({ code: b.board_code, name: b.board_name, rank: b.rank, pct: b.change_pct, amount: b.amount })),
        );
    });

    it('已有龙头（hot_sectors 命中）不被覆盖', () => {
        const boards = [hotspot('银行', 1, { code: '600036', name: '招商银行', change_pct: 1.2 })];
        const topByCode = new Map([
            ['881001', { code: '601398', name: '工商银行', change_pct: 2.0 }],
        ]);
        const result = fillLeadingStocksFromTopGainers(boards, topByCode);
        assert.deepEqual(result[0].leading_stock, { code: '600036', name: '招商银行', change_pct: 1.2 });
    });

    it('已有龙头当日下跌（旧快照）→ 用成分股涨幅第一替换', () => {
        const boards = [hotspot('影视院线', 1, { code: '300133', name: '华策影视', change_pct: -13.97 })];
        const topByCode = new Map([
            ['881001', { code: '300251', name: '光线传媒', change_pct: 6.5 }],
        ]);
        const result = fillLeadingStocksFromTopGainers(boards, topByCode);
        assert.deepEqual(result[0].leading_stock, { code: '300251', name: '光线传媒', change_pct: 6.5 });
    });

    it('已有龙头涨跌幅缺失 → 用成分股涨幅第一补全', () => {
        const boards = [hotspot('影视院线', 1, { code: '300133', name: '华策影视', change_pct: null })];
        const topByCode = new Map([
            ['881001', { code: '300251', name: '光线传媒', change_pct: 6.5 }],
        ]);
        const result = fillLeadingStocksFromTopGainers(boards, topByCode);
        assert.deepEqual(result[0].leading_stock, { code: '300251', name: '光线传媒', change_pct: 6.5 });
    });

    it('负涨幅龙头但成分股缺失 → 保留原龙头，不置空', () => {
        const boards = [hotspot('影视院线', 1, { code: '300133', name: '华策影视', change_pct: -13.97 })];
        const result = fillLeadingStocksFromTopGainers(boards, new Map());
        assert.deepEqual(result[0].leading_stock, { code: '300133', name: '华策影视', change_pct: -13.97 });
    });

    it('成分股缺失 → 保持 null，且不修改入参', () => {
        const boards = [hotspot('保险', 1)];
        const result = fillLeadingStocksFromTopGainers(boards, new Map());
        assert.equal(result[0].leading_stock, null);
        assert.equal(boards[0].leading_stock, null, '入参保持不变');
    });
});

describe('resolveStaleBoardClose：其他板块「今日涨幅/成交额」收盘兜底', () => {
    const latestDate = '2026-11-13';

    function stale(overrides: Partial<BoardRealtime> = {}): BoardRealtime {
        return {
            date: '20261113',
            change_pct: null,
            amount: null,
            latest_amount: 231757200000,
            latest_change_pct: -3.3351,
            source: 'stale',
            ...overrides,
        };
    }

    it('stale 且盘口日期 === 最近交易日 → 返回四舍五入涨跌幅与成交额', () => {
        assert.deepEqual(resolveStaleBoardClose(stale(), latestDate), {
            change_pct: -3.34,
            amount: 231757200000,
            date: '2026-11-13',
        });
    });

    it('盘口日期与最近交易日不一致 → null（不跨日冒充）', () => {
        assert.equal(resolveStaleBoardClose(stale({ date: '20261112' }), latestDate), null);
    });

    it('实时盘口或盘口缺失 → null（实时路径已单独覆盖，不重复兜底）', () => {
        assert.equal(resolveStaleBoardClose(null, latestDate), null);
        assert.equal(resolveStaleBoardClose(undefined, latestDate), null);
        assert.equal(
            resolveStaleBoardClose(
                { date: '20261113', change_pct: 1.2, amount: 100, source: 'realtime' },
                latestDate,
            ),
            null,
        );
    });

    it('涨跌幅/成交额缺失 → 对应字段为 null，日期仍返回', () => {
        assert.deepEqual(
            resolveStaleBoardClose(stale({ latest_change_pct: null, latest_amount: null }), latestDate),
            { change_pct: null, amount: null, date: '2026-11-13' },
        );
    });

    it('涨跌幅 0（平盘）是有效值，不得当缺失', () => {
        const result = resolveStaleBoardClose(stale({ latest_change_pct: 0 }), latestDate);
        assert.equal(result?.change_pct, 0);
    });
});
