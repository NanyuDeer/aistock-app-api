import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getQuoteTradeDate,
    normalizeDateOnly,
    normalizePushHistoryRecord,
    resolvePushDate,
} from '../pushHistoryDates';

test('resolvePushDate trusts the immutable push identity over a corrupted database date', () => {
    const record = {
        push_id: 'windleader_20260717_002185_国家大基金持股_核心',
        push_batch_id: 'windleader_20260717',
        push_time: '2026/7/17 03:00:17',
        push_date: '2026-07-15',
    };

    assert.equal(resolvePushDate(record), '2026-07-17');
});

test('normalizePushHistoryRecord standardizes compact trade dates', () => {
    const record = normalizePushHistoryRecord({
        push_id: 'windleader_20260623_688662_共封装光学_CPO_核心',
        push_date: '2026-06-16',
        latest_trade_date: '20260716',
    });

    assert.equal(record.push_date, '2026-06-23');
    assert.equal(record.latest_trade_date, '2026-07-16');
});

test('quote trade date comes from the Tencent quote timestamp', () => {
    assert.equal(getQuoteTradeDate({ 行情时间: '20260717150000' }), '2026-07-17');
    assert.equal(getQuoteTradeDate({}), null);
});

test('normalizeDateOnly rejects impossible dates', () => {
    assert.equal(normalizeDateOnly('2026-02-29'), null);
    assert.equal(normalizeDateOnly('2024-02-29'), '2024-02-29');
});
