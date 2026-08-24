// src/modules/insight/PriceMoveService.ts
// 午盘 11:30 / 尾盘 15:05 打点：腾讯实时行情 → 相对昨收涨跌幅 → 阈值触发 → 快照入库
// 2026-08-20 口径统一：触发判定从"相对今开 moveBps"改为"相对昨收涨跌幅"（与实时检测链一致），
// move_bps 仍计算并入库作为辅助展示字段（区分开盘异动/盘中异动）。
import pool from '../../core/db';
import { TencentQuoteService } from '../quote/TencentQuoteService';
import { TencentKlineService } from '../quote/TencentKlineService';
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService';
import { getWatchlistSymbols } from './InsightService';
import { isEligiblePriceSecurity } from '../stock-trace/types';

/** 触发阈值：相对昨收涨跌幅 ≥ 7%（与 PriceTriggerDetector 一致，百分比口径） */
const THRESHOLD_PCT = 7;

export interface PriceSnapshotRow {
    symbol: string;
    tradeDate: string;
    snapshotType: 'midday' | 'close';
    openPrice: number;
    latestPrice: number;
    /** 相对昨收涨跌幅（百分比，主判定口径） */
    changePct: number;
    /** 相对今开 bps（辅助展示：区分开盘异动/盘中异动） */
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

/** 腾讯行情行 → 取"最新价/今开价/昨收价/涨跌幅"（键名以 TencentQuoteService 解析输出为准；兼容中/英文键）
 *  注意：今开字段键是"今开价"（FIELD_INDEX '今开价':5），昨收键是"昨收价"（index 4），
 *  涨跌幅键是"涨跌幅"（index 32），活动级(activity)字段集才包含它们。 */
export function extractPrices(row: Record<string, any>): {
    latest: number | null;
    open: number | null;
    prevClose: number | null;
    changePct: number | null;
} {
    const latest = Number(row['最新价'] ?? row.latest ?? NaN);
    const open = Number(row['今开价'] ?? row['今开'] ?? row.open ?? NaN);
    const prevClose = Number(row['昨收价'] ?? row['昨收'] ?? row.prevClose ?? NaN);
    const changePct = Number(row['涨跌幅'] ?? row.changePct ?? NaN);
    return {
        latest: Number.isFinite(latest) ? latest : null,
        open: Number.isFinite(open) ? open : null,
        prevClose: Number.isFinite(prevClose) ? prevClose : null,
        changePct: Number.isFinite(changePct) ? changePct : null,
    };
}

export class PriceMoveService {
    /**
     * 执行一轮打点：拉全自选股实时行情 → 相对昨收涨跌幅 → 达到阈值者写快照并触发。
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
        // 必须用 activity 级别：涨跌幅/今开价/昨收价仅在该字段集返回，core 只有代码/名称/最新价/涨跌幅，
        // 缺字段会导致触发判定无法计算（2026-08-15/08-20 实测定位）
        const quotes = await TencentQuoteService.getCachedBatchQuotes(symbols, 'activity');
        const { StockTraceService } = await import('../stock-trace/StockTraceService');
        const securities = await StockTraceService.getFavoriteSecurities();
        let triggered = 0;
        for (const row of quotes) {
            const symbol = String(row['股票代码'] ?? row.symbol ?? '');
            if (!symbol) continue;
            const { latest, open, prevClose, changePct } = extractPrices(row);
            // 主判定：相对昨收涨跌幅；昨收/涨跌幅缺失（停牌/新股/数据异常）不触发
            if (latest === null || prevClose === null || prevClose <= 0 || changePct === null) continue;
            if (Math.abs(changePct) < THRESHOLD_PCT) continue;
            const direction: 'up' | 'down' = changePct >= THRESHOLD_PCT ? 'up' : 'down';
            const moveBps = open !== null ? computeMoveBps(open, latest) : null;
            const snapshot: PriceSnapshotRow = {
                symbol, tradeDate, snapshotType, openPrice: open ?? prevClose, latestPrice: latest,
                changePct, moveBps: moveBps ?? 0, direction, priceSource: 'realtime_snapshot',
            };
            // --- 事件层切换：stocktrace 接管 ---
            const security = securities.find((s) => s.symbol === symbol);
            if (security && isEligiblePriceSecurity(security, new Date())) {
                await StockTraceService.processPriceFact(security, {
                    symbol,
                    stockName: security.stockName,
                    latestPrice: latest,
                    previousClose: prevClose,          // 相对昨收口径：以昨收为基准
                    changePct,                          // 相对昨收涨跌幅（百分比）
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
               (symbol, trade_date, snapshot_type, snapshot_time, open_price, latest_price, change_pct, move_bps, direction, price_source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (symbol, trade_date, snapshot_type) DO UPDATE SET
               latest_price=EXCLUDED.latest_price, change_pct=EXCLUDED.change_pct,
               move_bps=EXCLUDED.move_bps,
               direction=EXCLUDED.direction, price_source=EXCLUDED.price_source`,
            [s.symbol, s.tradeDate, s.snapshotType, new Date(), s.openPrice, s.latestPrice, s.changePct, s.moveBps, s.direction, s.priceSource],
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

    /** 打点失败补偿：腾讯 K 线回溯（日 K 取最近两根，前一根收盘作昨收；klt=101 日线；返回字段为中文键） */
    static async backfillByKline(symbol: string, snapshotType: 'midday' | 'close'): Promise<PriceSnapshotRow | null> {
        const tradeDate = shanghaiDate();
        const rows = await TencentKlineService.getKLine({ symbol, klt: 101, fqt: 0, limit: 2 });
        const bar = rows[rows.length - 1];
        const prevBar = rows[rows.length - 2];
        if (!bar) return null;
        const close = Number(bar['收盘价'] ?? NaN);
        const open = Number(bar['开盘价'] ?? NaN);
        // 相对昨收口径：前一根日 K 收盘价作为昨收；拿不到昨收（新股/数据不足）不触发
        const prevClose = prevBar ? Number(prevBar['收盘价'] ?? NaN) : NaN;
        if (!Number.isFinite(close) || !Number.isFinite(prevClose) || prevClose <= 0) return null;
        const changePct = Math.round(((close - prevClose) / prevClose) * 10000) / 100;
        if (Math.abs(changePct) < THRESHOLD_PCT) return null;
        const moveBps = Number.isFinite(open) && open > 0 ? computeMoveBps(open, close) : null;
        return {
            symbol, tradeDate, snapshotType, openPrice: Number.isFinite(open) ? open : prevClose,
            latestPrice: close, changePct, moveBps: moveBps ?? 0,
            direction: changePct >= THRESHOLD_PCT ? 'up' : 'down', priceSource: 'kline_backfill',
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