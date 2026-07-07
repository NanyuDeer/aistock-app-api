import fs from 'fs';
import path from 'path';
import { TencentKlineService } from '../quote/TencentKlineService';
import { TencentQuoteService } from '../quote/TencentQuoteService';
import { tushareRequest, getDailyPrices } from '../quote/TushareService';
import { getStockIdentity } from '../../shared/utils/stock';

// 使用项目根目录的data文件夹（而不是相对于编译代码的路径）
// 文件位于 src/modules/monitor/，需往上三级才到项目根目录
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_FILE = path.join(PROJECT_ROOT, 'data', 'hot-sectors.json');
const PUSH_HISTORY_FILE = path.join(PROJECT_ROOT, 'data', 'potential-stock-push-history.json');

let cachedData: any = null;
let cachedTime = 0;
const CACHE_TTL = 60 * 1000;
const HOME_SECTOR_LIMIT = 8;
const HOME_MAX_STOCKS_PER_SECTOR = 2;

function loadData(): any {
    const now = Date.now();
    if (cachedData && now - cachedTime < CACHE_TTL) {
        return cachedData;
    }

    try {
        if (!fs.existsSync(DATA_FILE)) {
            return null;
        }
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        cachedData = JSON.parse(raw);
        cachedTime = now;
        return cachedData;
    } catch (err) {
        console.error('[WindLeaderService] read hot-sectors.json failed:', err);
        return cachedData;
    }
}

function invalidateCache(): void {
    cachedData = null;
    cachedTime = 0;
}

