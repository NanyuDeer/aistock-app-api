import fs from 'fs';
import path from 'path';
import pool from '../../core/db';
import { TencentKlineService } from '../quote/TencentKlineService';
import { TencentQuoteService } from '../quote/TencentQuoteService';
import { tushareRequest } from '../quote/TushareService';
import { getStockIdentity } from '../../shared/utils/stock';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_FILE = path.join(PROJECT_ROOT, 'data', 'hot-sectors.json');
const PUSH_HISTORY_FILE = path.join(PROJECT_ROOT, 'data', 'potential-stock-push-history.json');

let cachedData: any = null;
let cachedTime = 0;
const CACHE_TTL = 60 * 1000;
const HOME_SECTOR_LIMIT = 8;
const HOME_MAX_STOCKS_PER_SECTOR = 2;

let dbAvailable = false;

async function checkDbAvailability(): Promise<boolean> {
    if (dbAvailable) return true;
    try {
        await pool.query('SELECT 1');
        dbAvailable = true;
        console.log('[WindLeaderService] Database available, using PostgreSQL');
    } catch {
        dbAvailable = false;
        console.log('[WindLeaderService] Database unavailable, falling back to file storage');
    }
    return dbAvailable;
}

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

async function readPushHistoryFromDb(): Promise<any[]> {
    try {
        const result = await pool.query(`
            SELECT push_id, push_batch_id, push_date, push_time, push_rank,
                   stock_code, stock_name, theme, reason, strategy_name,
                   score, chain_position, source, reason_tag,
                   push_price, latest_price, latest_trade_date, latest_change_pct,
                   raw_analysis_price, price_basis, realtime_return_pct, realtime_time
            FROM wind_leader_push_history
            ORDER BY push_date DESC, score DESC
        `);
        return result.rows.map(row => ({
            ...row,
            push_date: row.push_date ? row.push_date.toISOString().slice(0, 10) : '',
            realtime_time: row.realtime_time ? row.realtime_time.toISOString() : null,
        }));
    } catch (err) {
        console.error('[WindLeaderService] read push history from DB failed:', err);
        return [];
    }
}

async function writePushHistoryToDb(records: any[]): Promise<void> {
    if (!records.length) return;

    try {
        for (const record of records) {
            await pool.query(`
                INSERT INTO wind_leader_push_history (
                    push_id, push_batch_id, push_date, push_time, push_rank,
                    stock_code, stock_name, theme, reason, strategy_name,
                    score, chain_position, source, reason_tag,
                    push_price, latest_price, latest_trade_date, latest_change_pct,
                    raw_analysis_price, price_basis, realtime_return_pct, realtime_time,
                    updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                    $11, $12, $13, $14, $15, $16, $17, $18,
                    $19, $20, $21, $22, NOW()
                ) ON CONFLICT (push_id) DO UPDATE SET
                    push_batch_id = EXCLUDED.push_batch_id,
                    push_date = EXCLUDED.push_date,
                    push_time = EXCLUDED.push_time,
                    push_rank = EXCLUDED.push_rank,
                    stock_code = EXCLUDED.stock_code,
                    stock_name = EXCLUDED.stock_name,
                    theme = EXCLUDED.theme,
                    reason = EXCLUDED.reason,
                    strategy_name = EXCLUDED.strategy_name,
                    score = EXCLUDED.score,
                    chain_position = EXCLUDED.chain_position,
                    source = EXCLUDED.source,
                    reason_tag = EXCLUDED.reason_tag,
                    push_price = EXCLUDED.push_price,
                    latest_price = EXCLUDED.latest_price,
                    latest_trade_date = EXCLUDED.latest_trade_date,
                    latest_change_pct = EXCLUDED.latest_change_pct,
                    raw_analysis_price = EXCLUDED.raw_analysis_price,
                    price_basis = EXCLUDED.price_basis,
                    realtime_return_pct = EXCLUDED.realtime_return_pct,
                    realtime_time = EXCLUDED.realtime_time,
                    updated_at = NOW()
            `, [
                record.push_id, record.push_batch_id, record.push_date, record.push_time, record.push_rank,
                record.stock_code, record.stock_name, record.theme, record.reason, record.strategy_name,
                record.score, record.chain_position, record.source, record.reason_tag,
                record.push_price, record.latest_price, record.latest_trade_date, record.latest_change_pct,
                record.raw_analysis_price, record.price_basis, record.realtime_return_pct, record.realtime_time,
            ]);
        }
    } catch (err) {
        console.error('[WindLeaderService] write push history to DB failed:', err);
        throw err;
    }
}

