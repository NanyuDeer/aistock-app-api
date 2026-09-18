import assert from 'node:assert/strict';
import test from 'node:test';
import { stockTraceStableHash, toCapitalSourceRecord } from '../StockTraceSnapshotService';

test('snapshot source hash is key-order independent and preserves trigger time', () => {
    const first = stockTraceStableHash({ b: 2, a: 1, triggered_at: new Date('2026-07-30T02:15:00.000Z') });
    const reordered = stockTraceStableHash({ a: 1, triggered_at: new Date('2026-07-30T02:15:00.000Z'), b: 2 });
    const later = stockTraceStableHash({ a: 1, b: 2, triggered_at: new Date('2026-07-30T02:15:01.000Z') });

    assert.equal(first, reordered);
    assert.notEqual(first, later);
});

test('capital 证据透出分单结构与多窗口拆解并标注 trade_date', () => {
    // 2026-09-18：资金降级为条件准入层后，证据须含"价格读不出的增量信息"才可能被置 supported/weak，
    // 故 orders/windows 不能再被丢弃；正文须标注 trade_date 以支撑"同日可 supported、T-1 最高 weak"分档。
    const capturedAt = new Date('2026-09-18T07:05:00.000Z');
    const record = toCapitalSourceRecord({
        symbol: '600519', tradeDate: '20260917', mainInflow: 2.5, retailInflow: -1.2,
        ratio: '3.1%', fiveDay: 8.8, tenDay: 10, twentyDay: 12, streak: '连买2天',
        tag: '主题流入', tagClass: 'is-bull', trendBadge: '', narrative: '', risk: '', summary: '',
        trend: [], trendDates: [],
        orders: [
            { label: '超大单', value: 1.5 }, { label: '大单', value: 1 },
            { label: '中单', value: -0.5 }, { label: '小单', value: -0.7 },
        ],
        windows: [{
            days: 5, mainInflow: 8.8, retailInflow: -3, ratio: 2.2,
            orders: [{ label: '超大单', value: 5 }],
        }],
    }, '600519', capturedAt);

    assert.equal(record.kind, 'capital_fact');
    assert.equal(record.sourceId, 'capital:600519:20260917');
    assert.match(record.contentExcerpt, /截至 20260917/);
    assert.match(record.contentExcerpt, /超大单 1.5 亿/);

    const payload = record.payload as {
        trade_date: string;
        orders: { label: string; value: number }[];
        windows: { days: number; main_inflow: number; retail_inflow: number }[];
    };
    assert.equal(payload.trade_date, '20260917');
    assert.equal(payload.orders.length, 4);
    assert.equal(payload.orders[0].label, '超大单');
    assert.equal(payload.windows[0].days, 5);
    assert.equal(payload.windows[0].main_inflow, 8.8);
    assert.equal(payload.windows[0].retail_inflow, -3);
});
