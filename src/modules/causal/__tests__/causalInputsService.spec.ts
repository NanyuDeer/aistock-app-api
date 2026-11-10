/**
 * 归因输入聚合单测 —— 全部依赖注入，不打真实网络、不连库。
 * 运行：node --import tsx --test src/modules/causal/__tests__/causalInputsService.spec.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildCausalInputs,
    sliceWindow,
    type CausalInputsDeps,
    type PricePoint,
} from '../causalInputsService';

function klineRows(points: Array<[string, number]>): Record<string, unknown>[] {
    return points.map(([date, close]) => ({
        时间: date,
        开盘价: close,
        收盘价: close,
        最高价: close,
        最低价: close,
        成交量: 1000,
    }));
}

function makeDeps(overrides: Partial<CausalInputsDeps> = {}): CausalInputsDeps {
    return {
        getKLine: async () =>
            klineRows([
                ['2026-10-30', 100],
                ['2026-11-02', 101],
                ['2026-11-03', 102],
                ['2026-11-04', 110],
                ['2026-11-05', 108],
                ['2026-11-06', 109],
            ]),
        getMoneyflow: async () => ({ main_net: 12_345 }),
        querySectorReturns: async () => ({ 半导体: 3.2, 光模块: -1.1 }),
        findConsensusAsOf: async () => ({
            symbol: '000300.SH',
            version_date: '2026-10-31',
            update_time: '2026-10-31 21:15:00',
            summary: '',
            forecast_detail: [],
            forecast_netprofit_yoy: 18.5,
            forecast_netprofit: null,
            forecast_eps: 1.23,
            forecast_eps_yoy: 12,
        }),
        ...overrides,
    };
}

describe('sliceWindow', () => {
    const points: PricePoint[] = [
        { date: '2026-10-30', close: 100, pctChg: null },
        { date: '2026-11-02', close: 101, pctChg: 1 },
        { date: '2026-11-03', close: 102, pctChg: 0.99 },
        { date: '2026-11-04', close: 110, pctChg: 7.84 },
        { date: '2026-11-05', close: 108, pctChg: -1.82 },
        { date: '2026-11-06', close: 109, pctChg: 0.93 },
    ];

    it('取事件前 pre 个与事件后 post 个交易日（含当日）', () => {
        const windowed = sliceWindow(points, '2026-11-04', 2, 1);
        assert.deepEqual(
            windowed.map((p) => p.date),
            ['2026-11-03', '2026-11-04', '2026-11-05'],
        );
    });

    it('交易日不在序列中时，以不晚于它的最后一条为基准', () => {
        const windowed = sliceWindow(points, '2026-11-04', 1, 1);
        assert.deepEqual(
            windowed.map((p) => p.date),
            ['2026-11-04', '2026-11-05'],
        );
    });

    it('全部数据都晚于目标日时返回空', () => {
        assert.deepEqual(sliceWindow(points, '2026-10-01', 2, 2), []);
    });
});

describe('buildCausalInputs', () => {
    it('返回四类数据并标记完整度', async () => {
        const result = await buildCausalInputs(
            { tradeDate: '2026-11-04', window: { pre: 2, post: 1 }, symbols: ['000300.SH'] },
            makeDeps(),
        );

        assert.equal(result.asOf, '2026-11-04T15:05:00+08:00');
        assert.deepEqual(
            result.prices['000300.SH'].map((p) => p.date),
            ['2026-11-03', '2026-11-04', '2026-11-05'],
        );
        assert.deepEqual(result.sectorReturns, { 半导体: 3.2, 光模块: -1.1 });
        assert.equal(result.flows?.['000300.SH'], 12345);
        assert.equal(result.consensus?.['000300.SH']?.eps, 1.23);
        assert.deepEqual(result.completeness, {
            prices: true,
            sector_returns: true,
            flows: true,
            consensus: true,
        });
    });

    it('无数据时返回 null 而不是空对象（避免被误判为「无反应」）', async () => {
        const result = await buildCausalInputs(
            { tradeDate: '2026-11-04', symbols: ['000300.SH'] },
            makeDeps({
                getKLine: async () => [],
                getMoneyflow: async () => null,
                querySectorReturns: async () => ({}),
                findConsensusAsOf: async () => null,
            }),
        );

        assert.deepEqual(result.prices, {});
        assert.equal(result.sectorReturns, null);
        assert.equal(result.flows, null);
        assert.equal(result.consensus, null);
        assert.equal(result.completeness.prices, false);
        assert.equal(result.completeness.consensus, false);
    });

    it('按 need 只取需要的类别', async () => {
        let consensusCalled = false;
        const result = await buildCausalInputs(
            { tradeDate: '2026-11-04', symbols: ['000300.SH'], need: ['prices'] },
            makeDeps({
                findConsensusAsOf: async () => {
                    consensusCalled = true;
                    return null;
                },
            }),
        );

        assert.ok(result.prices['000300.SH'].length > 0);
        assert.equal(result.consensus, null);
        assert.equal(consensusCalled, false);
    });

    it('拒绝非法日期与空标的集', async () => {
        await assert.rejects(
            buildCausalInputs({ tradeDate: '2026/11/04', symbols: ['000300.SH'] }, makeDeps()),
            /invalid tradeDate/,
        );
        await assert.rejects(
            buildCausalInputs({ tradeDate: '2026-11-04', symbols: [] }, makeDeps()),
            /symbols must not be empty/,
        );
    });

    it('涨跌幅相对前一交易日收盘计算', async () => {
        const result = await buildCausalInputs(
            { tradeDate: '2026-11-04', window: { pre: 2, post: 0 }, symbols: ['000300.SH'] },
            makeDeps(),
        );
        const points = result.prices['000300.SH'];
        const last = points[points.length - 1];
        assert.equal(last.date, '2026-11-04');
        assert.equal(last.pctChg, 7.84);
    });
});
