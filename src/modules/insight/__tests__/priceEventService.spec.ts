// src/modules/insight/__tests__/priceEventService.spec.ts
// 仓库惯例：node:test + assert + mock.method（非 jest）
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../../core/db';
import { createOrUpdatePriceEvent } from '../PriceEventService';
import type { PriceSnapshotRow } from '../PriceMoveService';

afterEach(() => { mock.restoreAll(); });

const snap = (over: Partial<PriceSnapshotRow> = {}): PriceSnapshotRow => ({
    symbol: '000962', tradeDate: '2026-08-07', snapshotType: 'midday',
    openPrice: 10, latestPrice: 10.7, moveBps: 700, direction: 'up',
    priceSource: 'realtime_snapshot', ...over,
});

describe('createOrUpdatePriceEvent', () => {
    it('午盘首次创建返回 price_move 事件 ID', async () => {
        mock.method(pool, 'query', async (sql: string) =>
            sql.includes('SELECT event_id')
                ? { rows: [] }
                : { rows: [{ event_id: 'wi_20260807_000962_pm_up' }] });
        const id = await createOrUpdatePriceEvent(snap());
        assert.equal(id, 'wi_20260807_000962_pm_up');
    });
    it('尾盘同方向复用既有事件并升级 event_type=close', async () => {
        mock.method(pool, 'query', async (sql: string) =>
            sql.includes('SELECT event_id')
                ? { rows: [{ event_id: 'wi_20260807_000962_pm_up', event_type: 'midday_price_move' }] }
                : { rows: [] });
        const id = await createOrUpdatePriceEvent(snap({ snapshotType: 'close' }));
        assert.equal(id, 'wi_20260807_000962_pm_up');
    });
    it('尾盘反方向创建独立 down 事件', async () => {
        mock.method(pool, 'query', async (sql: string) =>
            sql.includes('SELECT event_id')
                ? { rows: [] }
                : { rows: [{ event_id: 'wi_20260807_000962_pm_down' }] });
        const id = await createOrUpdatePriceEvent(snap({ snapshotType: 'close', latestPrice: 9.3, moveBps: -700, direction: 'down' }));
        assert.equal(id, 'wi_20260807_000962_pm_down');
    });
});