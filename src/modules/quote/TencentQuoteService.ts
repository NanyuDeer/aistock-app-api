import { getStockIdentity } from '../../shared/utils/stock';
import { eastmoneyThrottler } from '../../shared/utils/throttlers';
import { CacheService } from '../../shared/utils/CacheService';
import {
    STOCK_QUOTE_CORE_CACHE_KEY_PREFIX,
    STOCK_QUOTE_CORE_TRADING_TTL_SECONDS,
    buildTimestampedCachePayload,
    isValidStockInfoCachePayload,
    type StockInfoCachePayload,
} from '../../shared/types/cache';
import { getAShareAdaptiveCacheTtlSeconds } from '../../shared/utils/tradingTime';
import { sessionFetch } from '../../shared/utils/httpAgent';

export type QuoteLevel = 'core' | 'activity' | 'fundamental';

/**
 * 腾讯行情接口字段索引映射
 * 返回格式: v_xxx="市场~名称~代码~当前价~昨收~今开~成交量(手)~外盘~内盘~买一价~买一量~...~涨跌额~涨跌幅~最高~最低~成交量(手)~成交额(万)~换手率~市盈率~...~振幅~流通市值~总市值~...~市净率~..."
 * 参考: https://qt.gtimg.cn/q=sh600519
 */
const FIELD_INDEX: Record<string, number> = {
    '股票代码': 2,
    '股票简称': 1,
    '最新价': 3,
    '昨收价': 4,
    '今开价': 5,
    '涨跌额': 31,
    '涨跌幅': 32,
    '最高价': 33,
    '最低价': 34,
    '成交量': 36,
    '成交额': 37,
    '换手率': 38,
    '市盈率': 39,
    '振幅': 43,
    '流通市值': 44,
    '总市值': 45,
    '市净率': 46,
};

const CORE_FIELDS = new Set(['股票代码', '股票简称', '最新价', '涨跌幅']);
const ACTIVITY_FIELDS = new Set([
    '股票代码', '股票简称', '最新价', '涨跌额', '涨跌幅', '成交量', '成交额',
    '换手率', '今开价', '最高价', '最低价', '昨收价', '振幅', '市盈率', '市净率',
]);
const FUNDAMENTAL_FIELDS = new Set([
    '股票代码', '股票简称', '最新价', '涨跌幅', '市盈率', '市净率',
    '总市值', '流通市值', '换手率', '振幅',
]);

const LEVEL_FIELDS: Record<QuoteLevel, Set<string>> = {
    'core': CORE_FIELDS,
    'activity': ACTIVITY_FIELDS,
    'fundamental': FUNDAMENTAL_FIELDS,
};

export class TencentQuoteService {
    private static readonly BASE_URL = 'https://qt.gtimg.cn/q=';

