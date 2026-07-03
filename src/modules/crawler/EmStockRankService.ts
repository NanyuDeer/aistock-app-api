import { eastmoneyThrottler } from '../../shared/utils/throttlers';
import { sessionFetch } from '../../shared/utils/httpAgent';

interface RankItem {
    sc: string;
    rk: number;
}

export interface StockRankResult {
    当前排名: number;
    股票代码: string;
}

export class EmStockRankService {
    private static readonly RANK_URL = 'https://emappdata.eastmoney.com/stockrank/getAllCurrentList';

    static async getStockHotRank(): Promise<StockRankResult[]> {
        await eastmoneyThrottler.throttle();

        const response = await sessionFetch(this.RANK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                appId: 'appId01',
                globalId: '786e4c21-70dc-435a-93bb-38',
                marketType: '',
                pageNo: 1,
                pageSize: 100,
            }),
        });

        if (!response.ok) throw new Error(`人气榜接口请求失败: ${response.status}`);

        const json: any = await response.json();
        const data: RankItem[] = json.data;
        if (!Array.isArray(data) || data.length === 0) throw new Error('人气榜接口返回数据为空');

        return data.map(item => ({
            '当前排名': Number(item.rk),
            '股票代码': item.sc.replace(/^(SZ|SH|BJ)/i, ''),
        }));
    }
}