function toFiniteNumber(value: unknown): number | null {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function cleanText(value: unknown, maxLength: number = 1000): string {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function cleanTextList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map(item => cleanText(item, 80)).filter(Boolean)
        : [];
}

function normalizeDateText(value: unknown): string {
    if (!value) return new Date().toISOString().slice(0, 10);

    const text = cleanText(value, 40);
    const match = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (!match) return new Date().toISOString().slice(0, 10);

    const [, year, month, day] = match;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function dateCompact(dateText: string): string {
    return dateText.replace(/-/g, '');
}

function dateToEastmoneyText(dateText: string): string {
    return dateText.replace(/-/g, '');
}

function toTushareCode(symbol: string): string {
    const identity = getStockIdentity(symbol);
    return `${symbol}.${identity.market.toUpperCase()}`;
}

function safeIdPart(value: unknown, fallback: string, maxLength: number): string {
    const text = cleanText(value || fallback, maxLength * 2)
        .replace(/[^\w\u4e00-\u9fa5]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return (text || fallback).slice(0, maxLength);
}

function buildPushId(pushDate: string, stock: any, sectorName: string, chainPosition: string): string {
    const theme = safeIdPart(sectorName, 'theme', 24);
    const chain = safeIdPart(chainPosition, 'core', 12);
    return `windleader_${dateCompact(pushDate)}_${stock.code}_${theme}_${chain}`;
}

function formatStock(s: any): any {
    return {
        code: cleanText(s.code, 20),
        name: cleanText(s.name, 80),
        industry: cleanText(s.industry, 120),
        score: s.score,
        reason: cleanText(s.reason, 1000),
        reason_tag: cleanText(s.reason_tag, 80),
        reason_tag_class: cleanText(s.reason_tag_class, 80),
        in_concept: s.in_concept,
        chain_position: cleanText(s.chain_position, 40),
        source: cleanText(s.source, 120),
        overlap_ratio: s.overlap_ratio || 0,
        transmission_factor: s.transmission_factor || 0,
        related_industry: cleanText(s.related_industry, 120),
        price: s.price ?? null,
        change_pct: s.change_pct ?? null,
    };
}

function selectHomeRecommendedStocks(data: any): Array<{ stock: any; sector: any; chainPosition: string; displayRank: number }> {
    const seen = new Set<string>();
    const picked: Array<{ stock: any; sector: any; chainPosition: string }> = [];

    for (const sector of (data?.hot_sectors || []).slice(0, HOME_SECTOR_LIMIT)) {
        const sectorStocks = [
            ...(sector.main_stocks || []).map((stock: any) => ({ stock, chainPosition: stock.chain_position || '核心', priority: 0 })),
            ...(sector.upstream_stocks || []).map((stock: any) => ({ stock, chainPosition: stock.chain_position || '上游', priority: 1 })),
            ...(sector.downstream_stocks || []).map((stock: any) => ({ stock, chainPosition: stock.chain_position || '下游', priority: 1 })),
        ].sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return (Number(b.stock.score) || 0) - (Number(a.stock.score) || 0);
        });

        let sectorPicked = 0;
        for (const item of sectorStocks) {
            const stockCode = cleanText(item.stock?.code, 20);
            if (!stockCode || seen.has(stockCode) || sectorPicked >= HOME_MAX_STOCKS_PER_SECTOR) continue;

            seen.add(stockCode);
            sectorPicked++;
            picked.push({
                stock: item.stock,
                sector,
                chainPosition: item.chainPosition,
            });
        }
    }

    return picked
        .sort((a, b) => (Number(b.stock.score) || 0) - (Number(a.stock.score) || 0))
        .map((item, index) => ({ ...item, displayRank: index + 1 }));
}

function collectPushRecordsFromData(data: any): any[] {
    const pushDate = normalizeDateText(data?.update_time);
    const pushBatchId = `windleader_${dateCompact(pushDate)}`;
    const records = new Map<string, any>();

    const addStock = (sector: any, stock: any, defaultChainPosition: string, displayRank: number) => {
        const sectorName = cleanText(sector?.name, 80);
        if (!stock?.code) return;

        const pushPrice = toFiniteNumber(stock.price);
        if (pushPrice === null || pushPrice <= 0) return;

        const stockCode = cleanText(stock.code, 20);
        const chainPosition = cleanText(stock.chain_position || defaultChainPosition, 40);
        const record = {
            push_id: buildPushId(pushDate, { ...stock, code: stockCode }, sectorName, chainPosition),
            push_batch_id: pushBatchId,
            push_date: pushDate,
            push_time: cleanText(data?.update_time, 40),
            push_rank: displayRank,
            stock_code: stockCode,
            stock_name: cleanText(stock.name, 80),
            theme: sectorName,
            reason: cleanText(stock.reason || sector?.driver, 1000),
            strategy_name: 'wind_leader_home_recommendation',
            score: toFiniteNumber(stock.score),
            chain_position: chainPosition,
            source: cleanText(stock.source || sectorName, 120),
            reason_tag: cleanText(stock.reason_tag, 80),
            push_price: Number(pushPrice.toFixed(2)),
            latest_price: Number(pushPrice.toFixed(2)),
            latest_trade_date: pushDate,
            latest_change_pct: toFiniteNumber(stock.change_pct),
        };

        records.set(record.push_id, record);
    };

    selectHomeRecommendedStocks(data).forEach(({ stock, sector, chainPosition, displayRank }) => {
        addStock(sector, stock, chainPosition, displayRank);
    });

    return Array.from(records.values());
}

function readPushHistoryFile(): any[] {
    try {
        if (!fs.existsSync(PUSH_HISTORY_FILE)) {
            return [];
        }
        const raw = fs.readFileSync(PUSH_HISTORY_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : parsed?.items || [];
    } catch (err) {
        console.error('[WindLeaderService] read push history failed:', err);
        return [];
    }
}

function writePushHistoryFile(records: any[]): void {
    const dir = path.dirname(PUSH_HISTORY_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(PUSH_HISTORY_FILE, JSON.stringify(records, null, 2), 'utf-8');
}

async function getPreviousClosePrice(symbol: string, pushDate: string): Promise<{ price: number; basis: string } | null> {
    const rows = await TencentKlineService.getKLine({
        symbol,
        klt: 101,
        fqt: 0,
        limit: 20,
        endDate: dateToEastmoneyText(pushDate),
    });
    const previousRows = rows
        .filter(row => String(row['时间'] || '') < pushDate)
        .sort((a, b) => String(b['时间']).localeCompare(String(a['时间'])));
    const close = Number(previousRows[0]?.['收盘价']);
    if (Number.isFinite(close) && close > 0) {
        return { price: Number(close.toFixed(2)), basis: 'tencent_previous_trade_close' };
    }

    const fallbackRows = await tushareRequest(
        'daily',
        { ts_code: toTushareCode(symbol), end_date: dateCompact(pushDate) },
        'ts_code,trade_date,close',
    );
    const fallback = fallbackRows
        .filter(row => String(row.trade_date || '') < dateCompact(pushDate))
        .sort((a, b) => String(b.trade_date || '').localeCompare(String(a.trade_date || '')))[0];
    const fallbackClose = Number(fallback?.close);
    return Number.isFinite(fallbackClose) && fallbackClose > 0
        ? { price: Number(fallbackClose.toFixed(2)), basis: 'tushare_previous_trade_close_fallback' }
        : null;
}

async function enrichPushPricesWithPreviousClose(records: any[]): Promise<any[]> {
    const enriched = await Promise.all(records.map(async record => {
        try {
            const previousClose = await getPreviousClosePrice(record.stock_code, record.push_date);
            if (!previousClose) return record;
            return {
                ...record,
                raw_analysis_price: record.raw_analysis_price ?? record.push_price,
                push_price: previousClose.price,
                latest_price: previousClose.price,
                latest_trade_date: record.push_date,
                price_basis: previousClose.basis,
            };
        } catch (err) {
            console.warn(`[WindLeaderService] previous close fetch failed: ${record.stock_code}`, (err as Error).message);
            return record;
        }
    }));
    return enriched;
}

function mergePushRecord(existing: any, next: any): any {
    if (!existing) return next;
    return {
        ...next,
        ...existing,
        push_price: existing.push_price,
        latest_price: existing.latest_price ?? existing.push_price,
        latest_trade_date: existing.latest_trade_date ?? existing.push_date,
    };
}

export class WindLeaderService {
    static async getAnalysis(limit: number = 8): Promise<{
        update_time: string;
        hot_sectors: any[];
    } | null> {
        const data = loadData();
        if (!data) return null;

        const sectors = (data.hot_sectors || []).slice(0, limit).map((sector: any) => ({
            code: sector.code || '',
            name: sector.name,
            type: sector.type,
            frequency: sector.frequency,
            avg_change: sector.avg_change,
            today_change: sector.today_change,
            amount_trend: sector.amount_trend,
            net_inflow: sector.net_inflow || 0,
            score: sector.score ?? 0,
            leading_stock: sector.leading_stock,
            leading_change: sector.leading_change || 0,
            up_count: sector.up_count || 0,
            down_count: sector.down_count || 0,
            driver: sector.driver,
            related_industries: sector.related_industries || [],
            industry_data: sector.industry_data || [],
            ai_analysis: sector.ai_analysis || null,
            main_stocks: (sector.main_stocks || []).map(formatStock),
            upstream_stocks: (sector.upstream_stocks || []).map(formatStock),
            downstream_stocks: (sector.downstream_stocks || []).map(formatStock),
            flow_data: sector.flow_data || null,
            leading_stock_info: sector.leading_stock_info || null,
        }));

        // 用缓存行情实时刷新所有股票的价格和涨跌幅
        try {
            const stockLists = ['main_stocks', 'upstream_stocks', 'downstream_stocks'] as const;
            const allCodes: string[] = [];
            for (const sector of sectors) {
                if (sector.leading_stock_info?.code) allCodes.push(sector.leading_stock_info.code);
                for (const key of stockLists) {
                    for (const s of sector[key]) {
                        if (s.code) allCodes.push(s.code);
                    }
                }
            }
            const uniqueCodes = [...new Set(allCodes)];
            if (uniqueCodes.length > 0) {
                const quotes = await TencentQuoteService.getCachedBatchQuotes(uniqueCodes, 'core');
                const quoteMap = new Map<string, Record<string, any>>();
                uniqueCodes.forEach((code, i) => {
                    if (quotes[i] && !('错误' in quotes[i])) quoteMap.set(code, quotes[i]);
                });
                for (const sector of sectors) {
                    if (sector.leading_stock_info?.code) {
                        const q = quoteMap.get(sector.leading_stock_info.code);
                        if (q) {
                            if (q['最新价'] && q['最新价'] > 0) sector.leading_stock_info.price = q['最新价'];
                            if (q['涨跌幅'] !== undefined && q['涨跌幅'] !== null) sector.leading_stock_info.change_pct = q['涨跌幅'];
                        }
                    }
                    for (const key of stockLists) {
                        for (const s of sector[key]) {
                            if (!s.code) continue;
                            const q = quoteMap.get(s.code);
                            if (q) {
                                if (q['最新价'] && q['最新价'] > 0) s.price = q['最新价'];
                                if (q['涨跌幅'] !== undefined && q['涨跌幅'] !== null) s.change_pct = q['涨跌幅'];
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[WindLeaderService] getAnalysis 刷新行情失败:', (e as Error).message);
        }

        return {
            update_time: data.update_time || '',
            hot_sectors: sectors,
        };
    }

    static async saveData(data: any): Promise<void> {
        try {
            const dir = path.dirname(DATA_FILE);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
            await this.appendPotentialPushHistory(data);
            invalidateCache();
        } catch (err) {
            console.error('[WindLeaderService] save hot-sectors.json failed:', err);
            throw err;
        }
    }

    static getPotentialPushHistory(): any[] {
        const history = readPushHistoryFile();
        const latest = loadData();
        const latestRecords = latest ? collectPushRecordsFromData(latest) : [];
        const merged = new Map<string, any>();

        history.forEach(record => {
            if (record?.push_id) merged.set(record.push_id, record);
        });
        latestRecords.forEach(record => {
            merged.set(record.push_id, mergePushRecord(merged.get(record.push_id), record));
        });

        // 过滤：只返回有价格更新的记录（避免盘中显示未收盘数据）
        // 要求 realtime_time 存在且日期 >= push_date
        const filtered = Array.from(merged.values()).filter(record => {
            if (!record.realtime_time) return false;
            const realtimeDate = new Date(record.realtime_time).toISOString().split('T')[0];
            return realtimeDate >= record.push_date;
        });

        return filtered.sort((a, b) => {
            if (a.push_date !== b.push_date) {
                return String(b.push_date).localeCompare(String(a.push_date));
            }
            return (Number(b.score) || 0) - (Number(a.score) || 0);
        });
    }

    static async appendPotentialPushHistory(data: any): Promise<void> {
        const nextRecords = await enrichPushPricesWithPreviousClose(collectPushRecordsFromData(data));
        if (!nextRecords.length) return;

        const merged = new Map<string, any>();
        readPushHistoryFile().forEach(record => {
            if (record?.push_id) merged.set(record.push_id, record);
        });
        nextRecords.forEach(record => {
            merged.set(record.push_id, mergePushRecord(merged.get(record.push_id), record));
        });

        const records = Array.from(merged.values()).sort((a, b) => {
            if (a.push_date !== b.push_date) {
                return String(b.push_date).localeCompare(String(a.push_date));
            }
            return (Number(b.score) || 0) - (Number(a.score) || 0);
        });

        writePushHistoryFile(records);
    }

    /**
     * 更新推送历史记录的最新价格（每天收盘后执行）
     * 使用 Tushare 获取最新日行情数据
     */
    static async updatePushHistoryPrices(): Promise<void> {
        console.log('[WindLeaderService] 开始更新推送历史价格...');
        
        const history = readPushHistoryFile();
        if (!history.length) {
            console.log('[WindLeaderService] 无推送历史记录，跳过更新');
            return;
        }

        // 获取最近60天的交易日期（确保有足够数据覆盖节假日）
        const today = new Date();
        const startDate = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000);
        const startDateStr = startDate.toISOString().split('T')[0].replace(/-/g, '');

        // 提取所有股票代码
        const stockCodes = new Set<string>();
        history.forEach(record => {
            if (record.stock_code) stockCodes.add(record.stock_code);
        });

        console.log(`[WindLeaderService] 需更新 ${stockCodes.size} 只股票的最新价格`);

        // 批量获取最新行情
        const priceMap = new Map<string, { close: number; pct_chg: number; trade_date: string }>();
        
        for (const stockCode of Array.from(stockCodes)) {
            try {
                const rows = await getDailyPrices(stockCode, startDateStr);
                if (rows && rows.length > 0) {
                    // 取最新一条（按日期降序）
                    const latest = rows.sort((a, b) => 
                        String(b.trade_date).localeCompare(String(a.trade_date))
                    )[0];
                    priceMap.set(stockCode, {
                        close: latest.close,
                        pct_chg: latest.pct_chg,
                        trade_date: latest.trade_date,
                    });
                    console.log(`[WindLeaderService] ${stockCode}: 价格=${latest.close}, 涨跌幅=${latest.pct_chg}%, 日期=${latest.trade_date}`);
                }
            } catch (err) {
                console.warn(`[WindLeaderService] 获取 ${stockCode} 行情失败:`, (err as Error).message);
            }
        }

        // 更新历史记录
        const updated = history.map(record => {
            const priceData = priceMap.get(record.stock_code);
            if (!priceData) return record;

            return {
                ...record,
                latest_price: priceData.close,
                latest_change_pct: priceData.pct_chg,
                latest_trade_date: priceData.trade_date,
                // 计算收益率（相对于推送价格）
                realtime_return_pct: record.push_price && record.push_price > 0
                    ? Number(((priceData.close - record.push_price) / record.push_price * 100).toFixed(2))
                    : null,
                realtime_time: new Date().toISOString(),
            };
        });

        writePushHistoryFile(updated);
        console.log(`[WindLeaderService] 已更新 ${priceMap.size} 只股票的最新价格`);
    }
}
