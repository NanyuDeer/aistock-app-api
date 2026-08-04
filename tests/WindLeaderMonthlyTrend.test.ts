import test from 'node:test';
import assert from 'node:assert/strict';
import { isMonthlyBullish } from '../src/modules/monitor/WindLeaderAnalyzerService';

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
