import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiPrompt } from '../src/modules/monitor/WindLeaderAnalyzerService';

const baseConcept = {
    code: 'BK0001', name: '半导体', type: 'concept',
    frequency: 12, freq20: 5, avg_change: 3.2, today_change: 2.1,
    net_inflow: 800, ma60_status: '站上(+5.2%)', vol_trend: '放量', turnover: 12.5,
    leading_stock: '中芯国际', leading_change: 8.5,
    up_count: 30, down_count: 8, score: 88,
};

const transmission = { upstream: [{ name: '上游', factor: 0.6, source_industry: '材料' }], downstream: [] };

test('buildAiPrompt: 输出包含八字段指令且不含近20日硬编码', () => {
    const prompt = buildAiPrompt('半导体', baseConcept as any, transmission as any, 'strong', 60, 'both');
    assert.ok(prompt.includes('long_term_days'));
    assert.ok(prompt.includes('long_confidence'));
    assert.ok(prompt.includes('logic_type'));
    assert.ok(prompt.includes('long_reason'));
    assert.ok(prompt.includes('short_term_days'));
    assert.ok(prompt.includes('short_heat'));
    assert.ok(prompt.includes('heat_stage'));
    assert.ok(prompt.includes('short_reason'));
    assert.ok(!prompt.includes('近20日上榜频次'));
    assert.ok(prompt.includes('60日上榜频次'));
});

test('buildAiPrompt: 双链结构 + 新证据输入，且不含规则基线/驱动占位', () => {
    const prompt = buildAiPrompt('半导体', baseConcept as any, transmission as any, 'strong', 60, 'both');
    assert.ok(prompt.includes('长线链'));
    assert.ok(prompt.includes('短线链'));
    assert.ok(prompt.includes('MA60位置'));
    assert.ok(prompt.includes('频次变化率'));
    assert.ok(prompt.includes('涨停家数'));
    assert.ok(prompt.includes('换手率'));
    assert.ok(prompt.includes('强信号(近3月连续多头排列)'));
    assert.ok(!prompt.includes('规则引擎参考基线'));
    assert.ok(!prompt.includes('驱动因素'));
});

test('buildAiPrompt: chain=long 不含短线数据与短线字段', () => {
    const prompt = buildAiPrompt('半导体', baseConcept as any, transmission as any, 'strong', 60, 'long');
    assert.ok(prompt.includes('MA60位置'));
    assert.ok(!prompt.includes('涨停家数'));
    assert.ok(!prompt.includes('short_term_days'));
});

test('buildAiPrompt: chain=short 不含长线数据与长线字段', () => {
    const prompt = buildAiPrompt('半导体', baseConcept as any, transmission as any, 'none', 60, 'short');
    assert.ok(prompt.includes('涨停家数'));
    assert.ok(!prompt.includes('MA60位置'));
    assert.ok(!prompt.includes('long_term_days'));
});
