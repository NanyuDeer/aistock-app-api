import { getStockIdentity } from '../../shared/utils/stock';
import { tushareRequest } from './TushareService';
import { createThrottler } from '../../shared/utils/throttle';

const tushareKlineThrottler = createThrottler(150);

export type KLinePeriod = 1 | 5 | 15 | 30 | 60 | 101 | 102 | 103;
export type KLineFqt = 0 | 1 | 2;

export interface KLineOptions {
    symbol: string;
    klt?: KLinePeriod;
    fqt?: KLineFqt;
    limit?: number;
    startDate?: string;
    endDate?: string;
}

function toTsCode(symbol: string): string {
    const identity = getStockIdentity(symbol);
    return `${symbol}.${identity.market.toUpperCase()}`;
}

function getApiName(klt: KLinePeriod): string {
    if (klt === 101) return 'daily';
    if (klt === 102) return 'weekly';
    if (klt === 103) return 'monthly';
    return 'min_data';
}

function getPeriodParam(klt: KLinePeriod): string {
    if (klt === 1) return '1min';
    if (klt === 5) return '5min';
    if (klt === 15) return '15min';
    if (klt === 30) return '30min';
    if (klt === 60) return '60min';
    return 'daily';
}

function toNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

export class TushareKlineService {
    static async getKLine(options: KLineOptions): Promise<Record<string, any>[]> {
        const { symbol, klt = 101, fqt = 1, limit = 120, startDate, endDate } = options;
        const tsCode = toTsCode(symbol);
        const apiName = getApiName(klt);

        await tushareKlineThrottler.throttle();

        let rows: Record<string, any>[];

        if (klt < 100) {
            const params: Record<string, any> = {
                ts_code: tsCode,
                freq: getPeriodParam(klt),
            };
            if (startDate) params.start_date = startDate;
            if (endDate) params.end_date = endDate;
            rows = await tushareRequest(apiName, params);
        } else {
            const params: Record<string, any> = { ts_code: tsCode };
            if (startDate) params.start_date = startDate;
            if (endDate) params.end_date = endDate;
            rows = await tushareRequest(apiName, params);
        }

        if (!rows || rows.length === 0) return [];

        const sorted = rows.sort((a, b) => {
            const dateA = String(a.trade_date || '');
            const dateB = String(b.trade_date || '');
            return dateA.localeCompare(dateB);
        });

        const sliced = limit > 0 ? sorted.slice(-limit) : sorted;

        return sliced.map(row => {
            const close = toNumber(row.close) ?? 0;
            const preClose = toNumber(row.pre_close) ?? 0;
            const high = toNumber(row.high) ?? 0;
            const low = toNumber(row.low) ?? 0;
            const vol = toNumber(row.vol) ?? 0;
            const amount = toNumber(row.amount) ?? 0;
            const pctChg = toNumber(row.pct_chg) ?? (preClose > 0 ? ((close - preClose) / preClose) * 100 : 0);
            const change = close - preClose;

            return {
                '时间': String(row.trade_date || ''),
                '开盘价': toNumber(row.open),
                '收盘价': close,
                '最高价': high,
                '最低价': low,
                '成交量': vol * 100,
                '成交额': amount * 1000,
                '振幅': preClose > 0 ? Math.round(((high - low) / preClose) * 10000) / 100 : 0,
                '涨跌幅': Math.round(pctChg * 100) / 100,
                '涨跌额': Math.round(change * 100) / 100,
                '换手率': toNumber(row.turnover) ?? 0,
            };
        });
    }
}