    private static readonly HEADERS: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://gu.qq.com/',
    };

    /** 解析腾讯行情接口返回的单只股票数据 */
    private static parseQuote(rawText: string, level: QuoteLevel): Record<string, any> {
        // 格式: v_sh600519="1~贵州茅台~600519~685.00~...";
        const eqIndex = rawText.indexOf('="');
        if (eqIndex === -1) return {};

        const content = rawText.substring(eqIndex + 2).replace(/";?\s*$/, '');
        if (!content) return {};

        const fields = content.split('~');
        if (fields.length < 47) return {};

        const allowedFields = LEVEL_FIELDS[level];
        const result: Record<string, any> = {};

        for (const [name, index] of Object.entries(FIELD_INDEX)) {
            if (!allowedFields.has(name)) continue;
            if (index >= fields.length) continue;

            let value: string | number = fields[index];
            if (!value || value === '-') continue;

            // 数值字段转换
            if (['最新价', '昨收价', '今开价', '涨跌额', '涨跌幅', '最高价', '最低价',
                '换手率', '市盈率', '振幅', '市净率'].includes(name)) {
                value = parseFloat(value as string);
                if (isNaN(value)) continue;
            } else if (['成交量', '成交额', '流通市值', '总市值'].includes(name)) {
                value = parseFloat(value as string);
                if (isNaN(value)) continue;
                // 成交量单位是手，转为股（×100）
                if (name === '成交量') value = value * 100;
                // 成交额单位是万，转为元（×10000）
                if (name === '成交额') value = value * 10000;
                // 流通市值、总市值单位是亿，转为元（×100000000）
                if (name === '流通市值' || name === '总市值') value = value * 100000000;
            }

            result[name] = value;
        }

        return result;
    }

    static async getQuote(symbol: string, level: QuoteLevel = 'core'): Promise<Record<string, any>> {
        const identity = getStockIdentity(symbol);
        const { tencentPrefix } = identity;
        const code = `${tencentPrefix}${symbol}`;
        const url = `${this.BASE_URL}${code}`;

        await eastmoneyThrottler.throttle();

        const response = await sessionFetch(url, {
            method: 'GET',
            headers: this.HEADERS,
        });

        if (!response.ok) throw new Error(`腾讯行情接口请求失败: ${response.status}`);

        // 腾讯接口返回GBK编码
        const buffer = await response.arrayBuffer();
        const text = new TextDecoder('gbk').decode(buffer);

        const result = this.parseQuote(text, level);
        if (Object.keys(result).length === 0) {
            throw new Error('腾讯行情接口返回数据格式异常');
        }

        return result;
    }

    static async getBatchQuotes(symbols: string[], level: QuoteLevel = 'core'): Promise<Record<string, any>[]> {
        // 腾讯接口支持批量查询，用逗号分隔
        const codes = symbols.map(symbol => {
            const identity = getStockIdentity(symbol);
            return `${identity.tencentPrefix}${symbol}`;
        });

        // 每次最多查询约50只，超出则分批
        const BATCH_SIZE = 50;
        const allResults: Record<string, any>[] = [];

        for (let i = 0; i < codes.length; i += BATCH_SIZE) {
            const batchCodes = codes.slice(i, i + BATCH_SIZE);
            const batchSymbols = symbols.slice(i, i + BATCH_SIZE);
            const url = `${this.BASE_URL}${batchCodes.join(',')}`;

            await eastmoneyThrottler.throttle();

            try {
                const response = await sessionFetch(url, {
                    method: 'GET',
                    headers: this.HEADERS,
                });

                if (!response.ok) {
                    for (const sym of batchSymbols) {
                        allResults.push({ '股票代码': sym, '错误': `腾讯行情接口请求失败: ${response.status}` });
                    }
                    continue;
                }

                const buffer = await response.arrayBuffer();
                const text = new TextDecoder('gbk').decode(buffer);

                // 按分号分割多只股票的数据
                const lines = text.split(';').filter(line => line.trim().includes('="'));
                const lineMap = new Map<string, string>();

                for (const line of lines) {
                    // 提取股票代码: v_sh600519="..." → sh600519
                    const match = line.match(/v_([a-z]+\d+)=/);
                    if (match) {
                        lineMap.set(match[1], line);
                    }
                }

                for (let j = 0; j < batchSymbols.length; j++) {
                    const sym = batchSymbols[j];
                    const code = batchCodes[j];
                    const lineText = lineMap.get(code);

                    if (lineText) {
                        const parsed = this.parseQuote(lineText, level);
                        if (Object.keys(parsed).length > 0) {
                            allResults.push(parsed);
                        } else {
                            allResults.push({ '股票代码': sym, '错误': '数据解析失败' });
                        }
                    } else {
                        allResults.push({ '股票代码': sym, '错误': '未获取到行情数据' });
                    }
                }
            } catch (err) {
                for (const sym of batchSymbols) {
                    allResults.push({ '股票代码': sym, '错误': (err instanceof Error ? err.message : '查询失败') });
                }
            }
        }

        return allResults;
    }

    /** 带缓存的行情获取（先查缓存，未命中再从接口获取并写入缓存） */
    static async getCachedQuote(symbol: string, level: QuoteLevel = 'core'): Promise<Record<string, any>> {
        const cacheKey = `${STOCK_QUOTE_CORE_CACHE_KEY_PREFIX}${symbol}`;
        try {
            const cached = await CacheService.get<StockInfoCachePayload>(cacheKey);
            if (isValidStockInfoCachePayload(cached) && cached.data['涨跌幅'] !== undefined) {
                return cached.data;
            }
        } catch { /* cache miss */ }

        const quote = await this.getQuote(symbol, level);

        try {
            const ttl = await getAShareAdaptiveCacheTtlSeconds(STOCK_QUOTE_CORE_TRADING_TTL_SECONDS);
            await CacheService.set(cacheKey, buildTimestampedCachePayload(quote), ttl);
        } catch { /* cache write fail */ }

        return quote;
    }

    /** 带缓存的批量行情获取 */
    static async getCachedBatchQuotes(symbols: string[], level: QuoteLevel = 'core'): Promise<Record<string, any>[]> {
        const results: Record<string, any>[] = [];
        const missedSymbols: string[] = [];
        const missedIndices: number[] = [];

        // 先批量查缓存
        for (let i = 0; i < symbols.length; i++) {
            const cacheKey = `${STOCK_QUOTE_CORE_CACHE_KEY_PREFIX}${symbols[i]}`;
            try {
                const cached = await CacheService.get<StockInfoCachePayload>(cacheKey);
                if (isValidStockInfoCachePayload(cached) && cached.data['涨跌幅'] !== undefined) {
                    results[i] = cached.data;
                    continue;
                }
            } catch { /* cache miss */ }
            missedSymbols.push(symbols[i]);
            missedIndices.push(i);
        }

        if (missedSymbols.length > 0) {
            const fetched = await this.getBatchQuotes(missedSymbols, level);
            const ttl = await getAShareAdaptiveCacheTtlSeconds(STOCK_QUOTE_CORE_TRADING_TTL_SECONDS);

            for (let j = 0; j < fetched.length; j++) {
                const quote = fetched[j];
                const idx = missedIndices[j];
                results[idx] = quote;

                if (!('错误' in quote)) {
                    const cacheKey = `${STOCK_QUOTE_CORE_CACHE_KEY_PREFIX}${missedSymbols[j]}`;
                    CacheService.set(cacheKey, buildTimestampedCachePayload(quote), ttl).catch(() => {});
                }
            }
        }

        return results;
    }
}
