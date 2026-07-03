import { getStockIdentity } from '../../shared/utils/stock';
import { tushareRequest, getDailyBasic } from '../quote/TushareService';
import { createThrottler } from '../../shared/utils/throttle';

const tushareInfoThrottler = createThrottler(150);

function toTsCode(symbol: string): string {
    const identity = getStockIdentity(symbol);
    return `${symbol}.${identity.market.toUpperCase()}`;
}

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

export class TushareInfoService {
    static async getStockInfo(symbol: string): Promise<Record<string, any>> {
        const identity = getStockIdentity(symbol);
        const tsCode = toTsCode(symbol);

        await tushareInfoThrottler.throttle();
        const basicRows = await tushareRequest('stock_basic', {
            ts_code: tsCode,
            fields: 'ts_code,symbol,name,area,industry,market,list_date',
        });

        if (basicRows.length === 0) throw new Error(`Tushare接口未找到股票: ${symbol}`);

        const stockBasic = basicRows[0];
        const tradeDate = getRecentTradeDate();

        let dailyBasic: Record<string, any> | null = null;
        try {
            const basicData = await getDailyBasic(symbol, tradeDate);
            dailyBasic = basicData.length > 0 ? basicData[0] : null;
        } catch {}

        const result: Record<string, any> = {
            '市场代码': identity.market.toUpperCase(),
            '股票代码': symbol,
            '股票简称': stockBasic.name || '',
            '所属行业': stockBasic.industry || '',
            '地域板块': stockBasic.area || '',
            '上市时间': stockBasic.list_date || '',
        };

        if (dailyBasic) {
            result['总股本'] = dailyBasic.total_share ? Math.round(dailyBasic.total_share * 10000) : null;
            result['流通股'] = dailyBasic.float_share ? Math.round(dailyBasic.float_share * 10000) : null;
            result['总市值'] = dailyBasic.total_mv ? Math.round(dailyBasic.total_mv * 10000) : null;
            result['流通市值'] = dailyBasic.circ_mv ? Math.round(dailyBasic.circ_mv * 10000) : null;
        }

        return result;
    }

    static async getBatchStockInfo(symbols: string[]): Promise<Record<string, any>[]> {
        const results = await Promise.all(symbols.map(async (symbol) => {
            try { return await this.getStockInfo(symbol); } catch (err) {
                console.error(`Error fetching info for ${symbol}:`, err);
                return { '市场代码': '-', '股票代码': symbol, '股票简称': '-', '错误': err instanceof Error ? err.message : '查询失败' };
            }
        }));
        return results;
    }
}
