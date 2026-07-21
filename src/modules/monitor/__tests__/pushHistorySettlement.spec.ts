import assert from 'node:assert/strict';
import test from 'node:test';
import {
    canRunCloseSettlement,
    getExpectedCloseTradeDate,
    isPushHistoryRecordSettled,
    needsCloseSettlement,
} from '../pushHistorySettlement';

test('uses the previous trading close before 15:30 Shanghai time', () => {
    const beforeClose = new Date('2026-07-17T07:29:00.000Z');
    assert.equal(canRunCloseSettlement(beforeClose), false);
    assert.equal(getExpectedCloseTradeDate(beforeClose), '2026-07-16');
});

test('settles the current trading day from 15:30 Shanghai time', () => {
    const afterClose = new Date('2026-07-17T07:30:00.000Z');
    assert.equal(canRunCloseSettlement(afterClose), true);
    assert.equal(getExpectedCloseTradeDate(afterClose), '2026-07-17');
});

test('uses the latest completed trading day on weekends', () => {
    const saturday = new Date('2026-07-18T02:00:00.000Z');
    assert.equal(canRunCloseSettlement(saturday), true);
    assert.equal(getExpectedCloseTradeDate(saturday), '2026-07-17');
});

test('publishes only records with a completed close settlement', () => {
    const settled = {
        push_date: '2026-07-17',
        latest_trade_date: '2026-07-17',
        push_price: 20.04,
        latest_price: 20.68,
        realtime_time: '2026-07-17T07:30:00.000Z',
    };
    assert.equal(isPushHistoryRecordSettled(settled), true);
    assert.equal(isPushHistoryRecordSettled({ ...settled, realtime_time: null }), false);
    assert.equal(isPushHistoryRecordSettled({ ...settled, latest_trade_date: '2026-07-16' }), false);
});

test('detects a missing daily close update', () => {
    const records = [{
        push_date: '2026-07-17',
        latest_trade_date: '2026-07-17',
        push_price: 20.04,
        latest_price: 20.68,
        realtime_time: '2026-07-17T07:30:00.000Z',
    }];
    assert.equal(needsCloseSettlement(records, '2026-07-17'), false);
    assert.equal(needsCloseSettlement(records, '2026-07-20'), true);
    assert.equal(needsCloseSettlement([{
        ...records[0],
        latest_trade_date: '2026-07-16',
    }], '2026-07-17'), false);
});
