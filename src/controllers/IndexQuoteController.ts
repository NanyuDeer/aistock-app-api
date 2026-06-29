import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../utils/response';
import { isValidAShareSymbol, isValidGlobalIndexSymbol } from '../utils/validator';
import { CacheService } from '../services/CacheService';
import { sessionFetch } from '../utils/httpAgent';
import {
    INDEX_QUOTE_CACHE_KEY_PREFIX,
    buildTimestampedCachePayload,
    isValidStockInfoCachePayload,
    type StockInfoCachePayload,
} from '../constants/cache';
import { getAShareIndexCacheTtlSeconds } from '../utils/tradingTime';

const MAX_SYMBOLS = 20;

const CN_INDEX_NAMES: Record<string, string> = {
    '000001': '上证指数',
    '000002': '上证A指',
    '000003': '上证B指',
    '399001': '深证成指',
    '399002': '深成指A',
    '399003': '深成指B',
    '399004': '深证100',
    '399005': '中小100',
    '399006': '创业板指',
    '399007': '深证300',
    '399008': '中小300',
    '399100': '深证新指数',
    '399106': '深证综指',
    '399107': '深证A指',
    '399108': '深证B指',
    '399300': '沪深300',
    '399550': '央视50',
    '399673': '创业板50',
    '399678': '深证200',
    '399971': '中证传媒',
};

const CN_INDEX_TENCENT_PREFIX: Record<string, string> = {
    '000001': 'sh', '000002': 'sh', '000003': 'sh', '000004': 'sh', '000005': 'sh',
    '399001': 'sz', '399002': 'sz', '399003': 'sz', '399004': 'sz', '399005': 'sz',
    '399006': 'sz', '399007': 'sz', '399008': 'sz', '399009': 'sz', '399010': 'sz',
    '399011': 'sz', '399012': 'sz', '399013': 'sz', '399014': 'sz', '399015': 'sz',
    '399016': 'sz', '399100': 'sz', '399106': 'sz', '399107': 'sz', '399108': 'sz',
    '399300': 'sz', '399550': 'sz', '399673': 'sz', '399678': 'sz', '399971': 'sz',
};

const GB_INDEX_NAMES: Record<string, string> = {
    'HXC': '纳斯达克中国金龙指数',
    'HSTECH': '恒生科技指数',
    'HSI': '恒生指数',
    'HSCEI': '恒生国企指数',
    'DJI': '道琼斯工业指数',
    'SPX': '标普500',
    'IXIC': '纳斯达克综合指数',
    'N225': '日经225',
    'FTSE': '富时100',
    'GDAXI': '德国DAX',
    'FCHI': '法国CAC40',
};

const GB_INDEX_TENCENT_CODE: Record<string, string> = {
    'HXC': 'usHXC', 'DJI': 'usDJI', 'SPX': 'usSPX', 'IXIC': 'usIXIC',
    'HSTECH': 'hkHSTECH', 'HSI': 'hkHSI', 'HSCEI': 'hkHSCEI',
    'N225': 'jpN225', 'FTSE': 'ukFTSE', 'GDAXI': 'deGDAXI', 'FCHI': 'frFCHI',
};

const GB_TENCENT_RETURN_CODE_TO_SYMBOL: Record<string, string> = {
    '.HXC': 'HXC', 'HXC': 'HXC',
    'DJI': 'DJI', '.DJI': 'DJI',
    'SPX': 'SPX', '.SPX': 'SPX',
    'IXIC': 'IXIC', '.IXIC': 'IXIC',
    'HSTECH': 'HSTECH',
    'HSI': 'HSI',
    'HSCEI': 'HSCEI',
    'N225': 'N225', '.N225': 'N225',
    'FTSE': 'FTSE', '.FTSE': 'FTSE',
    'GDAXI': 'GDAXI', '.GDAXI': 'GDAXI',
    'FCHI': 'FCHI', '.FCHI': 'FCHI',
};

interface ParsedTencentIndex {
    code: string;
    value: number;
    change: number;
    changeAmount: number;
}

