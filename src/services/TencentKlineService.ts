import { getStockIdentity } from '../utils/stock';
import { eastmoneyThrottler } from '../utils/throttlers';
import { sessionFetch } from '../utils/httpAgent';

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

/** 腾讯K线周期映射 */
const PERIOD_MAP: Record<number, string> = {
    1: 'm1',      // 1分钟
    5: 'm5',      // 5分钟
    15: 'm15',    // 15分钟
    30: 'm30',    // 30分钟
    60: 'm60',    // 60分钟
    101: 'day',   // 日K
    102: 'week',  // 周K
    103: 'month', // 月K
};

/** 腾讯复权类型映射: 0=不复权, 1=前复权, 2=后复权 */
const FQT_MAP: Record<number, string> = {
    0: '',     // 不复权
    1: 'qfq',  // 前复权
    2: 'hfq',  // 后复权
};

export class TencentKlineService {
    private static readonly BASE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
    private static readonly MAX_RETRIES = 3;
    private static readonly RETRY_BASE_DELAY_MS = 300;

    private static async sleep(ms: number): Promise<void> {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }

    /** 将日期字符串转为腾讯格式 YYYY-MM-DD */
    private static formatDate(dateStr: string): string {
        if (!dateStr) return '';
        // 兼容多种格式: 20250601 / 2025-06-01 / 20500101
        const compact = dateStr.replace(/[-/]/g, '');
        if (compact.length === 8) {
            return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
        }
        return dateStr;
    }

    private static buildKlineUrl(options: KLineOptions): URL {
        const { symbol, klt = 101, fqt = 1, limit = 1000, startDate, endDate } = options;
        const identity = getStockIdentity(symbol);
        const code = `${identity.tencentPrefix}${symbol}`;
        const period = PERIOD_MAP[klt] || 'day';
        const fqtType = FQT_MAP[fqt] ?? '';
        const start = startDate ? this.formatDate(startDate) : '';
        const end = endDate ? this.formatDate(endDate) : '';

        // param=代码,周期,开始日期,结束日期,数量,复权类型
        const param = [code, period, start, end, String(limit), fqtType].join(',');
        const url = new URL(this.BASE_URL);
        url.searchParams.set('param', param);
        return url;
    }

    private static async fetchKlineJson(url: URL): Promise<any> {
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
            await eastmoneyThrottler.throttle();
            try {
                const response = await sessionFetch(url.toString(), {
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                        'Referer': 'https://gu.qq.com/',
                    },
                });
                if (response.ok) {
                    const json: any = await response.json();
                    if (json.code === 0 && json.data) return json;
                    lastError = new Error(`腾讯K线接口返回异常: ${json.msg || 'unknown'}`);
                } else {
                    lastError = new Error(`腾讯K线接口请求失败: ${response.status}`);
                }
                if (attempt === this.MAX_RETRIES) throw lastError;
            } catch (err) {
                const wrapped = err instanceof Error ? err : new Error(String(err));
                lastError = wrapped;
                if (attempt === this.MAX_RETRIES) throw new Error(`${wrapped.message} (url=${url.toString()})`);
            }
            await this.sleep(this.RETRY_BASE_DELAY_MS * attempt);
        }
        throw new Error(`腾讯K线接口请求失败: 未知错误 (url=${url.toString()})`);
    }

    private static toNumber(value: string): number | null {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    private static parseKLineRow(row: string[]): Record<string, any> | null {
        if (!Array.isArray(row) || row.length < 6) return null;
        return {
            '时间': row[0],
            '开盘价': this.toNumber(row[1]),
            '收盘价': this.toNumber(row[2]),
            '最高价': this.toNumber(row[3]),
            '最低价': this.toNumber(row[4]),
            '成交量': this.toNumber(row[5]),
        };
    }

    static async getKLine(options: KLineOptions): Promise<Record<string, any>[]> {
        const url = this.buildKlineUrl(options);
        const json: any = await this.fetchKlineJson(url);

        const identity = getStockIdentity(options.symbol);
        const code = `${identity.tencentPrefix}${options.symbol}`;
        const stockData = json.data?.[code];
        if (!stockData) return [];

        // 前复权数据在 qfqday，不复权在 day
        const klineRows: unknown[] = stockData.qfqday || stockData.day || stockData.hfqday || [];
        if (!Array.isArray(klineRows)) return [];

        return klineRows
            .map((row: any) => Array.isArray(row) ? this.parseKLineRow(row) : null)
            .filter((item): item is Record<string, any> => item !== null);
    }
}