async function updatePushHistoryPricesInDb(updatedRecords: any[]): Promise<void> {
    if (!updatedRecords.length) return;

    try {
        for (const record of updatedRecords) {
            await pool.query(`
                UPDATE wind_leader_push_history SET
                    latest_price = $1,
                    latest_change_pct = $2,
                    latest_trade_date = $3,
                    realtime_return_pct = $4,
                    realtime_time = $5,
                    updated_at = NOW()
                WHERE push_id = $6
            `, [
                record.latest_price, record.latest_change_pct, record.latest_trade_date,
                record.realtime_return_pct, record.realtime_time, record.push_id,
            ]);
        }
    } catch (err) {
        console.error('[WindLeaderService] update push history prices in DB failed:', err);
        throw err;
    }
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
        hot_sectors: unknown[];
    } | null> {
        const data = loadData();
        if (!data) return null;

        // 数据文件中 hot_sectors 为空时视为无数据，避免前端展示空白
        if (!data.hot_sectors || !Array.isArray(data.hot_sectors) || data.hot_sectors.length === 0) {
            return null;
        }

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

    static async getPotentialPushHistory(): Promise<any[]> {
        const isDbAvailable = await checkDbAvailability();
        
        let history: any[];
        if (isDbAvailable) {
            history = await readPushHistoryFromDb();
        } else {
            history = readPushHistoryFile();
        }

        const latest = loadData();
        const latestRecords = latest ? collectPushRecordsFromData(latest) : [];
        const merged = new Map<string, any>();

        history.forEach(record => {
            if (record?.push_id) merged.set(record.push_id, record);
        });
        latestRecords.forEach(record => {
            merged.set(record.push_id, mergePushRecord(merged.get(record.push_id), record));
        });

        return Array.from(merged.values()).sort((a, b) => {
            if (a.push_date !== b.push_date) {
                return String(b.push_date).localeCompare(String(a.push_date));
            }
            return (Number(b.score) || 0) - (Number(a.score) || 0);
        });
    }

    static async appendPotentialPushHistory(data: any): Promise<void> {
        const nextRecords = await enrichPushPricesWithPreviousClose(collectPushRecordsFromData(data));
        if (!nextRecords.length) return;

        const isDbAvailable = await checkDbAvailability();
        
        let history: any[];
        if (isDbAvailable) {
            history = await readPushHistoryFromDb();
        } else {
            history = readPushHistoryFile();
        }

        const merged = new Map<string, any>();
        history.forEach(record => {
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

        if (isDbAvailable) {
            await writePushHistoryToDb(records);
        } else {
            writePushHistoryFile(records);
        }
    }

    static async getWindLeaders(limit: number = 8): Promise<{
        update_time: string;
        hot_sectors: unknown[];
    } | null> {
        return this.getAnalysis(limit);
    }

    static async updatePushHistoryPrices(): Promise<void> {
        console.log('[PriceUpdate] update push history prices...');
        try {
            const isDbAvailable = await checkDbAvailability();
            
            let history: any[];
            if (isDbAvailable) {
                history = await readPushHistoryFromDb();
            } else {
                history = readPushHistoryFile();
            }

            if (!history.length) {
                console.log('[PriceUpdate] push history is empty, skip');
                return;
            }

            const stockCodes = [
                ...new Set(
                    history
                        .map(record => String(record.stock_code || '').trim())
                        .filter(Boolean)
                ),
            ];
            if (!stockCodes.length) {
                console.log('[PriceUpdate] no stock codes, skip');
                return;
            }

            const quotes = await TencentQuoteService.getBatchQuotes(stockCodes, 'core');
            const quoteMap = new Map<string, Record<string, any>>();
            quotes.forEach((quote, index) => {
                const code = stockCodes[index];
                if (code && quote && !('\u9519\u8bef' in quote)) {
                    quoteMap.set(code, quote);
                }
            });

            const now = new Date().toISOString();
            const latestTradeDate = now.split('T')[0].replace(/-/g, '');
            let updatedCount = 0;

            const updatedRecords = history.map(record => {
                const quote = quoteMap.get(record.stock_code);
                const latestPrice = quote ? toFiniteNumber(quote['\u6700\u65b0\u4ef7']) : null;
                if (latestPrice !== null && latestPrice > 0) {
                    const pushPrice = Number(record.push_price) || 0;
                    const returnPct = pushPrice > 0 ? ((latestPrice - pushPrice) / pushPrice * 100) : 0;

                    updatedCount++;
                    return {
                        ...record,
                        latest_price: latestPrice,
                        latest_change_pct: quote ? toFiniteNumber(quote['\u6da8\u8dcc\u5e45']) : record.latest_change_pct,
                        latest_trade_date: latestTradeDate,
                        realtime_return_pct: Number(returnPct.toFixed(2)),
                        realtime_time: now,
                    };
                }
                return record;
            });

            if (isDbAvailable) {
                await updatePushHistoryPricesInDb(updatedRecords);
            } else {
                writePushHistoryFile(updatedRecords);
            }

            console.log(`[PriceUpdate] done: ${updatedRecords.length} records, updated ${updatedCount}`);
        } catch (err: any) {
            console.error('[PriceUpdate] failed:', err?.message || err);
        }
    }
}