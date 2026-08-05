import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthlySeries, isMonthlyBullish, classifyMonthlySignal } from '../src/modules/monitor/WindLeaderAnalyzerService';

/** 构造单调递增/递减的月收盘序列（从 base 起，每月 +step 或 -step） */
function buildMonths(count: number, base = 100, step = 3): number[] {
    const arr: number[] = [];
    for (let i = 0; i < count; i++) arr.push(base + i * step);
    return arr;
}

test('isMonthlyBullish: 13个月单调递增返回 true', () => {
    assert.equal(isMonthlyBullish(buildMonths(13)), true);
});

test('isMonthlyBullish: 13个月单调递减返回 false', () => {
    assert.equal(isMonthlyBullish(buildMonths(13).map((v, i, a) => a[a.length - 1 - i])), false);
});

test('isMonthlyBullish: 数据不足13个月返回 false', () => {
    assert.equal(isMonthlyBullish(buildMonths(12)), false);
});

test('isMonthlyBullish: 同比向下（第13根低于首根）返回 false', () => {
    // 前12个月递增到 ~133，但第13根回落至 90（低于12个月前基准 100）
    const months = buildMonths(12);
    months.push(90);
    assert.equal(isMonthlyBullish(months), false);
});

test('isMonthlyBullish: 环比向下（最新月低于上月）返回 false', () => {
    const months = buildMonths(13);
    months[12] = months[11] - 1; // 最新月低于上月
    assert.equal(isMonthlyBullish(months), false);
});

test('buildMonthlySeries: 倒序输入仍取每月月末收盘（Tushare日线倒序契约）', () => {
    // Tushare ths_daily 返回倒序（最新交易日在前）
    const rows = [
        { trade_date: '20260803', close: 120 }, // 8月最新交易日
        { trade_date: '20260802', close: 118 },
        { trade_date: '20260731', close: 110 }, // 7月末
        { trade_date: '20260730', close: 108 },
        { trade_date: '20260630', close: 100 }, // 6月末
    ];
    // 升序聚合：6月末100、7月末110、8月末120（取月末收盘而非月初）
    assert.deepEqual(buildMonthlySeries(rows), [100, 110, 120]);
});

test('classifyMonthlySignal: 近3月连续多头为强信号', () => {
    // 单调上行序列：最近3月均满足 close > MA5 > MA10
    const months = [100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126, 128, 130];
    assert.equal(classifyMonthlySignal(months), 'strong');
});

test('classifyMonthlySignal: 近6月多头≥4且最近1月多头为次信号', () => {
    // 近6月走强且多头月≥5，但倒数第2月回调打破近3月连续 → weak
    const months = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 112, 114, 108, 116, 118];
    assert.equal(classifyMonthlySignal(months), 'weak');
});

test('classifyMonthlySignal: 月K不足16根返回 none', () => {
    const months = [100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126, 128];
    assert.equal(classifyMonthlySignal(months), 'none');
});

test('classifyMonthlySignal: 近6月多头月不足4返回 none', () => {
    const months = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85];
    assert.equal(classifyMonthlySignal(months), 'none');
});

test('buildMonthlySeries: 乱序输入结果稳定', () => {
    const rows = [
        { trade_date: '20260730', close: 108 },
        { trade_date: '20260802', close: 118 },
        { trade_date: '20260630', close: 100 },
        { trade_date: '20260803', close: 120 },
        { trade_date: '20260731', close: 110 },
    ];
    assert.deepEqual(buildMonthlySeries(rows), [100, 110, 120]);
});