function parseTencentIndexLine(line: string): ParsedTencentIndex | null {
    const eqIdx = line.indexOf('="');
    if (eqIdx < 0) return null;
    const valuePart = line.substring(eqIdx + 2, line.length - 2);
    if (!valuePart) return null;
    const parts = valuePart.split('~');
    if (parts.length < 33) return null;

    const code = parts[2] || '';
    const value = parseFloat(parts[3]);
    const changeAmount = parseFloat(parts[31]);
    const change = parseFloat(parts[32]);

    if (!Number.isFinite(value)) return null;

    return {
        code,
        value,
        change: Number.isFinite(change) ? change : 0,
        changeAmount: Number.isFinite(changeAmount) ? changeAmount : 0,
    };
}

async function fetchTencentIndexQuotes(tencentCodes: string[]): Promise<Map<string, ParsedTencentIndex>> {
    const result = new Map<string, ParsedTencentIndex>();
    if (tencentCodes.length === 0) return result;

    try {
        const url = `https://qt.gtimg.cn/q=${tencentCodes.join(',')}`;
        const response = await sessionFetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(10000), // 10秒超时
        });
        if (!response.ok) return result;

        const buf = Buffer.from(await response.arrayBuffer());
        const text = new TextDecoder('gbk').decode(buf);
        const lines = text.split(';').filter(l => l.trim());

        for (const line of lines) {
            const parsed = parseTencentIndexLine(line);
            if (parsed) {
                result.set(parsed.code, parsed);
            }
        }
    } catch (err: any) {
        console.error('[IndexQuote] Tencent fetch error:', err?.message || err);
    }
    return result;
}

export class IndexQuoteController {
    private static buildIndexCacheKey(market: 'cn' | 'gb', symbol: string): string {
        return `${INDEX_QUOTE_CACHE_KEY_PREFIX}${market}:${symbol.toUpperCase()}`;
    }

    private static async readCachedQuote(market: 'cn' | 'gb', symbol: string): Promise<Record<string, any> | null> {
        const cacheKey = this.buildIndexCacheKey(market, symbol);
        try {
            const cached = await CacheService.get<StockInfoCachePayload>(cacheKey);
            if (!isValidStockInfoCachePayload(cached)) return null;
            return cached.data;
        } catch {
            return null;
        }
    }

    private static async writeCachedQuote(market: 'cn' | 'gb', symbol: string, quote: Record<string, any>, ttlSeconds?: number): Promise<void> {
        if (Object.keys(quote).length === 0) return;
        const resolvedTtl = ttlSeconds ?? await getAShareIndexCacheTtlSeconds();
        const cacheKey = this.buildIndexCacheKey(market, symbol);
        try {
            await CacheService.set(cacheKey, buildTimestampedCachePayload(quote), resolvedTtl);
        } catch {}
    }

    private static resolveGbSymbolFromTencentCode(tencentReturnCode: string): string | undefined {
        return GB_TENCENT_RETURN_CODE_TO_SYMBOL[tencentReturnCode];
    }

