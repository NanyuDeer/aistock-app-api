import { Request, Response, NextFunction } from 'express';
import { WindLeaderService } from '../monitor/WindLeaderService';

type PotentialPushRecord = {
    push_id?: string;
    push_batch_id?: string;
    push_date?: string;
    stock_code?: string;
    stock_name?: string;
    theme?: string;
    reason?: string;
    strategy_name?: string;
    score?: number | null;
    chain_position?: string;
    push_price?: number | null;
    latest_price?: number | null;
    latest_trade_date?: string;
    realtime_return_pct?: number | null;
    realtime_time?: string;
    return_pct?: number | null;
};

function toFiniteNumber(value: unknown): number | null {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

/**
 * 判断记录是否有真实的价格更新（非 latest_price=push_price 的假数据）
 * 只有价格真正更新过的记录才应参与收益率统计
 */
function hasRealPriceUpdate(record: PotentialPushRecord): boolean {
    // 有 realtime_time 说明价格更新流程跑过
    if (record.realtime_time) return true;
    // latest_price 与 push_price 不同，说明有真实价格变动
    const pushPrice = toFiniteNumber(record.push_price);
    const latestPrice = toFiniteNumber(record.latest_price);
    if (pushPrice !== null && latestPrice !== null && pushPrice !== latestPrice) return true;
    return false;
}

function withReturn(record: PotentialPushRecord): PotentialPushRecord {
    // 优先使用已更新的收益率（realtime_return_pct）
    const realtimeReturn = toFiniteNumber(record.realtime_return_pct);
    if (realtimeReturn !== null) {
        return {
            ...record,
            return_pct: Number(realtimeReturn.toFixed(2)),
        };
    }

    // 价格未更新的记录，收益率置为 null 而非假0
    if (!hasRealPriceUpdate(record)) {
        return { ...record, return_pct: null };
    }

    // 重新计算收益率
    const pushPrice = toFiniteNumber(record.push_price);
    const latestPrice = toFiniteNumber(record.latest_price);
    const returnPct = pushPrice && pushPrice > 0 && latestPrice !== null
        ? Number((((latestPrice - pushPrice) / pushPrice) * 100).toFixed(2))
        : null;

    return {
        ...record,
        return_pct: returnPct,
    };
}

function buildSummary(records: PotentialPushRecord[]) {
    // 只有 return_pct 非 null 且非 undefined 的记录才参与统计
    const recordsWithReturn = records.filter(item => item.return_pct !== null && item.return_pct !== undefined);
    const total = records.length;
    const winners = recordsWithReturn.filter(item => Number(item.return_pct) > 0).length;
    const losers = recordsWithReturn.filter(item => Number(item.return_pct) < 0).length;
    const averageReturn = recordsWithReturn.length
        ? recordsWithReturn.reduce((sum, item) => sum + Number(item.return_pct), 0) / recordsWithReturn.length
        : 0;
    const sorted = recordsWithReturn.slice().sort((a, b) => Number(b.return_pct) - Number(a.return_pct));

    return {
        total,
        winners,
        losers,
        evaluated: recordsWithReturn.length,
        win_rate: recordsWithReturn.length ? Number(((winners / recordsWithReturn.length) * 100).toFixed(2)) : 0,
        average_return_pct: Number(averageReturn.toFixed(2)),
        best: sorted[0] || null,
    };
}

function getHistoryRecords(): PotentialPushRecord[] {
    return WindLeaderService.getPotentialPushHistory().map(withReturn);
}

function filterRecords(
    records: PotentialPushRecord[],
    filters: { date?: unknown; theme?: unknown; keyword?: unknown },
): PotentialPushRecord[] {
    const date = String(filters.date || '').trim();
    const theme = String(filters.theme || '').trim();
    const keyword = String(filters.keyword || '').trim();

    // 当天的推送记录，在腾讯行情更新前（17:30）不显示
    const today = new Date().toISOString().split('T')[0];

    return records
        .filter(item => {
            // 当天推送但价格尚未更新的记录，暂不显示
            if (item.push_date === today && !item.realtime_time) return false;
            return true;
        })
        .filter(item => !date || item.push_date === date)
        .filter(item => !theme || item.theme === theme)
        .filter(item => {
            if (!keyword) return true;
            return String(item.stock_code || '').includes(keyword)
                || String(item.stock_name || '').includes(keyword)
                || String(item.theme || '').includes(keyword);
        });
}

function sortRecords(records: PotentialPushRecord[]): PotentialPushRecord[] {
    return records.slice().sort((a, b) => {
        return Number(b.return_pct ?? -Infinity) - Number(a.return_pct ?? -Infinity);
    });
}

export class PotentialStockPushController {
    static async getHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const filtered = sortRecords(filterRecords(getHistoryRecords(), req.query));

            res.json({
                code: 200,
                message: 'success',
                data: {
                    items: filtered,
                    summary: buildSummary(filtered),
                },
            });
        } catch (err) {
            next(err);
        }
    }

    static async getRanking(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const items = filterRecords(getHistoryRecords(), { date: req.query.date });
            const itemsWithReturn = items.filter(item => toFiniteNumber(item.return_pct) !== null);
            const topGainers = itemsWithReturn.slice().sort((a, b) => Number(b.return_pct) - Number(a.return_pct)).slice(0, 10);
            const topLosers = itemsWithReturn.slice().sort((a, b) => Number(a.return_pct) - Number(b.return_pct)).slice(0, 10);

            res.json({
                code: 200,
                message: 'success',
                data: {
                    summary: buildSummary(items),
                    top_gainers: topGainers,
                    top_losers: topLosers,
                    batches: Array.from(new Set(items.map(item => item.push_batch_id).filter(Boolean))).sort().reverse(),
                },
            });
        } catch (err) {
            next(err);
        }
    }
}
