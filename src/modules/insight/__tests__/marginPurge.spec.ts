import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPurgeSeries } from '../marginPurge';

const O = { threshold: -0.08, peakWindow: 20, maWindow: 3, minHistory: 6 };

test('历史不足时回撤为 null，且不产生回合', () => {
    const rows = buildPurgeSeries(
        [100, 101, 102, 103, 104, 105].map((b, i) => ({ date: `d${i}`, balance: b })),
        O,
    );
    assert.equal(rows[4].drawdown, null);
    assert.equal(rows[4].peak250, null);
    assert.equal(rows[4].phase, 'none');
    assert.equal(rows[5].drawdown, 0);        // 历史够了，回撤 0
    assert.equal(rows[5].phase, 'none');
});

test('回撤按窗口内最高点算', () => {
    const rows = buildPurgeSeries(
        [100, 110, 105, 100, 95, 90, 88].map((b, i) => ({ date: `d${i}`, balance: b })),
        O,
    );
    // 第 6 天（index 6）窗口是 110..88，高点 110
    assert.equal(rows[6].peak250, 110);
    assert.equal(rows[6].peakDate, 'd1');
    assert.ok(Math.abs((rows[6].drawdown as number) - (88 / 110 - 1)) < 1e-12);
    assert.equal(rows[6].phase, 'purging');
    assert.equal(rows[6].episodeId, 1);
});

test('回合连续、回到阈值上方即结束、再跌破开新回合', () => {
    // index: 0..5 建历史(100)，6 跌破 -8%，7 继续，8 回到上方，9 再跌破
    const seq = [100, 100, 100, 100, 100, 100, 90, 85, 100, 90];
    const rows = buildPurgeSeries(seq.map((b, i) => ({ date: `d${i}`, balance: b })), O);
    assert.equal(rows[6].episodeId, 1);
    assert.equal(rows[7].episodeId, 1);
    assert.equal(rows[7].episodeDays, 2);
    assert.equal(rows[8].episodeId, null);
    assert.equal(rows[8].phase, 'none');
    assert.equal(rows[9].episodeId, 2);
    assert.equal(rows[9].episodeStart, 'd9');
});

test('回合内首次上穿均线记一次 complete，第二次不再记', () => {
    // 同一回合内两次上穿（92、91），只有第一次记 complete
    const seq = [100, 100, 100, 100, 100, 100, 90, 88, 92, 85, 91];
    const rows = buildPurgeSeries(seq.map((b, i) => ({ date: `d${i}`, balance: b })), O);
    const events = rows.filter((r) => r.eventKind === 'complete');
    assert.equal(events.length, 1);
    assert.equal(events[0].tradeDate, 'd8');   // 88 -> 92 上穿 3 日均线
    assert.equal(events[0].phase, 'easing');
    assert.equal(rows[10].episodeId, 1);       // 同回合
    assert.equal(rows[10].eventKind, null);    // 第二次上穿不记
});

test('连续低于均线的天数会累加，回到上方归零', () => {
    const seq = [100, 100, 100, 100, 100, 100, 90, 85, 100];
    const rows = buildPurgeSeries(seq.map((b, i) => ({ date: `d${i}`, balance: b })), O);
    assert.equal(rows[6].belowMa20Days, 1);
    assert.equal(rows[7].belowMa20Days, 2);
    assert.equal(rows[8].belowMa20Days, 0);
});
