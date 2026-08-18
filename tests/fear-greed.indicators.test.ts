import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    clamp,
    percentileRank,
    labelOf,
    pctRankOrNeutral,
    sparkline,
} from '../src/modules/fear-greed/indicators';

test('clamp 限制在 [lo, hi]', () => {
    assert.equal(clamp(150), 100);
    assert.equal(clamp(-10), 0);
    assert.equal(clamp(55), 55);
    assert.equal(clamp(101, 0, 100), 100);
});

test('percentileRank 经验分布百分位（小于 + 等于一半）', () => {
    // [0,1,2,3,4] 中 value=3 → 小于3的有3个(0,1,2)，等于3的一个算半个 → (3+0.5)/5=70
    assert.equal(percentileRank(3, [0, 1, 2, 3, 4]), 70);
    // 最小 → 0.5/5=10
    assert.equal(percentileRank(0, [0, 1, 2, 3, 4]), 10);
    // 最大 → (4+0.5)/5=90
    assert.equal(percentileRank(4, [0, 1, 2, 3, 4]), 90);
    // 空历史 → 50
    assert.equal(percentileRank(1, []), 50);
});

test('pctRankOrNeutral 历史不足 30 时返回 50', () => {
    assert.equal(pctRankOrNeutral([1, 2, 3], 2), 50);
    // 30+ 条才参与百分位：(39 + 0.5) / 40 * 100 = 98.75
    const series = Array.from({ length: 40 }, (_, i) => i + 1);
    assert.equal(pctRankOrNeutral(series, 40), 98.75);
});

test('labelOf 五档恐贪标签', () => {
    assert.equal(labelOf(12), '极度恐惧');
    assert.equal(labelOf(32), '恐惧');
    assert.equal(labelOf(50), '中性');
    assert.equal(labelOf(65), '贪婪');
    assert.equal(labelOf(92), '极度贪婪');
    assert.equal(labelOf(25), '恐惧'); // 边界：25 属恐惧
    assert.equal(labelOf(79), '贪婪'); // 边界：79 属贪婪
    assert.equal(labelOf(80), '极度贪婪'); // 边界：80 属极度贪婪
});

test('sparkline 截取最近窗口并倒序', () => {
    const series = [10, 20, 30, 40, 50];
    const dates = ['d1', 'd2', 'd3', 'd4', 'd5'];
    const out = sparkline(series, dates, 500);
    assert.equal(out.scores.length, 5);
    // 最新在前
    assert.equal(out.dates[0], 'd5');
    assert.equal(out.dates[out.dates.length - 1], 'd1');
    // 每个值转百分位（在完整序列中的位置）
    assert.equal(out.scores[0], percentileRank(50, series));
});

test('sparkline reverse=true 取反（100 - 百分位）', () => {
    const series = [10, 20, 30, 40, 50];
    const out = sparkline(series, ['d1', 'd2', 'd3', 'd4', 'd5'], 500, true);
    assert.equal(out.scores[0], Math.round((100 - percentileRank(50, series)) * 100) / 100);
});
