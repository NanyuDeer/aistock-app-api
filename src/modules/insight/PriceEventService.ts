// src/modules/insight/PriceEventService.ts
import pool from '../../core/db';
import { buildEventId } from './InsightService';
import type { PriceSnapshotRow } from './PriceMoveService';

const INSIGHT_GROUP = 'price_move';

/**
 * 午盘首次达阈值 → 创建（event_type=midday_price_move）；
 * 尾盘同方向仍达阈值 → 更新既有事件（event_type=close_price_move）并返回原 eventId；
 * 尾盘方向与午盘相反 → 创建独立事件（event_type=close_price_move, direction 相反）。
 * 返回 null 表示事件已存在且无更新（尾盘同方向但无既有事件时亦创建）。
 */
export async function createOrUpdatePriceEvent(s: PriceSnapshotRow): Promise<string | null> {
    const eventId = buildEventId(s.symbol, s.tradeDate, 'pm', s.direction);
    const eventType = s.snapshotType === 'midday' ? 'midday_price_move' : 'close_price_move';

    const existing = await pool.query(
        `SELECT event_id, event_type FROM watchlist_insight_events
         WHERE symbol=$1 AND trade_date=$2 AND direction=$3 AND insight_group=$4`,
        [s.symbol, s.tradeDate, s.direction, INSIGHT_GROUP],
    );
    if (existing.rows.length > 0) {
        const cur = existing.rows[0];
        // 尾盘同方向 → 仅当 event_type 仍为 midday 时升级为 close（同一事件行，触发证据包新版本）
        if (s.snapshotType === 'close' && cur.event_type === 'midday_price_move') {
            await pool.query(
                `UPDATE watchlist_insight_events SET event_type='close_price_move', status='active' WHERE event_id=$1`,
                [cur.event_id]);
            return String(cur.event_id);
        }
        return String(cur.event_id); // 已是最新（close）或午盘重复触发 → 仍触发补抓证据包
    }

    const name = await stockNameOf(s.symbol); // 必须 await：Promise 不能直接进 INSERT 参数
    const res = await pool.query(
        `INSERT INTO watchlist_insight_events (event_id, symbol, stock_name, trade_date, event_type, direction, insight_group)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (symbol, trade_date, direction, insight_group) DO NOTHING RETURNING event_id`,
        [eventId, s.symbol, name, s.tradeDate, eventType, s.direction, INSIGHT_GROUP],
    );
    return res.rows.length > 0 ? String(res.rows[0].event_id) : null;
}

async function stockNameOf(symbol: string): Promise<string> {
    const { rows } = await pool.query('SELECT name FROM stocks WHERE symbol=$1', [symbol]);
    return rows[0]?.name ?? symbol;
}