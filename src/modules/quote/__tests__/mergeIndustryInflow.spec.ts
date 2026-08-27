/**
 * D6（2026-08-17 数据源裁决）：mergeIndustryInflow 单元测试
 *
 * 契约：以 cnt_ths（概念板块，净额单位亿元）为主，ind_dc（行业板块，净额单位元）
 * 按名称归一匹配补漏——仅补净流入为 0 的概念板块行；单位 /1e8 对齐亿元。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeIndustryInflow } from '../MarketSnapshotService';
import type { MoneyflowCntThsRow } from '../TushareService';

function conceptRow(overrides: Partial<MoneyflowCntThsRow>): MoneyflowCntThsRow {
    return {
        trade_date: '20260817',
        ts_code: '885748.TI',
        name: '半导体',
        lead_stock: '中芯国际',
        close_price: 1000,
        pct_change: 2.5,
        industry_index: 1500,
        company_num: 30,
        pct_change_stock: 3.1,
        net_buy_amount: 10,
        net_sell_amount: 6,
        net_amount: 4, // 亿元
        ...overrides,
    };
}

function indRow(overrides: Partial<Record<string, unknown>>) {
    return {
        trade_date: '20260817',
        content_type: '行业',
        ts_code: 'BK1036.DC',
        name: '半导体',
        pct_change: 2.5,
        close: 1500,
        net_amount: 3e8, // 元 = 3 亿元
        net_amount_rate: 2.0,
        buy_elg_amount: 1e8,
        buy_lg_amount: 2e8,
        buy_md_amount: 1e8,
        buy_sm_amount: 0.5e8,
        buy_sm_amount_stock: '长鑫科技',
        rank: 1,
        ...overrides,
    };
}

describe('mergeIndustryInflow（D6 行业板块补漏）', () => {
    it('概念板块净流入为 0 且名称归一匹配 → 用行业板块净额补齐（元 → 亿元）', () => {
        const concepts = [conceptRow({ name: '半导体', net_amount: 0 })];
        const industries = [indRow({})];
        const merged = mergeIndustryInflow(concepts, industries);
        assert.equal(merged.length, 1);
        assert.equal(merged[0].net_amount, 3); // 3e8 元 = 3 亿元
    });

    it('概念板块已有净流入 → 不覆盖（防覆盖真实值）', () => {
        const concepts = [conceptRow({ name: '半导体', net_amount: 4 })];
        const industries = [indRow({})];
        const merged = mergeIndustryInflow(concepts, industries);
        assert.equal(merged[0].net_amount, 4);
    });

    it('名称不匹配 → 保持原样', () => {
        const concepts = [conceptRow({ name: '人工智能', net_amount: 0 })];
        const industries = [indRow({ name: '半导体' })];
        const merged = mergeIndustryInflow(concepts, industries);
        assert.equal(merged[0].net_amount, 0);
    });

    it('名称归一化（去括号/概念后缀/连接词/罗马数字）→ 匹配成功', () => {
        const concepts = [conceptRow({ name: '半导体概念', net_amount: 0 })];
        const industries = [indRow({ name: '半导体（指数）Ⅱ' })];
        const merged = mergeIndustryInflow(concepts, industries);
        assert.equal(merged[0].net_amount, 3);
    });

    it('同名多个行业板块 → 优先 content_type=行业，仍多个取净额绝对值最大者', () => {
        const concepts = [conceptRow({ name: '半导体', net_amount: 0 })];
        const industries = [
            indRow({ name: '半导体', content_type: '概念', net_amount: 1e8 }),
            indRow({ name: '半导体', content_type: '行业', net_amount: 2e8 }),
            indRow({ name: '半导体', content_type: '行业', net_amount: 3e8 }),
        ];
        const merged = mergeIndustryInflow(concepts, industries);
        assert.equal(merged[0].net_amount, 3);
    });

    it('行业板块为空 → 原样返回（无副作用）', () => {
        const concepts = [conceptRow({ name: '半导体', net_amount: 0 })];
        const merged = mergeIndustryInflow(concepts, []);
        assert.equal(merged.length, 1);
        assert.equal(merged[0].net_amount, 0);
    });
});
