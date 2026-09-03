import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSectorBoardData,
    EMPTY_BOARD,
    type FgSectorLoaders,
} from '../src/modules/fear-greed/sectorBoard';

function fact(name: string, pct: number, net: number) {
    return { ts_code: 'BK0001', name, pct_change: pct, net_amount: net, lead_stock: 'X', company_num: 10, trade_date: '20260903' };
}

function loaders(over: Partial<FgSectorLoaders> = {}): FgSectorLoaders {
    return {
        concept: async () => ({
            gainers: [fact('A', 3, 1e8)],
            losers: [fact('B', -2, -1e8)],
            inflows: [fact('C', 1, 5e8)],
            outflows: [fact('D', 4, -5e8)],
            available: true,
        }),
        tencent: async () => ({ gainers: [fact('T1', 2, 0)], losers: [fact('T2', -1, 0)], available: true }),
        ...over,
    };
}

test('buildSectorBoardData: 东财主源返回四榜（camel 映射 + 元单位保留）', async () => {
    const out = await buildSectorBoardData(loaders());
    assert.equal(out.availability, true);
    assert.equal(out.source, 'eastmoney');
    assert.equal(out.tradeDate, '2026-09-03');
    assert.equal(out.sectors.topGainers[0].name, 'A');
    assert.equal(out.sectors.topGainers[0].pctChange, 3);
    assert.equal(out.sectors.topInflows[0].netAmount, 5e8);
    assert.equal(out.sectors.topOutflows[0].name, 'D');
});

test('buildSectorBoardData: 东财不可用时回退腾讯（只给涨跌幅榜，inflows 为空）', async () => {
    const out = await buildSectorBoardData(loaders({ concept: async () => ({ gainers: [], losers: [], inflows: [], outflows: [], available: false }) }));
    assert.equal(out.availability, true);
    assert.equal(out.source, 'tencent');
    assert.equal(out.sectors.topGainers[0].name, 'T1');
    assert.equal(out.sectors.topInflows.length, 0);
});

test('buildSectorBoardData: 双源都失败时 availability=false 空结构', async () => {
    const out = await buildSectorBoardData(loaders({
        concept: async () => ({ gainers: [], losers: [], inflows: [], outflows: [], available: false }),
        tencent: async () => ({ gainers: [], losers: [], available: false }),
    }));
    assert.deepEqual(out, { ...EMPTY_BOARD, tradeDate: out.tradeDate, source: '' });
    assert.equal(out.availability, false);
});
