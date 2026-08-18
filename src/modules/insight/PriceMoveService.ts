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

/** 腾讯行情行 → 取"最新价"与"今开价"（键名以 TencentQuoteService 解析输出为准；兼容中/英文键）
 *  注意：今开字段键是"今开价"（FIELD_INDEX '今开价':5），活动级(activity)字段集才包含它。 */
export function extractPrices(row: Record<string, any>): { latest: number | null; open: number | null } {
    const latest = Number(row['最新价'] ?? row.latest ?? NaN);
    const open = Number(row['今开价'] ?? row['今开'] ?? row.open ?? NaN);
    return { latest: Number.isFinite(latest) ? latest : null, open: Number.isFinite(open) ? open : null };
}

/** 相对今开 moveBps 转 changePct（stocktrace PriceFact 使用：bps / 100 = 百分比值）
 * 如 moveBps=750 表示 7.5%，返回 changePct=7.5 */
export function moveBpsToChangePct(moveBps: number): number {
    return moveBps / 100;
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
        // 必须用 activity 级别：今开价仅在该字段集返回，core 只有代码/名称/最新价/涨跌幅，
        // 缺今开会令 computeMoveBps 恒返回 null，异动永不触发（2026-08-15 实测定位）
        const quotes = await TencentQuoteService.getCachedBatchQuotes(symbols, 'activity');
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
            // --- 事件层切换：stocktrace 接管 ---
            const { StockTraceService } = await import('../stock-trace/StockTraceService');
            const securities = await StockTraceService.getFavoriteSecurities();
            const security = securities.find((s) => s.symbol === symbol);
            if (security) {
                await StockTraceService.processPriceFact(security, {
                    symbol,
                    stockName: security.stockName,
                    latestPrice: latest,
                    previousClose: open,          // 保留相对今开语义：以今开为基准
                    changePct: moveBpsToChangePct(moveBps),
                    observedAt: new Date(),
                });
                triggered++;
            }
            // persistSnapshot 保留仅作记录（同 symbol+trade_date+snapshot_type 幂等更新）
            await this.persistSnapshot(snapshot);
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

    /** 午盘触发后 20 分钟补抓：对当日午盘已触发事件重新冻结证据包（frozen_seq++）并重新入队 */
    static async refetchMiddayEvidence(): Promise<{ events: number }> {
        const tradeDate = shanghaiDate();
        const { rows } = await pool.query<{ event_id: string; symbol: string; trade_date: string; direction: string }>(
            `SELECT event_id, symbol, trade_date, direction FROM watchlist_insight_events
             WHERE trade_date=$1 AND event_type='midday_price_move' AND status='active'`,
            [tradeDate]);
        for (const r of rows) {
            try {
                const { freezeEvidencePackage } = await import('./EvidencePackageService');
                const { enqueue } = await import('./InsightJobService');
                const direction: 'up' | 'down' = r.direction === 'down' ? 'down' : 'up';
                await freezeEvidencePackage(r.event_id, {
                    symbol: r.symbol, tradeDate: r.trade_date, direction,
                });
                // force：同 (event_id, version) 的 job 已存在（午盘已入队），必须强制重入队
                // 产生新 stream 消息，Python 才会重新归因并 UPSERT 覆盖旧结果
                await enqueue(r.event_id, { force: true });
            } catch (e) {
                console.warn('[PriceMove] refetch failed', r.event_id,
                    e instanceof Error ? e.message : String(e));
            }
        }
        return { events: rows.length };
    }
}