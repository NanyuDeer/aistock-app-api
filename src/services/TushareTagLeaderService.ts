import { tushareRequest, getIndexMember } from './TushareService';
import { createThrottler } from '../utils/throttle';

const tushareTagThrottler = createThrottler(150);

function getRecentTradeDate(): string {
    const now = new Date();
    const hour = now.getHours();
    if (hour < 15) {
        now.setDate(now.getDate() - 1);
    }
    for (let i = 0; i < 7; i++) {
        const day = now.getDay();
        if (day !== 0 && day !== 6) {
            const pad = (n: number) => n.toString().padStart(2, '0');
            return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
        }
        now.setDate(now.getDate() - 1);
    }
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function toNumberOrNull(value: unknown): number | null {
    if (typeof value !== 'number') return null;
    return Number.isFinite(value) ? value : null;
}

export class TushareTagLeaderService {
    static async getTagLeaders(tagCode: string, count: number): Promise<Record<string, any>[]> {
        const members = await getIndexMember(tagCode);
        if (members.length === 0) return [];

        const tradeDate = getRecentTradeDate();

        await tushareTagThrottler.throttle();

        const dailyRows = await tushareRequest('daily', {
            trade_date: tradeDate,
            fields: 'ts_code,trade_date,close,pct_chg,amount,vol',
        });

        const dailyMap = new Map<string, Record<string, any>>();
        for (const row of dailyRows) {
            const symbol = String(row.ts_code || '').split('.')[0];
            dailyMap.set(symbol, row);
        }

        const results: Record<string, any>[] = [];
        for (const symbol of members) {
            const daily = dailyMap.get(symbol);
            if (!daily) continue;

            results.push({
                '股票代码': symbol,
                '股票名称': '',
                '最新价': toNumberOrNull(daily.close),
                '涨跌幅': toNumberOrNull(daily.pct_chg),
                '主力净流入': toNumberOrNull(daily.amount) ? Number(daily.amount) * 1000 : null,
            });
        }

        results.sort((a, b) => {
            const flowA = a['主力净流入'] ?? 0;
            const flowB = b['主力净流入'] ?? 0;
            return flowB - flowA;
        });

        return results.slice(0, count);
    }
}
