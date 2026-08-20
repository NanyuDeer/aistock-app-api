import { eastmoneyThrottler } from '../../shared/utils/throttlers';
import { sessionFetch } from '../../shared/utils/httpAgent';

export class EmTagLeaderService {
    private static readonly BASE_URL = 'https://push2.eastmoney.com/api/qt/clist/get';
    /**
     * D5（2026-08-17 数据源裁决）：UT token 配置化——优先读环境变量 EASTMONEY_UT，
     * 缺失时回退内置默认值并打 warning（防整服务宕机；token 失效仅改配置不动代码）。
     * push2 为无文档网页接口，ut 参数可能被东财轮换，配置化便于免发版刷新。
     */
    private static readonly UT: string = (() => {
        const fromEnv = process.env.EASTMONEY_UT;
        if (fromEnv && fromEnv.trim()) return fromEnv.trim();
        console.warn('[EmTagLeader] EASTMONEY_UT 未配置，使用内置默认 UT token（建议配置环境变量以便失效时免改代码刷新）');
        return '8dec03ba335b81bf4ebdf7b29ec27d15';
    })();

    private static toNumberOrNull(value: unknown): number | null {
        if (typeof value !== 'number') return null;
        return Number.isFinite(value) ? value : null;
    }

    static async getTagLeaders(tagCode: string, count: number): Promise<Record<string, any>[]> {
        const normalizedTagCode = tagCode.toUpperCase();
        const url = new URL(this.BASE_URL);
        url.searchParams.set('pn', '1');
        url.searchParams.set('pz', String(count));
        url.searchParams.set('np', '1');
        url.searchParams.set('fltt', '2');
        url.searchParams.set('invt', '2');
        url.searchParams.set('fid', 'f62');
        url.searchParams.set('po', '1');
        url.searchParams.set('ut', this.UT);
        url.searchParams.set('fs', `b:${normalizedTagCode}`);
        url.searchParams.set('fields', 'f12,f14,f2,f3,f62');

        await eastmoneyThrottler.throttle();

        const response = await sessionFetch(url.toString(), {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Referer': 'https://quote.eastmoney.com/',
            },
        });

        if (!response.ok) throw new Error(`东方财富板块龙头接口请求失败: ${response.status}`);

        const json: any = await response.json();
        const list = json?.data?.diff;
        if (!Array.isArray(list)) return [];

        return list
            .map((item: any) => ({
                '股票代码': typeof item?.f12 === 'string' ? item.f12 : String(item?.f12 ?? ''),
                '股票名称': typeof item?.f14 === 'string' ? item.f14 : '',
                '最新价': this.toNumberOrNull(item?.f2),
                '涨跌幅': this.toNumberOrNull(item?.f3),
                '主力净流入': this.toNumberOrNull(item?.f62),
            }))
            .filter((item) => item['股票代码'] !== '');
    }
}