    static async getIndexQuotes(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbolsParam = req.query.symbols as string;
        if (!symbolsParam) {
            createResponse(res, 400, '缺少 symbols 参数，示例: ?symbols=000001,399006');
            return;
        }
        const symbols = [...new Set(symbolsParam.split(',').map(s => s.trim()).filter(Boolean))];
        if (symbols.length === 0) { createResponse(res, 400, '缺少 symbols 参数'); return; }
        if (symbols.length > MAX_SYMBOLS) { createResponse(res, 400, `单次最多查询 ${MAX_SYMBOLS} 只指数`); return; }
        const invalidSymbols = symbols.filter(s => !isValidAShareSymbol(s));
        if (invalidSymbols.length > 0) { createResponse(res, 400, `指数代码必须是6位数字: ${invalidSymbols.join(', ')}`); return; }

        try {
            const cachedQuotes: Record<string, any> = {};
            const uncachedSymbols: string[] = [];

            for (const symbol of symbols) {
                const cached = await this.readCachedQuote('cn', symbol);
                if (cached) { cachedQuotes[symbol] = cached; }
                else { uncachedSymbols.push(symbol); }
            }

            if (uncachedSymbols.length > 0) {
                const tencentCodes = uncachedSymbols.map(s => {
                    const prefix = CN_INDEX_TENCENT_PREFIX[s] || 'sh';
                    return `${prefix}${s}`;
                });

                const tencentData = await fetchTencentIndexQuotes(tencentCodes);

                for (const symbol of uncachedSymbols) {
                    const td = tencentData.get(symbol);
                    const name = CN_INDEX_NAMES[symbol] || symbol;

                    const quote: Record<string, any> = {
                        '指数代码': symbol,
                        '指数简称': name,
                        '最新价': td ? td.value : null,
                        '涨跌幅': td ? td.change : null,
                        '涨跌额': td ? td.changeAmount : null,
                    };

                    if (td) {
                        await this.writeCachedQuote('cn', symbol, quote);
                    }
                    cachedQuotes[symbol] = quote;
                }
            }

            const quotes = symbols.map(s => cachedQuotes[s]).filter(Boolean);
            createResponse(res, 200, 'success', { '来源': 'Tencent', '指数数量': quotes.length, '行情': quotes });
        } catch (err: any) {
            createResponse(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }

    static async getGlobalIndexQuotes(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbolsParam = req.query.symbols as string;
        if (!symbolsParam) {
            createResponse(res, 400, '缺少 symbols 参数，示例: ?symbols=HSI,HSTECH,HXC');
            return;
        }
        const symbols = [...new Set(symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))];
        if (symbols.length === 0) { createResponse(res, 400, '缺少 symbols 参数'); return; }
        if (symbols.length > MAX_SYMBOLS) { createResponse(res, 400, `单次最多查询 ${MAX_SYMBOLS} 只指数`); return; }
        const invalidSymbols = symbols.filter(s => !isValidGlobalIndexSymbol(s));
        if (invalidSymbols.length > 0) { createResponse(res, 400, `全球指数代码格式错误: ${invalidSymbols.join(', ')}`); return; }

        try {
            const cachedQuotes: Record<string, any> = {};
            const uncachedSymbols: string[] = [];

            for (const symbol of symbols) {
                const cached = await this.readCachedQuote('gb', symbol);
                if (cached) { cachedQuotes[symbol] = cached; }
                else { uncachedSymbols.push(symbol); }
            }

            if (uncachedSymbols.length > 0) {
                const tencentCodes = uncachedSymbols.map(s => GB_INDEX_TENCENT_CODE[s] || `us${s}`);

                const tencentData = await fetchTencentIndexQuotes(tencentCodes);

                const tencentCodeToSymbol = new Map<string, string>();
                for (const symbol of uncachedSymbols) {
                    const tc = GB_INDEX_TENCENT_CODE[symbol] || `us${symbol}`;
                    tencentCodeToSymbol.set(tc, symbol);
                }

                const resolvedData = new Map<string, ParsedTencentIndex>();
                for (const [returnCode, data] of tencentData.entries()) {
                    const symbol = this.resolveGbSymbolFromTencentCode(returnCode);
                    if (symbol) {
                        resolvedData.set(symbol, data);
                    }
                }

                for (const symbol of uncachedSymbols) {
                    const td = resolvedData.get(symbol);
                    const name = GB_INDEX_NAMES[symbol] || symbol;

                    const quote: Record<string, any> = {
                        '指数代码': symbol,
                        '指数简称': name,
                        '最新价': td ? td.value : null,
                        '涨跌幅': td ? td.change : null,
                        '涨跌额': td ? td.changeAmount : null,
                    };

                    if (td) {
                        await this.writeCachedQuote('gb', symbol, quote);
                    }
                    cachedQuotes[symbol] = quote;
                }
            }

            const quotes = symbols.map(s => cachedQuotes[s]).filter(Boolean);
            createResponse(res, 200, 'success', { '来源': 'Tencent', '指数数量': quotes.length, '行情': quotes });
        } catch (err: any) {
            createResponse(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
