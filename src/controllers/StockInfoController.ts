import { Request, Response, NextFunction } from 'express';
import { TushareInfoService } from '../services/TushareInfoService';
import { CacheService } from '../services/CacheService';
import {
    STOCK_INFO_CACHE_TTL_SECONDS,
    buildStockInfoCacheKey,
    buildTimestampedCachePayload,
    isValidStockInfoCachePayload,
    type StockInfoCachePayload,
} from '../constants/cache';
import { createResponse } from '../utils/response';
import { formatToChinaTime } from '../utils/datetime';
import { isValidAShareSymbol } from '../utils/validator';
import pool from '../db';

const MAX_SYMBOLS = 20;
const INDUSTRY_TAG_TYPE = '行业板块';
const REGION_TAG_TYPE = '地域板块';

interface BatchStockInfoResult {
    data: Record<string, any>;
    fromCache: boolean;
}

interface TagByNameRow {
    tag_name: string;
    tag_code: string;
}

export class StockInfoController {
    private static normalizeText(value: unknown): string | null {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    private static getSymbol(data: Record<string, any>): string | null {
        return this.normalizeText(data['股票代码']);
    }

    private static getIndustryBoardName(data: Record<string, any>): string | null {
        return this.normalizeText(data['行业板块'] ?? data['所属行业']);
    }

    private static getRegionBoardName(data: Record<string, any>): string | null {
        return this.normalizeText(data['地域板块']);
    }

    private static async queryTagCodesByNames(
        tagType: string,
        names: string[],
    ): Promise<Map<string, string>> {
        if (names.length === 0) return new Map();

        const placeholders = names.map((_, index) => `$${index + 2}`).join(', ');
        const sql = `
            SELECT tag_name, tag_code
            FROM tags
            WHERE tag_type = $1
              AND tag_name IN (${placeholders})
        `;

        const result = await pool.query(sql, [tagType, ...names]);
        const mapping = new Map<string, string>();
        for (const row of result.rows as TagByNameRow[]) {
            const tagName = this.normalizeText(row.tag_name);
            const tagCode = this.normalizeText(row.tag_code);
            if (!tagName || !tagCode) continue;
            mapping.set(tagName, tagCode);
        }
        return mapping;
    }

    private static async enrichBoardIds(items: Record<string, any>[]): Promise<Record<string, any>[]> {
        const enriched = items.map(item => ({ ...item }));
        if (enriched.length === 0) return enriched;

        const validItems = enriched.filter(item => !('错误' in item));

        const industryNames = Array.from(new Set(
            validItems.map(item => this.getIndustryBoardName(item)).filter((name): name is string => name !== null),
        ));
        const regionNames = Array.from(new Set(
            validItems.map(item => this.getRegionBoardName(item)).filter((name): name is string => name !== null),
        ));

        const [industryCodeByName, regionCodeByName] = await Promise.all([
            this.queryTagCodesByNames(INDUSTRY_TAG_TYPE, industryNames),
            this.queryTagCodesByNames(REGION_TAG_TYPE, regionNames),
        ]);

        for (const item of enriched) {
            if ('错误' in item) {
                item['行业板块ID'] = null;
                item['地域板块ID'] = null;
                continue;
            }
            const industryName = this.getIndustryBoardName(item);
            const regionName = this.getRegionBoardName(item);
            item['行业板块ID'] = industryName ? (industryCodeByName.get(industryName) ?? null) : null;
            item['地域板块ID'] = regionName ? (regionCodeByName.get(regionName) ?? null) : null;
        }

        return enriched;
    }

    private static getSourceBySymbol(_symbol: string): string {
        return `Tushare https://tushare.pro/document/2?doc_id=25`;
    }

    private static async fetchAndMaybeCache(symbol: string): Promise<Record<string, any>> {
        const data = await TushareInfoService.getStockInfo(symbol);

        if (Object.keys(data).length > 0) {
            try {
                await CacheService.set(
                    buildStockInfoCacheKey(symbol),
                    buildTimestampedCachePayload(data),
                    STOCK_INFO_CACHE_TTL_SECONDS,
                );
            } catch (err) {
                console.error(`Error writing stock info cache for ${symbol}:`, err);
            }
        }

        return data;
    }

    private static async getStockInfoForBatch(symbol: string): Promise<BatchStockInfoResult> {
        const cacheKey = buildStockInfoCacheKey(symbol);

        try {
            const cachedWrapper = await CacheService.get<StockInfoCachePayload>(cacheKey);
            if (isValidStockInfoCachePayload(cachedWrapper)) {
                return { data: cachedWrapper.data, fromCache: true };
            }
        } catch (err) {
            console.error(`Error reading stock info cache for ${symbol}:`, err);
        }

        try {
            const data = await this.fetchAndMaybeCache(symbol);
            return { data, fromCache: false };
        } catch (err) {
            console.error(`Error fetching info for ${symbol}:`, err);
            return {
                data: {
                    '市场代码': '-',
                    '股票代码': symbol,
                    '股票简称': '-',
                    '错误': err instanceof Error ? err.message : '查询失败',
                },
                fromCache: false,
            };
        }
    }

    static async getBatchStockInfo(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbolsParam = req.query.symbols as string;

        if (!symbolsParam) {
            createResponse(res, 400, '缺少 symbols 参数，示例: ?symbols=000001,600519');
            return;
        }

        const symbols = [...new Set(symbolsParam.split(',').map(s => s.trim()).filter(Boolean))];

        if (symbols.length === 0) {
            createResponse(res, 400, '缺少 symbols 参数，示例: ?symbols=000001,600519');
            return;
        }

        if (symbols.length > MAX_SYMBOLS) {
            createResponse(res, 400, `单次最多查询 ${MAX_SYMBOLS} 只股票`);
            return;
        }

        const invalidSymbols = symbols.filter(s => !isValidAShareSymbol(s));
        if (invalidSymbols.length > 0) {
            createResponse(res, 400, `Invalid symbol(s) - A股代码必须是6位数字: ${invalidSymbols.join(', ')}`);
            return;
        }

        try {
            const batchResults = await Promise.all(symbols.map(symbol => this.getStockInfoForBatch(symbol)));
            const allFromCache = batchResults.every(item => item.fromCache);
            const rawResults = batchResults.map(item => item.data);
            const results = await this.enrichBoardIds(rawResults);
            const now = Date.now();

            createResponse(res, 200, allFromCache ? 'success (cached)' : 'success', {
                '来源': 'Tushare',
                '更新时间': formatToChinaTime(now),
                '股票数量': results.length,
                '股票信息': results,
            });
        } catch (err: any) {
            console.error('Error fetching batch stock info:', err);
            createResponse(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
