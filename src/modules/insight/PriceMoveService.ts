// src/modules/insight/PriceMoveService.ts
// 午盘 11:30 / 尾盘 15:05 打点：腾讯实时行情 → move_bps → 阈值触发 → 快照入库
import pool from '../../core/db';
import { TencentQuoteService } from '../quote/TencentQuoteService';
import { TencentKlineService } from '../quote/TencentKlineService';
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService';
import { getWatchlistSymbols } from './InsightService';

const THRESHOLD_BPS = 700;

export interface PriceSnapshotRow {
    symbol: string;
    tradeDate: string;
    snapshotType: 'midday' | 'close';
    openPrice: number;
    latestPrice: number;
    moveBps: number;
    direction: 'up' | 'down';
    priceSource: 'realtime_snapshot' | 'kline_backfill';
}

/** move_bps = round((最新价 - 今开) / 今开 × 10000)；今开无效（停牌/新股）返回 null */
export function computeMoveBps(openPrice: number, latestPrice: number): number | null {
    if (!openPrice || openPrice <= 0) return null;
    return Math.round(((latestPrice - openPrice) / openPrice) * 10000);
}

function shanghaiDate(d: Date = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 腾讯行情行 → 取"最新价"与"今开"（字段名以 getBatchQuotes 返回为准，兼容中/英文键） */
function extractPrices(row: Record<string, any>): { latest: number | null; open: number | null } {
    const latest = Number(row['最新价'] ?? row.latest ?? NaN);
    const open = Number(row['今开'] ?? row.open ?? NaN);
    return { latest: Number.isFinite(latest) ? latest : null, open: Number.isFinite(open) ? open : null };
}

export class PriceMoveService {
    /**
     * 执行一轮打点：拉全自选股实时行情 → 计算 move_bps → 达到阈值者写快照并触发。
     * @param snapshotType midday=11:30 午盘 / close=15:05 尾盘
     */
    static async run(snapshotType: 'midday' | 'close'): Promise<{ scanned: number; triggered: number }> {
        const tradeDate = shanghaiDate();
        if (!TradingCalendarService.isTradingDay()) {
            console.log(`[PriceMove] 非交易日，跳过 ${snapshotType} 打点`);
            return { scanned: 0, triggered: 0 };
        }
        const symbols = [...(await getWatchlistSymbols())];
        if (symbols.length === 0) return { scanned: 0, triggered: 0 };
        const quotes = await TencentQuoteService.getCachedBatchQuotes(symbols, 'core');
        let triggered = 0;
        for (const row of quotes) {
            const symbol = String(row['股票代码'] ?? row.symbol ?? '');
            if (!symbol) continue;
            const { latest, open } = extractPrices(row);
            if (latest === null || open === null) continue;      // 无今开（停牌/新股）不触发
            const moveBps = computeMoveBps(open, latest);
            if (moveBps === null || Math.abs(moveBps) < THRESHOLD_BPS) continue;
            const direction: 'up' | 'down' = moveBps >= THRESHOLD_BPS ? 'up' : 'down';
            const snapshot: PriceSnapshotRow = {
                symbol, tradeDate, snapshotType, openPrice: open, latestPrice: latest,
                moveBps, direction, priceSource: 'realtime_snapshot',
            };
            await this.persistSnapshot(snapshot);
            await this.triggerEvent(snapshot);
            triggered++;
        }
        console.log(`[PriceMove] ${snapshotType} 打点完成 scanned=${symbols.length} triggered=${triggered}`);
        return { scanned: symbols.length, triggered };
    }

    /** 快照入库（幂等：同 symbol+trade_date+snapshot_type 冲突时更新） */
    static async persistSnapshot(s: PriceSnapshotRow): Promise<void> {
        await pool.query(
            `INSERT INTO watchlist_price_snapshots
               (symbol, trade_date, snapshot_type, snapshot_time, open_price, latest_price, move_bps, direction, price_source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (symbol, trade_date, snapshot_type) DO UPDATE SET
               latest_price=EXCLUDED.latest_price, move_bps=EXCLUDED.move_bps,
               direction=EXCLUDED.direction, price_source=EXCLUDED.price_source`,
            [s.symbol, s.tradeDate, s.snapshotType, new Date(), s.openPrice, s.latestPrice, s.moveBps, s.direction, s.priceSource],
        );
    }

    /** 触发事件：午盘创建（或尾盘反方向创建）/ 尾盘同方向更新 → 冻结证据包 → enqueue */
    static async triggerEvent(s: PriceSnapshotRow): Promise<void> {
        // @ts-expect-error - PriceEventService 由 Task 4 创建，动态导入保证运行时可用
        const { createOrUpdatePriceEvent } = await import('./PriceEventService');
        const eventId = await createOrUpdatePriceEvent(s);
        if (!eventId) return;
        const { freezeEvidencePackage } = await import('./EvidencePackageService');
        const { enqueue } = await import('./InsightJobService');
        await freezeEvidencePackage(eventId, s);
        await enqueue(eventId);
    }

    /** 打点失败补偿：腾讯 K 线回溯（日 K 取当日收盘；klt=101 日线、limit=1 最近一根；返回字段为中文键） */
    static async backfillByKline(symbol: string, snapshotType: 'midday' | 'close'): Promise<PriceSnapshotRow | null> {
        const tradeDate = shanghaiDate();
        const rows = await TencentKlineService.getKLine({ symbol, klt: 101, fqt: 0, limit: 1 });
        const bar = rows[rows.length - 1];
        if (!bar) return null;
        const open = Number(bar['开盘价'] ?? NaN);
        const close = Number(bar['收盘价'] ?? NaN);
        if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0) return null;
        const moveBps = computeMoveBps(open, close);
        if (moveBps === null || Math.abs(moveBps) < THRESHOLD_BPS) return null;
        return {
            symbol, tradeDate, snapshotType, openPrice: open, latestPrice: close, moveBps,
            direction: moveBps >= THRESHOLD_BPS ? 'up' : 'down', priceSource: 'kline_backfill',
        };
    }
}