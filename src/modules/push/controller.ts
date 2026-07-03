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
    return_pct?: number | null;
};

function toFiniteNumber(value: unknown): number | null {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function withReturn(record: PotentialPushRecord): PotentialPushRecord {
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
    const recordsWithReturn = records.filter(item => toFiniteNumber(item.return_pct) !== null);
    const total = records.length;
    const winners = recordsWithReturn.filter(item => Number(item.return_pct) > 0).length;
    const averageReturn = recordsWithReturn.length
        ? recordsWithReturn.reduce((sum, item) => sum + Number(item.return_pct), 0) / recordsWithReturn.length
        : 0;
    const sorted = recordsWithReturn.slice().sort((a, b) => Number(b.return_pct) - Number(a.return_pct));

    return {
        total,
        winners,
        win_rate: recordsWithReturn.length ? Number(((winners / recordsWithReturn.length) * 100).toFixed(2)) : 0,
        average_return_pct: Number(averageReturn.toFixed(2)),
        best: sorted[0] || null,
        worst: sorted.slice().reverse()[0] || null,
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

    return records
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
        if (a.push_date !== b.push_date) {
            return String(b.push_date || '').localeCompare(String(a.push_date || ''));
        }
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
