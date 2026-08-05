import test from 'node:test';
import assert from 'node:assert/strict';
import { calcMa60Status, calcVolTrend, calcFreqDelta } from '../src/modules/monitor/WindLeaderAnalyzerService';

test('calcMa60Status: 收盘远高于60日均线为站上', () => {
    // 100 根：前 40 根 100，后 60 根线性升至 200 → close(200) > ma60
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) closes.push(100);
    for (let i = 1; i <= 60; i++) closes.push(100 + i * 100 / 60);
    assert.ok(calcMa60Status(closes).startsWith('站上'));
});

test('calcMa60Status: 收盘低于60日均线为跌破', () => {
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) closes.push(200);
    for (let i = 1; i <= 60; i++) closes.push(200 - i * 100 / 60);
    assert.ok(calcMa60Status(closes).startsWith('跌破'));
});

test('calcMa60Status: 不足60根返回数据不足', () => {
    assert.equal(calcMa60Status(Array(30).fill(100)), '数据不足');
});

test('calcVolTrend: 近5日均量较前5日放大>1.2倍为放量', () => {
    const vols = [100, 100, 100, 100, 100, 200, 200, 200, 200, 200];
    assert.equal(calcVolTrend(vols), '放量');
});

test('calcVolTrend: 近5日均量较前5日缩小<0.8倍为缩量', () => {
    const vols = [200, 200, 200, 200, 200, 100, 100, 100, 100, 100];
    assert.equal(calcVolTrend(vols), '缩量');
});

test('calcFreqDelta: 近5日上榜3次/前5日1次 → 3（陡升）', () => {
    // 最近10天是否上榜（升序，旧→新；1=上榜）：前5日1次，近5日3次
    const hits = [0, 0, 0, 0, 1, 1, 0, 1, 0, 1];
    assert.equal(calcFreqDelta(hits), 3);
});

test('calcFreqDelta: 前5日为0且近5日>0 → 99（从无到有陡升哨兵）', () => {
    const hits = [0, 0, 0, 0, 0, 1, 0, 1, 0, 1];
    assert.equal(calcFreqDelta(hits), 99);
});

test('calcFreqDelta: 均未上榜 → 0', () => {
    assert.equal(calcFreqDelta(Array(10).fill(0)), 0);
});
