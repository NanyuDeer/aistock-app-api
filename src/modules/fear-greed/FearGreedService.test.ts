import test from 'node:test';
import assert from 'node:assert/strict';
import { pgDateToYmd } from './FearGreedService';

// 回归：pg 驱动把 DATE 列解析为 Date 对象，直接 String() 会得到
// "Wed Nov 04 2026 ..." 与计算侧 YYYYMMDD 键永不相等，
// 导致 breadth/limit 缓存 0 命中、每次计算全量重抓 500 个交易日
// （2026-11-08 线上「恐贪指数一直无数据」根因）。
test('pgDateToYmd: Date 对象按本地日期归一为 YYYYMMDD', () => {
    assert.equal(pgDateToYmd(new Date(2026, 10, 4)), '20261104');
    assert.equal(pgDateToYmd(new Date(2026, 0, 1)), '20260101');
});

test('pgDateToYmd: 字符串日期兼容 YYYY-MM-DD / YYYYMMDD', () => {
    assert.equal(pgDateToYmd('2026-11-04'), '20261104');
    assert.equal(pgDateToYmd('20261104'), '20261104');
});
