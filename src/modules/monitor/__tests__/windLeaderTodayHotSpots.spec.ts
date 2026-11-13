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
    type HotSectorForLeader,
} from '../WindLeaderService';
import type { TodayBoardItem } from '../RotationBoardStore';

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
