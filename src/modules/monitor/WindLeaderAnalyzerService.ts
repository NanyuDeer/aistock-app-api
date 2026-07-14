/**
 * 风口龙头 - 核心分析引擎（TypeScript 版本）
 *
 * 使用同花顺 API + Tushare 数据源
 *
 * 核心逻辑：
 * 1. 从同花顺概念板块中筛选风口板块（十日上榜频次 + 资金流入）
 * 2. 根据概念板块成分股，判断强关联的二级行业
 * 3. 展开强关联二级行业的上下游二级行业
 * 4. 在二级行业中筛选股票（多因子：涨幅+资金+量比+市值+连续上涨）
 */

import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import { TencentQuoteService } from '../quote/TencentQuoteService';
import { IndustryKGService } from './IndustryKGService';
import { WindLeaderService } from './WindLeaderService';
import { thsCrawler, thsApiCrawler } from '../../shared/utils/crawler';
import { sessionFetch } from '../../shared/utils/httpAgent';
import {
    tushareRequest,
    getMoneyflowByDate,
    getDailyBasicByDate,
    getStockDailyRecent,
    getThsIndex,
    getThsDaily,
    getThsMember,
    getDailyByDate,
    getLimitCptList,
    getThsHot,
    getLimitListThs,
    getLimitStep,
    getMoneyflowCntThs,
    getMoneyflowThsByDate,
    type MoneyflowRow,
    type DailyBasicFullRow,
    type DailyPriceRow,
    type ThsIndexRow,
    type ThsDailyRow,
    type ThsMemberRow,
    type LimitCptListRow,
    type ThsHotRow,
    type LimitListThsRow,
    type LimitStepRow,
    type MoneyflowCntThsRow,
    type MoneyflowThsRow,
    getStockCompany,
    type StockCompanyRow,
} from '../quote/TushareService';
import pool from '../../core/db';
import { getBatchSinaMoneyflowForBJ, isBJStock } from '../quote/SinaMoneyFlowService';

// ==================== 缓存 ====================
const CACHE_DIR = path.resolve(__dirname, '../../data/hot-sector-cache');
const CACHE_TTL = 3600 * 1000; // 缓存1小时

/** 批量查询股票的行业板块（从 stocks 表，与个股详情页一致） */
async function getStocksIndustryMap(codes: string[]): Promise<Map<string, string>> {
    if (codes.length === 0) return new Map();
    try {
        const result = await pool.query(
            'SELECT symbol, industry FROM stocks WHERE symbol = ANY($1) AND industry IS NOT NULL AND industry != \'\'',
            [codes],
        );
        return new Map(result.rows.map((r: any) => [r.symbol, r.industry]));
    } catch (err) {
        console.warn('[HotSectorAnalyzer] getStocksIndustryMap failed:', (err as Error).message);
        return new Map();
    }
}

/** 过滤传导数据：与 buildFlowData 一致的过滤逻辑（按 source_industry 分组，每组取权重最高的3个） */
function filterTransmissionForFlow(transmission: TransmissionResult): { upstream: TransmissionItem[]; downstream: TransmissionItem[] } {
    const filterGroup = (items: TransmissionItem[]): TransmissionItem[] => {
        const bySource = new Map<string, TransmissionItem[]>();
        for (const item of items) {
            const arr = bySource.get(item.source_industry) || [];
            arr.push(item);
            bySource.set(item.source_industry, arr);
        }
        const filtered: TransmissionItem[] = [];
        const seen = new Set<string>();
        for (const [, list] of bySource) {
            const top = list.sort((a, b) => b.factor - a.factor).slice(0, 3);
            for (const item of top) {
                if (!seen.has(item.name)) {
                    seen.add(item.name);
                    filtered.push(item);
                }
            }
        }
        return filtered;
    };
    return {
        upstream: filterGroup(transmission.upstream),
        downstream: filterGroup(transmission.downstream),
    };
}

/** Tushare概念/行业指数 名称→ts_code 映射缓存 */
let thsIndexNameMap: Map<string, string> | null = null;

async function getThsIndexNameMap(): Promise<Map<string, string>> {
    if (thsIndexNameMap) return thsIndexNameMap;
    const map = new Map<string, string>();
    try {
        // 概念指数
        const conceptIndices = await getThsIndex('N', 'A');
        for (const idx of conceptIndices) {
            map.set(idx.name, idx.ts_code);
        }
        // 行业指数
        const industryIndices = await getThsIndex('I', 'A');
        for (const idx of industryIndices) {
            map.set(idx.name, idx.ts_code);
        }
        console.log(`[HotSectorAnalyzer] Tushare指数映射构建完成: ${map.size}个`);
    } catch (err) {
        console.warn('[HotSectorAnalyzer] Tushare指数映射构建失败:', err);
    }
    thsIndexNameMap = map;
    return map;
}

function ensureCacheDir(): void {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

/** 清除所有缓存（用于强制刷新数据） */
function clearAllCache(): void {
    try {
        ensureCacheDir();
        const files = fs.readdirSync(CACHE_DIR);
        let count = 0;
        for (const file of files) {
            // 保留AI板块判断缓存、快照文件、股票→行业反向映射、同花顺行业产业链
            if (file === 'ai_sector_judgment_cache.json' || file.startsWith('snapshot_') || file === 'stock_industry_reverse_map.json' || file === 'ths_industry_chain.json') continue;
            const fp = path.join(CACHE_DIR, file);
            fs.unlinkSync(fp);
            count++;
        }
        // 重置内存缓存
        dailyByDateCache = null;
        thsIndexNameMap = null;
        console.log(`[HotSectorAnalyzer] 缓存已清除: ${count}个文件`);
    } catch (err) {
        console.warn('[HotSectorAnalyzer] 缓存清除失败:', err);
    }
}

function cacheGet(key: string): any | null {
    try {
        ensureCacheDir();
        const fp = path.join(CACHE_DIR, `${key}.json`);
        if (!fs.existsSync(fp)) return null;
        const stat = fs.statSync(fp);
        if (Date.now() - stat.mtimeMs > CACHE_TTL) return null;
        const raw = fs.readFileSync(fp, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function cacheSet(key: string, data: any): void {
    try {
        ensureCacheDir();
        const fp = path.join(CACHE_DIR, `${key}.json`);
        fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
        console.warn('[HotSectorAnalyzer] 缓存写入失败:', err);
    }
}

// ==================== 同花顺板块数据 ====================

const THS_HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.10jqka.com.cn/',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/** 同花顺HTML页面请求（GBK解码）- 使用分布式爬虫 */
async function fetchThsHtml(url: string): Promise<string> {
    return thsCrawler.fetchHtml(url);
}

/** 同花顺JSON API请求 - 使用分布式爬虫 */
async function fetchThsJson(url: string): Promise<any> {
    return thsApiCrawler.fetchJson(url);
}

/** 获取同花顺概念板块列表（优先使用Tushare ths_index，回退到HTML爬虫） */
async function getConceptBoards(): Promise<any[]> {
    const cacheKey = 'ths_concept_boards';
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    // ===== 优先使用Tushare ths_index =====
    try {
        const conceptIndices = await getThsIndex('N', 'A');
        if (conceptIndices.length > 0) {
            const result = conceptIndices.map(idx => ({
                code: idx.ts_code,
                name: idx.name,
                change: 0,  // 涨跌幅在identifyHotConcepts中通过ths_daily获取
                price: 0,
                up_count: 0,
                down_count: 0,
                net_inflow: 0,
            }));
            console.log(`[HotSectorAnalyzer] Tushare概念板块获取成功: ${result.length}个`);
            cacheSet(cacheKey, result);
            saveDailySnapshot('concept', result);
            return result;
        }
    } catch (err) {
        console.warn('[HotSectorAnalyzer] Tushare概念板块获取失败:', (err as Error).message);
    }

    try {
        const html = await fetchThsHtml('https://q.10jqka.com.cn/gn/');
        const $ = cheerio.load(html);

        // 从页面隐藏的#gnSection输入框提取概念板块数据
        const gnSectionVal = $('#gnSection').val() as string;
        if (gnSectionVal) {
            const data = new Function('return (' + gnSectionVal + ')')() as Record<string, any>;
            const result = Object.values(data).map((item: any) => ({
                code: String(item.cid || ''),
                name: item.platename || '',
                change: parseFloat(item[199112]) || 0,  // 涨跌幅
                price: 0,
                up_count: parseInt(item.zfl) || 0,       // 涨幅家数
                down_count: 0,
                net_inflow: (parseFloat(item.zjjlr) || 0) * 100000000, // 亿元→元
            })).filter((item: any) => item.code && item.name);

            if (result.length > 0) {
                console.log(`[HotSectorAnalyzer] 同花顺概念板块获取成功: ${result.length}个`);
                cacheSet(cacheKey, result);
                saveDailySnapshot('concept', result);
                return result;
            }
        }

        // Fallback: 从概念链接提取（无涨幅数据）
        const result: any[] = [];
        const seen = new Set<string>();
        $('a[href*="/gn/detail/code/"]').each((i, el) => {
            const name = $(el).text().trim();
            const href = $(el).attr('href') || '';
            const code = href.match(/code\/(\d+)/)?.[1] || '';
            if (name && code && !seen.has(code)) {
                seen.add(code);
                result.push({
                    code,
                    name,
                    change: 0,
                    price: 0,
                    up_count: 0,
                    down_count: 0,
                    net_inflow: 0,
                });
            }
        });

        if (result.length > 0) {
            console.log(`[HotSectorAnalyzer] 同花顺概念板块链接提取成功: ${result.length}个（无涨幅数据）`);
            cacheSet(cacheKey, result);
            saveDailySnapshot('concept', result);
            return result;
        }
    } catch (err) {
        console.error('[HotSectorAnalyzer] 同花顺概念板块获取失败:', err);
    }

    return [];
}

/** 获取同花顺行业板块列表（优先使用Tushare ths_index，回退到HTML爬虫） */
async function getIndustryBoards(): Promise<any[]> {
    const cacheKey = 'ths_industry_boards';
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    // ===== 优先使用Tushare ths_index =====
    try {
        const industryIndices = await getThsIndex('I', 'A');
        if (industryIndices.length > 0) {
            const industries = industryIndices.map(idx => ({
                code: idx.ts_code,
                name: idx.name,
                change: 0,  // 涨跌幅在选股时按需获取
                price: 0,
                up_count: 0,
                down_count: 0,
                net_inflow: 0,
                leading_stock: '--',
            }));

            console.log(`[HotSectorAnalyzer] Tushare行业板块获取成功: ${industries.length}个`);
            cacheSet(cacheKey, industries);
            return industries;
        }
    } catch (err) {
        console.warn('[HotSectorAnalyzer] Tushare行业板块获取失败:', (err as Error).message);
    }

    // ===== Fallback：HTML爬虫 =====
    try {
        const html = await fetchThsHtml('https://q.10jqka.com.cn/thshy/');
        const $ = cheerio.load(html);

        const industries: any[] = [];
        $('table tbody tr').each((i, el) => {
            const cells = $(el).find('td');
            if (cells.length < 8) return;

            const nameEl = cells.eq(1).find('a');
            const name = nameEl.text().trim();
            const href = nameEl.attr('href') || '';
            const code = href.match(/code\/(\d+)/)?.[1] || '';
            const change = parseFloat(cells.eq(2).text().trim()) || 0;
            const netInflow = parseFloat(cells.eq(5).text().trim()) || 0;
            const upCount = parseInt(cells.eq(6).text().trim()) || 0;
            const downCount = parseInt(cells.eq(7).text().trim()) || 0;
            const leadingStock = cells.eq(9).find('a').text().trim() || '';

            if (name && code) {
                industries.push({
                    code,
                    name,
                    change,
                    price: 0,
                    up_count: upCount,
                    down_count: downCount,
                    net_inflow: netInflow * 100000000, // 亿元→元
                    leading_stock: leadingStock,
                });
            }
        });

        console.log(`[HotSectorAnalyzer] 同花顺行业板块获取成功: ${industries.length}个`);
        cacheSet(cacheKey, industries);
        return industries;
    } catch (err) {
        console.error('[HotSectorAnalyzer] 同花顺行业板块列表获取失败:', err);
        return [];
    }
}

/** 保存每日板块数据快照（用于历史回溯） */
function saveDailySnapshot(type: 'concept' | 'industry', data: any[]): void {
    try {
        ensureCacheDir();
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const fp = path.join(CACHE_DIR, `snapshot_${type}_${today}.json`);
        if (!fs.existsSync(fp)) {
            fs.writeFileSync(fp, JSON.stringify(data), 'utf-8');
        }
    } catch { /* ignore */ }
}

/** 获取板块历史数据（通过Tushare ths_daily） */
async function getBoardHistory(boardName: string, days: number = 10): Promise<any[]> {
    const cacheKey = `board_history_${boardName}_${days}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const nameMap = await getThsIndexNameMap();
    const tsCode = nameMap.get(boardName);
    if (!tsCode) return [];

    try {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days * 2);
        const startDateStr = startDate.toISOString().slice(0, 10).replace(/-/g, '');

        const hist = await getThsDaily(tsCode, startDateStr);
        const result = hist
            .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
            .slice(-days)
            .map(h => ({
                date: String(h.trade_date),
                open: Number(h.open) || 0,
                close: Number(h.close) || 0,
                high: Number(h.high) || 0,
                low: Number(h.low) || 0,
                volume: Number(h.vol) || 0,
                amount: Number(h.vol) || 0, // ths_daily无成交额，用成交量近似
                change_pct: Number(h.pct_change) || 0,
            }));

        if (result.length > 0) {
            cacheSet(cacheKey, result);
        }
        return result;
    } catch (err) {
        console.warn(`[HotSectorAnalyzer] getBoardHistory失败(${boardName}):`, (err as Error).message);
        return [];
    }
}

/** 全市场日线行情缓存（按日期，1次调用获取全市场） */
let dailyByDateCache: { date: string; data: Map<string, DailyPriceRow> } | null = null;

async function getDailyByDateCached(tradeDate: string): Promise<Map<string, DailyPriceRow>> {
    if (dailyByDateCache && dailyByDateCache.date === tradeDate) {
        return dailyByDateCache.data;
    }
    const rows = await getDailyByDate(tradeDate);
    const map = new Map<string, DailyPriceRow>();
    for (const row of rows) {
        map.set(row.ts_code, row);
    }
    if (map.size > 0) {
        dailyByDateCache = { date: tradeDate, data: map };
        console.log(`[HotSectorAnalyzer] 全市场日线行情缓存: ${map.size}只 (${tradeDate})`);
    } else {
        console.log(`[HotSectorAnalyzer] ${tradeDate} 无行情数据（可能非交易日）`);
    }
    return map;
}

/** 获取最近交易日的全市场行情（自动跳过非交易日） */
async function getLatestDailyMap(): Promise<{ date: string; data: Map<string, DailyPriceRow> }> {
    // 如果已有缓存，直接返回
    if (dailyByDateCache && dailyByDateCache.data.size > 0) {
        return { date: dailyByDateCache.date, data: dailyByDateCache.data };
    }

    // 尝试最近3天
    for (let offset = 0; offset < 3; offset++) {
        const d = new Date();
        d.setDate(d.getDate() - offset);
        const dateStr = formatDate(d);
        const map = await getDailyByDateCached(dateStr);
        if (map.size > 0) {
            return { date: dateStr, data: map };
        }
    }
    return { date: '', data: new Map() };
}

/** 获取板块成分股（优先使用Tushare ths_member + daily，回退到HTML爬虫） */
async function getBoardConstituents(boardCode: string, boardType: 'concept' | 'industry' = 'concept', pageSize: number = 100): Promise<any[]> {
    const cacheKey = `board_cons_${boardType}_${boardCode}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    // ===== 优先使用Tushare ths_member + daily =====
    try {
        // boardCode可能是6位数字（同花顺代码）或带后缀的ts_code（如881101.TI）
        let tsCode = boardCode;
        if (!boardCode.includes('.')) {
            // 无后缀，需要查找对应的ts_code
            const indexMap = await getThsIndexNameMap();
            for (const [, code] of indexMap.entries()) {
                if (code.startsWith(boardCode + '.')) {
                    tsCode = code;
                    break;
                }
            }
        }

        // 获取成分股列表
        const members = await getThsMember(tsCode);
        if (members.length > 0) {
            // 获取当日行情（全市场缓存，自动跳过非交易日）
            const { data: dailyMap } = await getLatestDailyMap();

            // 组装成分股数据（含涨幅）
            const result: any[] = [];
            for (const m of members) {
                if (m.is_new === 'N') continue;  // 跳过已剔除的
                const dailyRow = dailyMap.get(m.con_code);
                const code6 = m.con_code.replace(/\.(SZ|SH|BJ)$/, '');
                result.push({
                    code: code6,
                    name: m.con_name,
                    price: dailyRow?.close || 0,
                    change_pct: dailyRow?.pct_chg || 0,
                    industry: '',
                });
            }

            // 按涨幅降序排序
            result.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));

            console.log(`[HotSectorAnalyzer] Tushare ${boardType} ${boardCode} 成分股: ${result.length}只`);
            if (result.length > 0) {
                cacheSet(cacheKey, result);
                return result.slice(0, pageSize);
            }
        }
    } catch (err) {
        console.warn(`[HotSectorAnalyzer] Tushare ${boardType} ${boardCode} 成分股获取失败:`, (err as Error).message);
    }

    // ===== Fallback：HTML爬虫 =====
    if (boardType === 'concept') {
        try {
            const result = await parseConceptConstituents(boardCode, pageSize);
            if (result.length > 0) {
                cacheSet(cacheKey, result);
                return result;
            }
        } catch (err) {
            console.warn(`[HotSectorAnalyzer] 概念${boardCode}成分股获取失败:`, (err as Error).message);
        }
    } else {
        try {
            const result = await parseIndustryConstituents(boardCode, pageSize);
            if (result.length > 0) {
                cacheSet(cacheKey, result);
            }
            return result;
        } catch (err) {
            console.warn(`[HotSectorAnalyzer] 行业${boardCode}成分股HTML解析失败:`, (err as Error).message);
        }
    }
    return [];
}

/** 解析概念板块成分股（使用同花顺board/all接口） */
async function parseConceptConstituents(boardCode: string, pageSize: number): Promise<any[]> {
    const result: any[] = [];
    const maxPages = Math.ceil(pageSize / 20);

    for (let page = 1; page <= maxPages; page++) {
        const url = `https://q.10jqka.com.cn/index/index/board/all/field/zdf/order/desc/page/${page}/ajax/1/code/${boardCode}`;
        const html = await fetchThsHtml(url);
        const $ = cheerio.load(html);

        let found = 0;
        $('table tbody tr').each((i, el) => {
            const cells = $(el).find('td');
            if (cells.length < 5) return;

            const code = cells.eq(1).text().trim();
            const name = cells.eq(2).find('a').text().trim() || cells.eq(2).text().trim();
            const price = parseFloat(cells.eq(3).text().trim()) || 0;
            const changePct = parseFloat(cells.eq(4).text().trim()) || 0;

            if (code && name && /^\d{6}$/.test(code)) {
                result.push({
                    code,
                    name,
                    price,
                    change_pct: changePct,
                    industry: '',
                });
                found++;
            }
        });

        if (found === 0) break;
    }

    console.log(`[HotSectorAnalyzer] 概念${boardCode}成分股获取: ${result.length}只`);
    return result;
}

/** 解析行业板块成分股（使用同花顺行业详情页） */
async function parseIndustryConstituents(boardCode: string, pageSize: number): Promise<any[]> {
    const result: any[] = [];
    const maxPages = Math.ceil(pageSize / 20);

    for (let page = 1; page <= maxPages; page++) {
        const url = page > 1
            ? `https://q.10jqka.com.cn/thshy/detail/code/${boardCode}/page/${page}/`
            : `https://q.10jqka.com.cn/thshy/detail/code/${boardCode}/`;
        const html = await fetchThsHtml(url);
        const $ = cheerio.load(html);

        let found = 0;
        $('table tbody tr').each((i, el) => {
            const cells = $(el).find('td');
            if (cells.length < 5) return;

            const code = cells.eq(1).text().trim();
            const name = cells.eq(2).find('a').text().trim() || cells.eq(2).text().trim();
            const price = parseFloat(cells.eq(3).text().trim()) || 0;
            const changePct = parseFloat(cells.eq(4).text().trim()) || 0;

            if (code && name && /^\d{6}$/.test(code)) {
                result.push({
                    code,
                    name,
                    price,
                    change_pct: changePct,
                    industry: '',
                });
                found++;
            }
        });

        if (found === 0) break;
    }

    console.log(`[HotSectorAnalyzer] 行业${boardCode}成分股获取: ${result.length}只`);
    return result;
}

/** 获取板块涨幅排名前N的股票 */
async function getBoardTopStocks(boardCode: string, topN: number = 5, boardType: 'concept' | 'industry' = 'concept'): Promise<any[]> {
    const cacheKey = `board_top_${boardType}_${boardCode}_${topN}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    // 按指定类型获取成分股（已按涨幅排序）
    const stocks = await getBoardConstituents(boardCode, boardType, topN);

    const result = stocks.slice(0, topN).map(s => ({
        code: s.code,
        name: s.name,
        price: s.price,
        change_pct: s.change_pct,
        industry: s.industry || '',
        net_inflow: 0,
        turnover_rate: 0,
    }));

    if (result.length > 0) {
        cacheSet(cacheKey, result);
    }
    return result;
}

function formatDate(d: Date): string {
    return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// ==================== 风口概念板块识别 ====================

interface HotConcept {
    code: string;
    name: string;
    type: string;
    frequency: number;
    avg_change: number;
    today_change: number;
    amount_trend: number;
    net_inflow: number;  // 板块主力净流入（万元，来自东方财富）
    driver: string;
    leading_stock: string;
    leading_change: number;
    up_count: number;
    down_count: number;
    score: number;
}

/** AI相关板块关键词（基础词库，用于快速匹配） */
const AI_RELATED_KEYWORDS = [
    'AI', '人工智能', '芯片', '半导体', '光刻', 'CPO', 'PCB', '光纤', '光模块',
    '存储', '算力', 'GPU', 'FPGA', 'HBM', 'MLCC', '玻璃基板', '培育钻石',
    '物理AI', '铜缆', '太赫兹', '光通信', '激光', 'EDA', '封测',
    '大基金', '集成电路', '晶圆', '刻蚀', '薄膜', '溅射', '电子化学品',
    '消费电子', '光学光电子', '通信设备', '计算机设备', '机器人',
    '自动化', '智能制造', '工业互联', '数据中心', '云计算',
    '量子', '脑机', '边缘计算', '5G', '6G', '物联网',
    '鸿蒙', '信创', '国产替代', '国产芯片',
    // 补充关键词
    'TGV', '先进封装', 'CoWoS', 'HBM3', '硅光', '光电', '服务器',
    '液冷', '散热', '电源管理', 'MCU', 'SOC', 'DSP', 'ADC',
    '连接器', '继电器', '传感器', '摄像头', '显示', 'OLED', 'MicroLED',
    'MiniLED', 'VR', 'AR', 'MR', 'XR', '智能穿戴', '智能汽车',
    '自动驾驶', '激光雷达', '毫米波', '射频', '天线', '基站',
    '交换机', '路由器', '网络安全', '数据要素', 'AIGC', '大模型',
    'ChatGPT', '文心', '通义', '智谱', '深度学习', '机器学习',
    '神经网络', '知识图谱', '自然语言', '语音识别', '计算机视觉',
    '具身智能', '人形机器人', '工业机器人', '服务机器人',
    '固态电池', '钠电池', '氢能', '核聚变', '超导',
    '碳化硅', '氮化镓', '砷化镓', '磷化铟', '第二代半导体', '第三代半导体',
    '光刻胶', '抛光', '清洗', '检测', '量测',
];

/** AI板块判断缓存文件路径（持久化，重启不丢失） */
const AI_SECTOR_CACHE_PATH = path.join(CACHE_DIR, 'ai_sector_judgment_cache.json');

/** AI板块判断缓存：{ 板块名: { isAIRelated: boolean, judgedAt: number } } */
let aiSectorJudgmentCache: Map<string, { isAIRelated: boolean; judgedAt: number }> | null = null;

/** 加载AI板块判断缓存 */
function loadAiSectorJudgmentCache(): Map<string, { isAIRelated: boolean; judgedAt: number }> {
    if (aiSectorJudgmentCache) return aiSectorJudgmentCache;
    try {
        ensureCacheDir();
        if (fs.existsSync(AI_SECTOR_CACHE_PATH)) {
            const raw = fs.readFileSync(AI_SECTOR_CACHE_PATH, 'utf-8');
            const obj = JSON.parse(raw);
            aiSectorJudgmentCache = new Map(Object.entries(obj));
            console.log(`[HotSectorAnalyzer] AI板块判断缓存加载: ${aiSectorJudgmentCache.size}条`);
        } else {
            aiSectorJudgmentCache = new Map();
        }
    } catch {
        aiSectorJudgmentCache = new Map();
    }
    return aiSectorJudgmentCache;
}

/** 保存AI板块判断缓存 */
function saveAiSectorJudgmentCache(): void {
    if (!aiSectorJudgmentCache) return;
    try {
        ensureCacheDir();
        const obj = Object.fromEntries(aiSectorJudgmentCache);
        fs.writeFileSync(AI_SECTOR_CACHE_PATH, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
        console.warn('[HotSectorAnalyzer] AI板块判断缓存保存失败:', err);
    }
}

/** 基础关键词快速判断 */
function isAIRelatedByKeyword(name: string): boolean {
    const upperName = name.toUpperCase();
    return AI_RELATED_KEYWORDS.some(kw => upperName.includes(kw.toUpperCase()));
}

/** 调用AI判断板块是否与AI相关（带缓存，7天内不重复调用） */
async function isAIRelatedByAI(name: string): Promise<boolean | null> {
    const cache = loadAiSectorJudgmentCache();
    const cached = cache.get(name);
    const SEVEN_DAYS = 7 * 24 * 3600 * 1000;

    // 缓存7天内有效
    if (cached && Date.now() - cached.judgedAt < SEVEN_DAYS) {
        return cached.isAIRelated;
    }

    // 检查AI API是否可用
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) return null;

    let apiBase = process.env.OPENAI_API_BASE_URL || process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
    const chatUrl = apiBase.includes('/chat/completions') ? apiBase : `${apiBase}/chat/completions`;
    const model = process.env.AI_MODEL || 'gpt-4o-mini';

    try {
        const prompt = `判断以下A股概念板块是否与AI（人工智能）产业链相关。包括AI上游（芯片/算力/存储/光刻/PCB/元件/材料等）、AI中游（模型/算法/数据/云计算等）、AI下游（应用/机器人/自动驾驶/消费电子等）。

板块名称：${name}

只回答"是"或"否"，不要其他文字。`;

        const resp = await sessionFetch(chatUrl, {
            method: 'POST',
            signal: AbortSignal.timeout(20000),  // 20秒超时，32B模型响应较慢
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0,
                max_tokens: 10,
            }),
        });

        if (!resp.ok) return null;

        const data = await resp.json() as any;
        const answer = (data.choices?.[0]?.message?.content || '').trim();
        const isRelated = answer.includes('是');

        // 缓存结果
        cache.set(name, { isAIRelated: isRelated, judgedAt: Date.now() });
        saveAiSectorJudgmentCache();
        console.log(`[HotSectorAnalyzer] AI判断板块"${name}"${isRelated ? '是' : '否'}AI相关`);
        return isRelated;
    } catch (err) {
        console.warn(`[HotSectorAnalyzer] AI判断板块"${name}"失败:`, (err as Error).message);
        return null;
    }
}

/** 判断板块名称是否与AI相关（关键词优先，未命中则调用AI） */
async function isAIRelatedSector(name: string): Promise<boolean> {
    // 1. 基础关键词快速匹配
    if (isAIRelatedByKeyword(name)) return true;

    // 2. 查询AI判断缓存（可能命中旧缓存）
    const cache = loadAiSectorJudgmentCache();
    const cached = cache.get(name);
    const SEVEN_DAYS = 7 * 24 * 3600 * 1000;
    if (cached && Date.now() - cached.judgedAt < SEVEN_DAYS) {
        return cached.isAIRelated;
    }

    // 3. 调用AI判断（异步，不阻塞主流程，返回null则不确定）
    const aiResult = await isAIRelatedByAI(name);
    if (aiResult !== null) return aiResult;

    // 4. AI不可用时，保守返回false（不匹配的不纳入）
    return false;
}

/** 从同花顺板块轮动API获取板块轮动数据（截取指定天数） */
export async function fetchBlockRotationData(days: number = 20): Promise<{
    sectorStats: Map<string, { name: string; code: string; frequency: number; avgZf5: number; latestZf5: number }>;
    rawData: any[];
}> {
    const cacheKey = `block_rotation_${days}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
        console.log('[HotSectorAnalyzer] 使用缓存的板块轮动数据');
        return cached;
    }

    const url = 'https://eq.10jqka.com.cn/pick/block/block_hotspot/hotspot/v1/hot_block_list?type=con&field=zf5';
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://l2.10jqka.com.cn/hottrack/public/dist/index.html#/marketCondition',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    };

    console.log('[HotSectorAnalyzer] 正在从同花顺板块轮动API获取数据...');
    
    // 添加重试机制：最多重试 3 次
    let response: Response | null = null;
    let lastError: Error | null = null;
    const MAX_RETRIES = 3;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            response = await sessionFetch(url, { headers });
            if (response.ok) break; // 成功则跳出循环
            
            lastError = new Error(`同花顺板块轮动API请求失败: HTTP ${response.status}`);
            console.warn(`[HotSectorAnalyzer] API请求失败 (尝试 ${attempt}/${MAX_RETRIES}): HTTP ${response.status}`);
            
            if (attempt < MAX_RETRIES) {
                // 等待一段时间后重试
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
        } catch (err) {
            lastError = err as Error;
            console.warn(`[HotSectorAnalyzer] API请求异常 (尝试 ${attempt}/${MAX_RETRIES}):`, (err as Error).message);
            
            if (attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
        }
    }
    
    // 所有重试失败后，返回空数据而非抛出异常
    if (!response || !response.ok) {
        console.error('[HotSectorAnalyzer] 同花顺板块轮动API多次重试失败，返回空数据:', lastError?.message);
        return { sectorStats: new Map(), rawData: [] };
    }
    
    const json = await response.json() as any;

    if (json.status_code !== 0 || !json.data?.data_list) {
        console.error(`[HotSectorAnalyzer] 同花顺板块轮动API返回异常: ${json.status_msg}，返回空数据`);
        return { sectorStats: new Map(), rawData: [] };
    }

    // 截取指定天数的数据
    const allDataLists = json.data.data_list;
    const dataLists = allDataLists.slice(0, days);
    console.log(`[HotSectorAnalyzer] 板块轮动API返回 ${allDataLists.length} 天数据，截取前 ${dataLists.length} 天`);

    // 统计每个板块的上榜次数和涨幅
    const sectorStats = new Map<string, { name: string; code: string; frequency: number; avgZf5: number; latestZf5: number }>();

    for (const dayData of dataLists) {
        const blockList = dayData.block_list || [];
        for (const block of blockList) {
            const key = block.name;
            const zf5 = parseFloat(block.info?.zf5 || '0');

            if (!sectorStats.has(key)) {
                sectorStats.set(key, {
                    name: block.name,
                    code: block.code,
                    frequency: 1,
                    avgZf5: zf5,
                    latestZf5: zf5,
                });
            } else {
                const stat = sectorStats.get(key)!;
                stat.frequency += 1;
                stat.avgZf5 = (stat.avgZf5 * (stat.frequency - 1) + zf5) / stat.frequency;
                stat.latestZf5 = zf5; // 保留最新一天的涨幅
            }
        }
    }

    console.log(`[HotSectorAnalyzer] 板块轮动统计完成: ${sectorStats.size} 个板块`);

    const result = { sectorStats, rawData: dataLists };
    cacheSet(cacheKey, result);
    return result;
}

/** 从同花顺概念板块页面爬取龙头股 - 使用分布式爬虫 */
async function fetchConceptLeadingStocks(boardCode: string): Promise<{ code: string; name: string }[]> {
    const cacheKey = `concept_leading_${boardCode}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const url = `https://basic.10jqka.com.cn/48/${boardCode}/`;
    try {
        const html = await thsCrawler.fetchHtml(url);
        console.log(`[HotSectorAnalyzer] 概念${boardCode}页面HTML长度: ${html.length}`);
        
        const $ = cheerio.load(html);

        const leadingStocks: { code: string; name: string }[] = [];

        // 策略1：从 topStock 隐藏字段提取龙头股代码
        const topStockAttr = $('input.topStock').attr('topstock') || $('input.topStock').attr('topStock') || '';
        console.log(`[HotSectorAnalyzer] 概念${boardCode} topstock字段: "${topStockAttr}"`);
        
        const topStockCodes = topStockAttr.split(',').filter((c: string) => c && /^\d{6}$/.test(c));
        console.log(`[HotSectorAnalyzer] 概念${boardCode} 解析后的龙头股代码: ${topStockCodes.join(', ') || '无'}`);
        
        if (topStockCodes.length > 0) {
            for (const code of topStockCodes) {
                // 尝试多种方法获取股票名称
                let name = '';
                
                // 方法1: 从 a[code="${code}"] 获取
                const nameEl1 = $(`a[code="${code}"]`).first();
                name = nameEl1.text().trim();
                console.log(`[HotSectorAnalyzer] 概念${boardCode} 方法1(${code}): ${name || '未找到'}`);
                
                // 方法2: 如果方法1失败，从 a[href*="${code}"] 获取
                if (!name) {
                    const nameEl2 = $(`a[href*="${code}"]`).first();
                    name = nameEl2.text().trim();
                    console.log(`[HotSectorAnalyzer] 概念${boardCode} 方法2(${code}): ${name || '未找到'}`);
                }
                
                // 方法3: 从表格中查找（排除新闻链接）
                if (!name) {
                    $('table').find('a').each((i, a) => {
                        const href = $(a).attr('href') || '';
                        const text = $(a).text().trim();
                        if (href.includes(code) && text.length > 0 && text.length < 20 && !href.includes('news')) {
                            name = text;
                            console.log(`[HotSectorAnalyzer] 概念${boardCode} 方法3(${code}): ${name}`);
                            return false; // 找到第一个就停止
                        }
                    });
                }
                
                // 即使名称为空，也添加代码（后续可以通过数据库查询补充名称）
                leadingStocks.push({ code, name: name || code });
                console.log(`[HotSectorAnalyzer] 概念${boardCode} 添加龙头股: ${code} - ${name || code}`);
            }
        }

        // 策略2：从 span.hltip + a.jumpto 区域提取
        if (leadingStocks.length === 0) {
            $('span.hltip').each((i, el) => {
                const text = $(el).text().trim();
                if (text.includes('龙头股')) {
                    const parent = $(el).closest('td');
                    parent.find('a.jumpto').each((j, a) => {
                        const code = $(a).attr('code') || '';
                        const name = $(a).text().trim();
                        if (code && name && /^\d{6}$/.test(code)) leadingStocks.push({ code, name });
                    });
                    return false;
                }
            });
        }

        // 策略3：从基本资料表格中"龙头股"行提取（同花顺概念板块页面标准结构）
        if (leadingStocks.length === 0) {
            $('table.m_table, table.boardinfotable, div.boardinfo table').find('tr, th, td').each((i, el) => {
                const text = $(el).text().trim();
                if (text.includes('龙头股')) {
                    // 找到"龙头股"所在行，提取其中的链接
                    const row = $(el).closest('tr');
                    row.find('a').each((j, a) => {
                        const href = $(a).attr('href') || '';
                        const name = $(a).text().trim();
                        // 从href中提取股票代码，如 /300801/ 或 stockpage.10jqka.com.cn/300801
                        const codeMatch = href.match(/(\d{6})/);
                        const code = codeMatch ? codeMatch[1] : '';
                        if (code && name && /^\d{6}$/.test(code)) {
                            // 去重
                            if (!leadingStocks.some(s => s.code === code)) {
                                leadingStocks.push({ code, name });
                            }
                        }
                    });
                    return false;
                }
            });
        }

        // 策略4：从排名表提取（概念股排名表中排名靠前的即为龙头股）
        if (leadingStocks.length === 0) {
            $('table.m_table').find('a').each((i, a) => {
                const href = $(a).attr('href') || '';
                const name = $(a).text().trim();
                const codeMatch = href.match(/(\d{6})/);
                const code = codeMatch ? codeMatch[1] : '';
                if (code && name && /^\d{6}$/.test(code)) {
                    if (!leadingStocks.some(s => s.code === code)) {
                        leadingStocks.push({ code, name });
                    }
                }
                // 最多取前3只作为龙头股
                if (leadingStocks.length >= 3) return false;
            });
        }

        console.log(`[HotSectorAnalyzer] 概念${boardCode}龙头股: ${leadingStocks.map(s => s.name).join(', ') || '无'}`);
        if (leadingStocks.length > 0) {
            cacheSet(cacheKey, leadingStocks);
        }
        return leadingStocks;
    } catch (err) {
        console.warn(`[HotSectorAnalyzer] 概念${boardCode}龙头股爬取失败:`, (err as Error).message);
        return [];
    }
}

/** 从同花顺概念板块页面爬取成分股列表 - 使用分布式爬虫 */
async function fetchConceptConstituentsFromPage(boardCode: string): Promise<{ code: string; name: string; exchange: string }[]> {
    const cacheKey = `concept_page_cons_${boardCode}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const url = `https://basic.10jqka.com.cn/48/${boardCode}/`;
    try {
        const html = await thsCrawler.fetchHtml(url);

        // 从 concept_data 隐藏div提取成分股JSON
        const match = html.match(/id="concept_data"[^>]*>([\s\S]*?)<\/div>/);
        if (!match) return [];

        const data = JSON.parse(match[1]);
        const listData = data.result?.listdata;
        if (!listData) return [];

        const dates = Object.keys(listData);
        if (dates.length === 0) return [];

        const stocks = listData[dates[0]].map((s: string[]) => ({
            code: s[0],
            name: s[1],
            exchange: s[2] || '',
        })).filter((s: { code: string; name: string }) => s.code && s.name && /^\d{6}$/.test(s.code));

        console.log(`[HotSectorAnalyzer] 概念${boardCode}页面成分股: ${stocks.length}只`);
        if (stocks.length > 0) {
            cacheSet(cacheKey, stocks);
        }
        return stocks;
    } catch (err) {
        console.warn(`[HotSectorAnalyzer] 概念${boardCode}页面成分股爬取失败:`, (err as Error).message);
        return [];
    }
}

async function identifyHotConcepts(topN: number = 8, minFrequency: number = 3, days: number = 20): Promise<HotConcept[]> {
    const cacheKey = `hot_concepts_${days}_${minFrequency}_${topN}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
        console.log('[HotSectorAnalyzer] 使用缓存的风口概念数据');
        return cached;
    }

    // ===== 使用同花顺板块轮动API =====
    console.log('[HotSectorAnalyzer] 使用同花顺板块轮动表筛选风口板块');
    const { sectorStats } = await fetchBlockRotationData(days);

    // 筛选AI相关板块（关键词优先，未命中则调用AI判断）
    const aiSectors: { name: string; code: string; frequency: number; avgZf5: number; latestZf5: number }[] = [];
    // 先用关键词快速筛选，收集未命中的板块
    const unknownSectors: { name: string; code: string; frequency: number; avgZf5: number; latestZf5: number }[] = [];
    for (const [, stat] of sectorStats) {
        if (isAIRelatedByKeyword(stat.name)) {
            aiSectors.push(stat);
        } else {
            unknownSectors.push(stat);
        }
    }
    // 对未命中关键词的板块，查询AI判断缓存或调用AI（并发执行，限制并发数避免压垮AI API）
    const AI_JUDGE_CONCURRENCY = 5;
    for (let i = 0; i < unknownSectors.length; i += AI_JUDGE_CONCURRENCY) {
        const batch = unknownSectors.slice(i, i + AI_JUDGE_CONCURRENCY);
        const results = await Promise.all(
            batch.map(async stat => ({ stat, isRelated: await isAIRelatedSector(stat.name) }))
        );
        for (const { stat, isRelated } of results) {
            if (isRelated) aiSectors.push(stat);
        }
    }
    console.log(`[HotSectorAnalyzer] AI相关板块: ${aiSectors.length} 个 (共 ${sectorStats.size} 个板块)`);

    // 按上榜频次排序，频次相同按平均涨幅排序
    aiSectors.sort((a, b) => b.frequency - a.frequency || b.avgZf5 - a.avgZf5);

    // 构建HotConcept列表
    const candidates: HotConcept[] = aiSectors.map(sector => {
        // 评分：上榜频次(40%) + 资金净流入(30%) + 平均涨幅(20%) + 最新涨幅(10%)
        const freqScore = Math.min(10, sector.frequency * 1.2);
        const avgChangeScore = Math.min(10, Math.abs(sector.avgZf5) * 1.5);
        const latestChangeScore = Math.min(10, Math.abs(sector.latestZf5) * 1.0);
        // 资金评分初始为0，补充资金数据后重新计算
        const score = Math.round((freqScore * 4.0 + avgChangeScore * 2.0 + latestChangeScore * 1.0) * 100) / 100;

        return {
            code: sector.code,
            name: sector.name,
            type: 'concept',
            frequency: sector.frequency,
            avg_change: Math.round(sector.avgZf5 * 100) / 100,
            today_change: Math.round(sector.latestZf5 * 100) / 100,
            amount_trend: 0,
            net_inflow: 0,
            driver: `20日板块轮动上榜${sector.frequency}次`,
            leading_stock: '--',
            leading_change: 0,
            up_count: 0,
            down_count: 0,
            score,
        };
    });

    // 筛选上榜频次 >= minFrequency 的概念
    let hotConcepts = candidates.filter(c => c.frequency >= minFrequency);
    if (hotConcepts.length < topN) {
        hotConcepts = candidates.filter(c => c.frequency >= Math.max(1, minFrequency - 1));
    }
    if (hotConcepts.length < topN) {
        hotConcepts = candidates
            .sort((a, b) => b.score - a.score)
            .slice(0, topN);
    }

    hotConcepts.sort((a, b) => b.score - a.score);
    const result = hotConcepts.slice(0, topN);

    console.log(`[HotSectorAnalyzer] 风口板块筛选完成: ${result.length} 个`);
    for (const c of result) {
        console.log(`  ${c.name}: 上榜${c.frequency}次, 均涨幅${c.avg_change}%, 评分${c.score}`);
    }

    // 从同花顺概念板块页面并发爬取龙头股
    const leadingResults = await thsCrawler.crawlAll(
        result.map(concept => ({
            url: `https://basic.10jqka.com.cn/48/${concept.code}/`,
            handler: async (html: string) => {
                const $ = cheerio.load(html);
                const stocks: { code: string; name: string }[] = [];

                // 策略1：从 topStock 隐藏字段提取
                const topStockAttr = $('input.topStock').attr('topStock') || '';
                const topStockCodes = topStockAttr.split(',').filter((c: string) => c && /^\d{6}$/.test(c));
                if (topStockCodes.length > 0) {
                    for (const code of topStockCodes) {
                        const name = $(`a[code="${code}"]`).first().text().trim();
                        if (name) stocks.push({ code, name });
                    }
                }

                // 策略2：从 span.hltip + a.jumpto 区域提取
                if (stocks.length === 0) {
                    $('span.hltip').each((i, el) => {
                        if ($(el).text().trim().includes('龙头股')) {
                            $(el).closest('td').find('a.jumpto').each((j, a) => {
                                const code = $(a).attr('code') || '';
                                const name = $(a).text().trim();
                                if (code && name && /^\d{6}$/.test(code)) stocks.push({ code, name });
                            });
                            return false;
                        }
                    });
                }

                // 策略3：从基本资料表格中"龙头股"行提取
                if (stocks.length === 0) {
                    $('table.m_table, table.boardinfotable, div.boardinfo table').find('tr, th, td').each((i, el) => {
                        if ($(el).text().trim().includes('龙头股')) {
                            $(el).closest('tr').find('a').each((j, a) => {
                                const href = $(a).attr('href') || '';
                                const name = $(a).text().trim();
                                const codeMatch = href.match(/(\d{6})/);
                                const code = codeMatch ? codeMatch[1] : '';
                                if (code && name && /^\d{6}$/.test(code) && !stocks.some(s => s.code === code)) {
                                    stocks.push({ code, name });
                                }
                            });
                            return false;
                        }
                    });
                }

                // 策略4：从排名表提取排名靠前的股票
                if (stocks.length === 0) {
                    $('table.m_table').find('a').each((i, a) => {
                        const href = $(a).attr('href') || '';
                        const name = $(a).text().trim();
                        const codeMatch = href.match(/(\d{6})/);
                        const code = codeMatch ? codeMatch[1] : '';
                        if (code && name && /^\d{6}$/.test(code) && !stocks.some(s => s.code === code)) {
                            stocks.push({ code, name });
                        }
                        if (stocks.length >= 3) return false;
                    });
                }

                return stocks;
            },
        }))
    );
    for (let i = 0; i < result.length; i++) {
        const stocks = leadingResults[i];
        if (stocks && stocks.length > 0) {
            result[i].leading_stock = stocks[0].name;
            result[i].leading_change = 0;
            // 缓存龙头股结果
            cacheSet(`concept_leading_${result[i].code}`, stocks);
        }
    }

    // 从Tushare moneyflow_cnt_ths获取资金流向数据
    try {
        const today = formatDate(new Date());
        const moneyflowData = await getMoneyflowCntThs(today);
        // 同时用ts_code和去掉后缀的code建立索引，兼容不同code格式
        const mfMap = new Map(moneyflowData.map(r => [r.ts_code, r]));
        const mfMapByShortCode = new Map(moneyflowData.map(r => [r.ts_code.replace(/\.(TI|SI)$/, ''), r]));
        for (const concept of result) {
            // 优先精确匹配，再尝试短码匹配
            const mf = mfMap.get(concept.code) || mfMapByShortCode.get(concept.code);
            if (mf) {
                // net_amount单位是亿元，转为万元存储（前端formatNetInflow会转换显示）
                const netAmountWan = (mf.net_amount || 0) * 10000;
                concept.net_inflow = netAmountWan;
                concept.amount_trend = netAmountWan;
                // 用lead_stock补充领涨股（如果爬取失败）
                if (concept.leading_stock === '--' && mf.lead_stock) {
                    concept.leading_stock = mf.lead_stock;
                    concept.leading_change = mf.pct_change_stock || 0;
                }
            }
        }
        console.log(`[HotSectorAnalyzer] 资金流向数据获取成功: ${moneyflowData.length}条`);

        // 补充资金数据后重新计算评分
        // 收集所有板块的net_inflow用于归一化
        const inflows = result.map(c => c.net_inflow).filter(v => v !== 0);
        const hasFundData = inflows.length > 0;

        if (hasFundData) {
            // 有资金数据：评分 = 频次(40%) + 资金净流入(30%) + 平均涨幅(20%) + 最新涨幅(10%)
            const maxInflow = Math.max(...inflows);
            const minOutflow = Math.min(...inflows);
            const absMax = Math.max(Math.abs(maxInflow), Math.abs(minOutflow), 1);

            for (const concept of result) {
                const freqScore = Math.min(10, concept.frequency * 1.2);
                const avgChangeScore = Math.min(10, Math.abs(concept.avg_change) * 1.5);
                const latestChangeScore = Math.min(10, Math.abs(concept.today_change) * 1.0);

                let fundScore = 5;
                if (concept.net_inflow > 0) {
                    fundScore = 5 + 5 * Math.min(1, concept.net_inflow / absMax);
                } else if (concept.net_inflow < 0) {
                    fundScore = 5 - 5 * Math.min(1, Math.abs(concept.net_inflow) / absMax);
                }

                concept.score = Math.round((freqScore * 4.0 + fundScore * 3.0 + avgChangeScore * 2.0 + latestChangeScore * 1.0) * 100) / 100;
            }
        } else {
            // 无资金数据：回退到旧逻辑 评分 = 频次(60%) + 平均涨幅(25%) + 最新涨幅(15%)
            for (const concept of result) {
                const freqScore = Math.min(10, concept.frequency * 1.2);
                const avgChangeScore = Math.min(10, Math.abs(concept.avg_change) * 1.5);
                const latestChangeScore = Math.min(10, Math.abs(concept.today_change) * 1.0);
                concept.score = Math.round((freqScore * 6.0 + avgChangeScore * 2.5 + latestChangeScore * 1.5) * 100) / 100;
            }
        }
    } catch (err: any) {
        console.warn(`[HotSectorAnalyzer] 资金流向数据获取失败: ${err?.message || err}`);
    }

    cacheSet(cacheKey, result);
    return result;
}

// ==================== 概念→行业映射 ====================

interface IndustryMapping {
    name: string;
    code: string;
    overlap_count: number;
    overlap_ratio: number;
    stock_count: number;
    overlap_codes: string[];
}

/** 概念→行业映射结果（含强关联和全排名） */
interface ConceptIndustryResult {
    strongly_related: IndustryMapping[];   // 强关联行业（Top 1-3，带差距判断）
    all_ranked: IndustryMapping[];         // 全部排名（用于上下游传导查找）
}

/** 构建股票→行业反向映射（一次构建，全分析复用） */
async function buildStockIndustryMap(): Promise<Map<string, { name: string; code: string }[]>> {
    const cacheKey = 'stock_industry_reverse_map';
    const SEVEN_DAYS = 7 * 24 * 3600 * 1000;

    // 检查缓存是否在7天内
    try {
        ensureCacheDir();
        const fp = path.join(CACHE_DIR, `${cacheKey}.json`);
        if (fs.existsSync(fp)) {
            const stat = fs.statSync(fp);
            if (Date.now() - stat.mtimeMs < SEVEN_DAYS) {
                const raw = fs.readFileSync(fp, 'utf-8');
                const cached = JSON.parse(raw);
                const map = new Map<string, { name: string; code: string }[]>();
                for (const [k, v] of Object.entries(cached as Record<string, { name: string; code: string }[]>)) {
                    map.set(k, v);
                }
                return map;
            }
            console.log('[HotSectorAnalyzer] 股票→行业反向映射缓存已过期(>7天)，重新构建');
        }
    } catch { /* ignore */ }

    const industries = await getIndustryBoards();
    const map = new Map<string, { name: string; code: string }[]>();

    console.log(`[HotSectorAnalyzer] 构建股票→行业反向映射，共${industries.length}个行业...`);

    // 并发获取所有行业成分股（5个一批）
    const batchSize = 5;
    for (let i = 0; i < industries.length; i += batchSize) {
        const batch = industries.slice(i, i + batchSize);
        await Promise.all(batch.map(async (ind) => {
            const indCons = await getBoardConstituents(ind.code, 'industry', 500);
            for (const s of indCons) {
                if (!map.has(s.code)) {
                    map.set(s.code, []);
                }
                map.get(s.code)!.push({ name: ind.name, code: ind.code });
            }
        }));
    }

    // 缓存反向映射（直接写文件，不受1小时TTL限制）
    const obj: Record<string, { name: string; code: string }[]> = {};
    for (const [k, v] of map) { obj[k] = v; }
    try {
        ensureCacheDir();
        const fp = path.join(CACHE_DIR, `${cacheKey}.json`);
        fs.writeFileSync(fp, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
        console.warn('[HotSectorAnalyzer] 反向映射缓存写入失败:', err);
    }

    // 清理构建过程中产生的行业成分股缓存文件
    try {
        ensureCacheDir();
        const files = fs.readdirSync(CACHE_DIR);
        let cleaned = 0;
        for (const file of files) {
            if (file.startsWith('board_cons_industry_') && file.endsWith('.json')) {
                fs.unlinkSync(path.join(CACHE_DIR, file));
                cleaned++;
            }
        }
        if (cleaned > 0) {
            console.log(`[HotSectorAnalyzer] 清理行业成分股缓存文件: ${cleaned}个`);
        }
    } catch (err) {
        console.warn('[HotSectorAnalyzer] 清理行业成分股缓存失败:', err);
    }

    console.log(`[HotSectorAnalyzer] 股票→行业反向映射构建完成: ${map.size}只股票, ${industries.length}个行业`);
    return map;
}

/** 概念→行业映射（通过知识图谱，替代原来的成分股重叠度计算） */
async function mapConceptToIndustries(conceptCode: string, conceptName: string, topN: number = 3): Promise<ConceptIndustryResult> {
    const cacheKey = `concept_industry_map_${conceptName}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    try {
        // 优先从知识图谱获取概念-行业关联
        const kgResult = IndustryKGService.getConceptRelatedIndustriesByName(conceptName);

        // 转换KG格式为IndustryMapping格式
        const allRanked: IndustryMapping[] = kgResult.allRanked.map(r => ({
            name: r.industry.name,
            code: r.industry.id,
            overlap_count: r.overlapCount,
            overlap_ratio: r.overlapRatio,
            stock_count: 0,
            overlap_codes: [],
        }));

        const stronglyRelated: IndustryMapping[] = kgResult.stronglyRelated.slice(0, topN).map(ind => ({
            name: ind.name,
            code: ind.id,
            overlap_count: kgResult.allRanked.find(r => r.industry.id === ind.id)?.overlapCount || 0,
            overlap_ratio: kgResult.allRanked.find(r => r.industry.id === ind.id)?.overlapRatio || 0,
            stock_count: 0,
            overlap_codes: [],
        }));

        console.log(`[HotSectorAnalyzer] 概念 ${conceptName} KG关联行业: ${stronglyRelated.map(s => `${s.name}(${s.overlap_count})`).join(', ')}`);

        const result: ConceptIndustryResult = { strongly_related: stronglyRelated, all_ranked: allRanked };
        cacheSet(cacheKey, result);
        return result;
    } catch (err) {
        console.warn(`[HotSectorAnalyzer] KG获取概念 ${conceptName} 关联行业失败: ${(err as Error).message}，使用排名接口映射`);
        const fallback = await mapByRankingIndustry(conceptName, topN);
        const result: ConceptIndustryResult = { strongly_related: fallback, all_ranked: fallback };
        cacheSet(cacheKey, result);
        return result;
    }
}

async function mapByRankingIndustry(conceptName: string, topN: number = 3): Promise<IndustryMapping[]> {
    // 当成分股接口不可用时，通过行业涨幅排名映射
    const industries = await getIndustryBoards();
    const topIndustries = industries
        .sort((a, b) => Math.abs(b.change || 0) - Math.abs(a.change || 0))
        .slice(0, topN);

    return topIndustries.map(ind => ({
        name: ind.name,
        code: ind.code,
        overlap_count: 0,
        overlap_ratio: 0,
        stock_count: 0,
        overlap_codes: [],
    }));
}

// ==================== 产业链上下游（同花顺行业分类） ====================

/** AI批量生成同花顺行业产业链关系 */
async function aiGenerateChainBatch(
    batch: string[],
    allNames: string[],
): Promise<Record<string, { upstream: string[]; downstream: string[] }>> {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) throw new Error('未配置OPENAI_API_KEY');

    let apiBase = process.env.OPENAI_API_BASE_URL || process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
    const chatUrl = apiBase.includes('/chat/completions') ? apiBase : `${apiBase}/chat/completions`;
    const model = process.env.AI_MODEL || 'gpt-4o-mini';

    const prompt = `你是一位资深A股行业分析师，熟悉同花顺行业分类体系。请为以下行业确定其上游和下游行业。

参考行业名称列表（请仅使用此列表中的名称）：
${allNames.join('、')}

请为以下行业确定上下游：
${batch.map((n, i) => `${i + 1}. ${n}`).join('\n')}

返回JSON格式，key为行业名称，value为{"upstream": [...], "downstream": [...]}。

规则：
1. 上游行业：该行业的原材料、零部件、设备供应商所属行业
2. 下游行业：该行业产品的应用领域、客户所属行业
3. 仅使用参考列表中的行业名称
4. 如果某行业无明确上下游，返回空数组
5. 每个行业的上下游各不超过5个
6. 只返回JSON，不要其他文字`;

    const resp = await fetch(chatUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(90000),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 4000,
        }),
    });

    if (!resp.ok) throw new Error(`AI API HTTP ${resp.status}`);

    const json = await resp.json() as any;
    let content = (json?.choices?.[0]?.message?.content || '').trim();
    if (content.startsWith('```')) {
        content = content.split('```')[1] || '';
        if (content.startsWith('json')) content = content.slice(4);
    }

    return JSON.parse(content.trim());
}

/** 模糊匹配行业名到同花顺行业列表 */
function fuzzyMatchIndustryName(name: string, nameSet: Set<string>): string | null {
    if (nameSet.has(name)) return name;
    const cleanName = name.replace(/\(A股\)$/, '').replace(/[ⅡⅢⅣ]$/, '');
    for (const n of nameSet) {
        if (n.replace(/\(A股\)$/, '').replace(/[ⅡⅢⅣ]$/, '') === cleanName) return n;
    }
    for (const n of nameSet) {
        const cn = n.replace(/\(A股\)$/, '').replace(/[ⅡⅢⅣ]$/, '');
        if (cn === cleanName) return n;
    }
    for (const n of nameSet) {
        if (n.includes(cleanName) || cleanName.includes(n.replace(/\(A股\)$/, '').replace(/[ⅡⅢⅣ]$/, ''))) return n;
    }
    return null;
}

/** 构建同花顺行业产业链映射（AI生成，长期缓存30天） */
async function buildThsIndustryChain(): Promise<Record<string, { upstream: string[]; downstream: string[] }>> {
    const cacheKey = 'ths_industry_chain';
    // 使用30天TTL
    const THIRTY_DAYS = 30 * 24 * 3600 * 1000;
    try {
        ensureCacheDir();
        const fp = path.join(CACHE_DIR, `${cacheKey}.json`);
        if (fs.existsSync(fp)) {
            const stat = fs.statSync(fp);
            if (Date.now() - stat.mtimeMs < THIRTY_DAYS) {
                const raw = fs.readFileSync(fp, 'utf-8');
                return JSON.parse(raw);
            }
            console.log('[HotSectorAnalyzer] 同花顺行业产业链缓存已过期，重新生成');
        }
    } catch { /* ignore */ }

    const industries = await getIndustryBoards();
    const allNames = industries.map(i => i.name);
    const nameSet = new Set(allNames);

    const chain: Record<string, { upstream: string[]; downstream: string[] }> = {};

    // 分批调用AI（50个一批，约12批）
    const batchSize = 50;
    let successCount = 0;
    for (let i = 0; i < allNames.length; i += batchSize) {
        const batch = allNames.slice(i, i + batchSize);
        try {
            const batchResult = await aiGenerateChainBatch(batch, allNames);
            // 验证并合并结果
            for (const [name, rel] of Object.entries(batchResult)) {
                const r = rel as { upstream?: string[]; downstream?: string[] };
                const validUpstream = (r.upstream || [])
                    .map((n: string) => nameSet.has(n) ? n : fuzzyMatchIndustryName(n, nameSet))
                    .filter((n: string | null): n is string => n !== null);
                const validDownstream = (r.downstream || [])
                    .map((n: string) => nameSet.has(n) ? n : fuzzyMatchIndustryName(n, nameSet))
                    .filter((n: string | null): n is string => n !== null);
                chain[name] = { upstream: validUpstream, downstream: validDownstream };
            }
            successCount += batch.length;
            console.log(`[HotSectorAnalyzer] 产业链批次${Math.floor(i / batchSize) + 1}完成: ${batch.length}个行业`);
        } catch (err) {
            console.warn(`[HotSectorAnalyzer] 产业链批次${Math.floor(i / batchSize) + 1}失败:`, (err as Error).message);
            // 失败的行业设为空链
            for (const name of batch) {
                if (!chain[name]) chain[name] = { upstream: [], downstream: [] };
            }
        }
    }

    // 为未覆盖的行业设置空链
    for (const name of allNames) {
        if (!chain[name]) chain[name] = { upstream: [], downstream: [] };
    }

    // 缓存
    try {
        ensureCacheDir();
        const fp = path.join(CACHE_DIR, `${cacheKey}.json`);
        fs.writeFileSync(fp, JSON.stringify(chain, null, 2), 'utf-8');
    } catch (err) {
        console.warn('[HotSectorAnalyzer] 产业链缓存写入失败:', err);
    }

    const coveredCount = Object.values(chain).filter(c => c.upstream.length > 0 || c.downstream.length > 0).length;
    console.log(`[HotSectorAnalyzer] 同花顺行业产业链构建完成: ${allNames.length}个行业, ${coveredCount}个有关联 (AI成功${successCount}个)`);
    return chain;
}

/** 获取行业的上下游（通过知识图谱，替代原来的AI产业链查找） */
async function getUpstreamDownstream(industryName: string): Promise<{ upstream: string[]; downstream: string[] }> {
    try {
        const kgResult = IndustryKGService.getUpstreamDownstreamByName(industryName, 1);
        return {
            upstream: kgResult.upstream.map(ind => ind.name),
            downstream: kgResult.downstream.map(ind => ind.name),
        };
    } catch (err) {
        console.warn(`[HotSectorAnalyzer] KG获取行业 ${industryName} 上下游失败: ${(err as Error).message}`);
        return { upstream: [], downstream: [] };
    }
}

// ==================== 传导因子计算 ====================

interface TransmissionItem {
    name: string;
    code: string;
    factor: number;
    direction: string;
    source_industry: string;
}

interface TransmissionResult {
    upstream: TransmissionItem[];
    downstream: TransmissionItem[];
}

async function calculateTransmissionFactor(
    conceptName: string,
    allRankedIndustries: IndustryMapping[],
): Promise<TransmissionResult> {
    const result: TransmissionResult = { upstream: [], downstream: [] };

    // 获取风口概念的历史行情
    const mainHist = await getBoardHistory(conceptName, 10);

    // 收集所有上下游行业（不去重强关联行业，仅去重自身）
    const upstreamSet = new Map<string, string>(); // name -> source_industry
    const downstreamSet = new Map<string, string>();

    for (const ind of allRankedIndustries) {
        const chain = await getUpstreamDownstream(ind.name);
        for (const up of chain.upstream) {
            if (!upstreamSet.has(up)) {
                upstreamSet.set(up, ind.name);
            }
        }
        for (const down of chain.downstream) {
            if (!downstreamSet.has(down)) {
                downstreamSet.set(down, ind.name);
            }
        }
    }

    // 获取行业板块列表用于查找code
    const industryBoards = await getIndustryBoards();
    const industryCodeMap = new Map(industryBoards.map(i => [i.name, i.code]));

    // 计算传导因子
    const directions: Array<{ dir: 'upstream' | 'downstream'; set: Map<string, string> }> = [
        { dir: 'upstream', set: upstreamSet },
        { dir: 'downstream', set: downstreamSet },
    ];

    for (const { dir, set } of directions) {
        const positionWeight = dir === 'upstream' ? 0.4 : 0.3;

        for (const [indName, sourceIndustry] of set) {
            let factor: number;

            if (mainHist.length === 0) {
                factor = Math.round(positionWeight * 0.7 * 1000) / 1000;
            } else {
                const relatedHist = await getBoardHistory(indName, 10);

                if (relatedHist.length === 0) {
                    factor = Math.round(positionWeight * 0.7 * 1000) / 1000;
                } else {
                    const minLen = Math.min(mainHist.length, relatedHist.length);
                    if (minLen >= 3) {
                        const mainChanges = mainHist.slice(-minLen).map(h => h.change_pct);
                        const relatedChanges = relatedHist.slice(-minLen).map(h => h.change_pct);
                        const correlation = Math.abs(pearsonCorrelation(mainChanges, relatedChanges));
                        const corr = isNaN(correlation) ? 0.3 : correlation;

                        // 资金流向相关性
                        const mainAmounts = mainHist.slice(-minLen).map(h => h.amount);
                        const relatedAmounts = relatedHist.slice(-minLen).map(h => h.amount);
                        const amountCorr = Math.abs(pearsonCorrelation(mainAmounts, relatedAmounts));
                        const aCorr = isNaN(amountCorr) ? 0.3 : amountCorr;

                        factor = Math.round((positionWeight * 0.4 + corr * 0.35 + aCorr * 0.25) * 1000) / 1000;
                    } else {
                        factor = Math.round(positionWeight * 0.7 * 1000) / 1000;
                    }
                }
            }

            result[dir].push({
                name: indName,
                code: industryCodeMap.get(indName) || '',
                factor,
                direction: dir,
                source_industry: sourceIndustry,
            });
        }
    }

    // 按传导因子排序
    result.upstream.sort((a, b) => b.factor - a.factor);
    result.downstream.sort((a, b) => b.factor - a.factor);

    return result;
}

/** 皮尔逊相关系数 */
function pearsonCorrelation(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;

    const meanX = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
    const meanY = y.slice(0, n).reduce((a, b) => a + b, 0) / n;

    let num = 0, denX = 0, denY = 0;
    for (let i = 0; i < n; i++) {
        const dx = x[i] - meanX;
        const dy = y[i] - meanY;
        num += dx * dy;
        denX += dx * dx;
        denY += dy * dy;
    }

    const den = Math.sqrt(denX * denY);
    return den === 0 ? 0 : num / den;
}

// ==================== AI判断持续性 ====================

interface AiAnalysis {
    persistence: string;
    persistence_reason: string;
    heat_transfer: boolean;
    transfer_direction: string;
    transfer_reason: string;
    risk_warning: string;
}

/** AI API是否可用的标记（首次失败后直接跳过，避免重复超时） */
let aiApiAvailable: boolean | null = null;

async function aiAnalyzeSector(sectorName: string, sectorData: HotConcept, transmission: TransmissionResult): Promise<AiAnalysis> {
    const apiKey = process.env.OPENAI_API_KEY || '';
    let apiBase = process.env.OPENAI_API_BASE_URL || process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
    // 兼容URL已包含/chat/completions的情况（其他Service直接用完整URL）
    const chatUrl = apiBase.includes('/chat/completions') ? apiBase : `${apiBase}/chat/completions`;
    const model = process.env.AI_MODEL || 'gpt-4o-mini';

    if (!apiKey || aiApiAvailable === false) {
        if (aiApiAvailable === false) {
            // AI已确认不可用，直接用规则引擎
        } else if (!apiKey) {
            console.log('[HotSectorAnalyzer] 未配置OPENAI_API_KEY，使用规则引擎判断');
        }
        return ruleBasedAnalysis(sectorName, sectorData, transmission);
    }

    try {
        // 格式化上下游传导数据
        const formatTransmission = (items: TransmissionItem[]) => {
            if (items.length === 0) return '无';
            return items.map(i => `${i.name}(传导因子:${i.factor.toFixed(2)}, 来源:${i.source_industry})`).join('; ');
        };

        const prompt = `你是一位资深A股市场分析师。请根据以下数据，分析该风口概念板块的持续性和热度传递。

## 概念板块数据
- 概念名称：${sectorName}
- 板块评分：${sectorData.score}分（综合频次、涨幅、资金等因素）
- 近20日上榜频次：${sectorData.frequency}天
- 近20日平均涨幅：${sectorData.avg_change}%
- 今日涨幅：${sectorData.today_change}%
- 主力净流入：${sectorData.amount_trend}万元
- 板块净流入：${sectorData.net_inflow}万元
- 驱动因素：${sectorData.driver}
- 领涨股：${sectorData.leading_stock}（涨幅${sectorData.leading_change}%）

## 上下游传导
- 上游行业：${formatTransmission(transmission.upstream)}
- 下游行业：${formatTransmission(transmission.downstream)}

请以JSON格式返回分析结果，包含以下字段：
1. persistence: 持续时间判断，值为"短期(1-3天)"/"中期(1-2周)"/"长期(1月+)"
2. persistence_reason: 持续性判断理由（50字以内，需结合上榜频次、涨幅、资金等因素综合分析）
3. heat_transfer: 热度是否会在板块间传递，true/false
4. transfer_direction: 传递方向（如"上游→中游"、"中游→下游"、"无明显传递"）
5. transfer_reason: 传递判断理由（50字以内，需结合上下游传导因子分析）
6. risk_warning: 风险提示（30字以内）

只返回JSON，不要其他文字。`;

        const resp = await sessionFetch(chatUrl, {
            method: 'POST',
            signal: AbortSignal.timeout(45000),  // 45秒超时，32B模型复杂分析需要更长时间
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 500,
            }),
        });

        if (!resp.ok) throw new Error(`AI API HTTP ${resp.status}`);

        const json: any = await resp.json();
        let content = json?.choices?.[0]?.message?.content?.trim() || '';
        if (content.startsWith('```')) {
            content = content.split('```')[1];
            if (content.startsWith('json')) content = content.slice(4);
        }

        const result = JSON.parse(content.trim());
        aiApiAvailable = true;  // AI可用
        return result;
    } catch (err) {
        const errMsg = (err as Error).message || '';
        // 只有连接错误才标记AI永久不可用，超时只是暂时问题
        if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ENOTFOUND') || errMsg.includes('fetch failed')) {
            aiApiAvailable = false;
        }
        console.error('[HotSectorAnalyzer] AI分析失败，使用规则引擎:', errMsg);
        return ruleBasedAnalysis(sectorName, sectorData, transmission);
    }
}

function ruleBasedAnalysis(sectorName: string, sectorData: HotConcept, transmission: TransmissionResult): AiAnalysis {
    const freq = sectorData.frequency;
    const avgChange = sectorData.avg_change;
    const amountTrend = sectorData.amount_trend;

    let persistence: string, reason: string;
    if (freq >= 6 && avgChange > 2 && amountTrend > 10) {
        persistence = '长期(1月+)';
        reason = '高频上榜+持续放量+资金加速流入，趋势强劲';
    } else if (freq >= 4 && avgChange > 1) {
        persistence = '中期(1-2周)';
        reason = '中频上榜+涨幅稳定，有一定持续性';
    } else {
        persistence = '短期(1-3天)';
        reason = '上榜频次较低或资金流出，持续性存疑';
    }

    const upFactors = transmission.upstream.map(u => u.factor);
    const downFactors = transmission.downstream.map(d => d.factor);
    const maxUp = upFactors.length > 0 ? Math.max(...upFactors) : 0;
    const maxDown = downFactors.length > 0 ? Math.max(...downFactors) : 0;

    let heatTransfer: boolean, direction: string, transferReason: string;
    if (maxUp > 0.5 || maxDown > 0.5) {
        heatTransfer = true;
        if (maxUp > maxDown) {
            direction = '上游→中游';
            transferReason = '上游传导因子较高，原材料端先行启动';
        } else {
            direction = '中游→下游';
            transferReason = '下游传导因子较高，需求端拉动效应明显';
        }
    } else {
        heatTransfer = false;
        direction = '无明显传递';
        transferReason = '上下游传导因子均较低，板块联动性弱';
    }

    const risk = freq < 4 ? '追高风险较大，注意板块轮动节奏' : '关注量能变化，缩量需警惕';

    return {
        persistence,
        persistence_reason: reason,
        heat_transfer: heatTransfer,
        transfer_direction: direction,
        transfer_reason: transferReason,
        risk_warning: risk,
    };
}

// ==================== 选股打分 ====================

interface SelectedStock {
    code: string;
    name: string;
    industry: string;
    score: number;
    reason: string;
    reason_tag: string;
    reason_tag_class: string;
    source: string;
    in_concept: boolean;
    chain_position?: string;
    related_industry?: string;
    overlap_ratio?: number;
    transmission_factor?: number;
    source_industry?: string;
    price?: number;
    change_pct?: number;
}

/** 将东方财富6位代码转为Tushare ts_code格式 */
function toTsCodeFromEm(emCode: string): string {
    if (!emCode || emCode.length !== 6) return '';
    // BJ: 920xxx / 83xxxx / 87xxxx / 430xxx
    const isBJ = emCode.startsWith('920') || emCode.startsWith('8') || emCode.startsWith('43');
    const first = emCode[0];
    const suffix = isBJ ? '.BJ' : first === '6' ? '.SH' : (first === '0' || first === '3') ? '.SZ' : '.SZ';
    return emCode + suffix;
}

/** 带重试的东方财富实时行情获取，最多重试3次，每次间隔1秒 */
async function fetchQuoteWithRetry(code: string, _maxRetries = 3): Promise<{ price: number | null; changePct: number | null }> {
    try {
        const quote = await TencentQuoteService.getCachedQuote(code, 'core');
        const price = (quote['最新价'] && quote['最新价'] !== '-') ? parseFloat(String(quote['最新价'])) : null;
        const changePct = quote['涨跌幅'] ? parseFloat(String(quote['涨跌幅'])) : null;
        if (price !== null) return { price, changePct };
    } catch {
        // 缓存和接口都失败时返回null
    }
    return { price: null, changePct: null };
}

/** 批量获取Tushare增强数据（资金流向+每日指标），返回Map<ts_code, data> */
async function fetchTushareEnhancement(stockCodes: string[]): Promise<{
    moneyflowMap: Map<string, MoneyflowRow>;
    moneyflowThsMap: Map<string, MoneyflowThsRow>;
    dailyBasicMap: Map<string, DailyBasicFullRow>;
    dailyHistMap: Map<string, DailyPriceRow[]>;
    limitListMap: Map<string, LimitListThsRow>;
    limitStepData: LimitStepRow[];
}> {
    const moneyflowMap = new Map<string, MoneyflowRow>();
    const moneyflowThsMap = new Map<string, MoneyflowThsRow>();
    const dailyBasicMap = new Map<string, DailyBasicFullRow>();
    const dailyHistMap = new Map<string, DailyPriceRow[]>();
    const limitListMap = new Map<string, LimitListThsRow>();
    const limitStepData: LimitStepRow[] = [];

    const today = new Date();
    const tradeDateStr = formatDate(today);

    // 优先获取同花顺增强版资金流向（moneyflow_ths）—— 1次调用
    try {
        const mfThsRows = await getMoneyflowThsByDate(tradeDateStr);
        for (const row of mfThsRows) {
            moneyflowThsMap.set(row.ts_code, row);
        }
        if (mfThsRows.length === 0) {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const ydRows = await getMoneyflowThsByDate(formatDate(yesterday));
            for (const row of ydRows) {
                moneyflowThsMap.set(row.ts_code, row);
            }
        }
        console.log(`[HotSectorAnalyzer] moneyflow_ths获取成功: ${moneyflowThsMap.size}只`);
    } catch (err) {
        console.warn('[HotSectorAnalyzer] moneyflow_ths获取失败，回退到moneyflow:', (err as Error).message);
    }

    // 北交所股票Tushare不支持资金流向，用新浪接口补充
    const bjCandidates = stockCodes.filter(c => isBJStock(c));
    if (bjCandidates.length > 0) {
        try {
            const sinaMfMap = await getBatchSinaMoneyflowForBJ(bjCandidates, tradeDateStr);
            for (const [tsCode, row] of sinaMfMap) {
                moneyflowThsMap.set(tsCode, row);
            }
            console.log(`[HotSectorAnalyzer] 新浪补充BJ资金流向: ${sinaMfMap.size}/${bjCandidates.length}只`);
        } catch (err) {
            console.warn('[HotSectorAnalyzer] 新浪BJ资金流向补充失败:', (err as Error).message);
        }
    }

    // 如果moneyflow_ths无数据，回退到原有moneyflow
    if (moneyflowThsMap.size === 0) {
        try {
            const mfRows = await getMoneyflowByDate(tradeDateStr);
            for (const row of mfRows) {
                moneyflowMap.set(row.ts_code, row);
            }
            if (mfRows.length === 0) {
                const yesterday = new Date(today);
                yesterday.setDate(yesterday.getDate() - 1);
                const ydRows = await getMoneyflowByDate(formatDate(yesterday));
                for (const row of ydRows) {
                    moneyflowMap.set(row.ts_code, row);
                }
            }
        } catch (err) {
            console.warn('[HotSectorAnalyzer] Tushare资金流向获取失败:', err);
        }
    }

    // 获取涨跌停数据（limit_list_ths + limit_step）—— 2次调用
    try {
        const limitRows = await getLimitListThs(tradeDateStr);
        for (const row of limitRows) {
            limitListMap.set(row.ts_code, row);
        }
        if (limitRows.length === 0) {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const ydRows = await getLimitListThs(formatDate(yesterday));
            for (const row of ydRows) {
                limitListMap.set(row.ts_code, row);
            }
        }
        console.log(`[HotSectorAnalyzer] limit_list_ths获取成功: ${limitListMap.size}只`);
    } catch (err) {
        console.warn('[HotSectorAnalyzer] limit_list_ths获取失败:', (err as Error).message);
    }

    try {
        const stepRows = await getLimitStep(tradeDateStr);
        if (stepRows.length === 0) {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            limitStepData.push(...await getLimitStep(formatDate(yesterday)));
        } else {
            limitStepData.push(...stepRows);
        }
        console.log(`[HotSectorAnalyzer] limit_step获取成功: ${limitStepData.length}只`);
    } catch (err) {
        console.warn('[HotSectorAnalyzer] limit_step获取失败:', (err as Error).message);
    }

    // 批量获取单日全市场每日指标
    try {
        const dbRows = await getDailyBasicByDate(tradeDateStr);
        for (const row of dbRows) {
            dailyBasicMap.set(row.ts_code, row);
        }
        if (dbRows.length === 0) {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const ydRows = await getDailyBasicByDate(formatDate(yesterday));
            for (const row of ydRows) {
                dailyBasicMap.set(row.ts_code, row);
            }
        }
    } catch (err) {
        console.warn('[HotSectorAnalyzer] Tushare每日指标获取失败:', err);
    }

    // 对候选股获取近10日日线（用于计算连续上涨天数），限制并发
    const tsCodes = stockCodes.map(c => toTsCodeFromEm(c)).filter(Boolean);
    const batchSize = 5;
    for (let i = 0; i < tsCodes.length; i += batchSize) {
        const batch = tsCodes.slice(i, i + batchSize);
        const promises = batch.map(async (tsCode) => {
            try {
                const rows = await getStockDailyRecent(tsCode.split('.')[0], 20);
                dailyHistMap.set(tsCode, rows);
            } catch { /* ignore */ }
        });
        await Promise.all(promises);
    }

    return { moneyflowMap, moneyflowThsMap, dailyBasicMap, dailyHistMap, limitListMap, limitStepData };
}

/** 计算连续上涨天数（从最近一天往前数） */
function calcConsecutiveUpDays(dailyRows: DailyPriceRow[]): number {
    let count = 0;
    for (const row of dailyRows) {
        if (row.pct_chg > 0) count++;
        else break;
    }
    return count;
}

async function selectStocksFromIndustry(
    industryCode: string,
    industryName: string,
    conceptName: string,
    conceptCodes: Set<string>,
    maxStocks: number = 3,
    enhancement?: {
        moneyflowMap: Map<string, MoneyflowRow>;
        moneyflowThsMap: Map<string, MoneyflowThsRow>;
        dailyBasicMap: Map<string, DailyBasicFullRow>;
        dailyHistMap: Map<string, DailyPriceRow[]>;
        limitListMap: Map<string, LimitListThsRow>;
        limitStepData: LimitStepRow[];
    },
): Promise<SelectedStock[]> {
    const stocks: SelectedStock[] = [];

    // 获取板块成分股（涨幅排序，取前20）
    const topStocks = await getBoardTopStocks(industryCode, 20, 'industry');
    if (topStocks.length === 0) return [];

    // 获取板块近5日K线，用于判断连续上涨
    const hist = await getBoardHistory(industryName, 5);
    const isBoardUptrend = hist.length >= 3 && hist.slice(-3).every(h => h.change_pct > 0);

    for (const stock of topStocks) {
        if (stocks.length >= maxStocks) break;
        if (stocks.some(s => s.code === stock.code)) continue;

        const changePct = stock.change_pct || 0;

        // Tushare增强数据
        const tsCode = toTsCodeFromEm(stock.code);
        const mfData = enhancement?.moneyflowMap.get(tsCode);
        const mfThsData = enhancement?.moneyflowThsMap.get(tsCode);
        const dbData = enhancement?.dailyBasicMap.get(tsCode);
        const histData = enhancement?.dailyHistMap.get(tsCode);
        const limitData = enhancement?.limitListMap.get(tsCode);

        // 换手率：优先用Tushare数据，回退到同花顺HTML解析值
        const turnover = dbData?.turnover_rate || stock.turnover_rate || 0;

        // 资金净流入：优先用moneyflow_ths（更精准，含占比和5日数据），回退到moneyflow
        const netMfAmount = mfThsData?.net_mf_amount || mfData?.net_mf_amount || 0;
        const mf5day = mfThsData?.mf_5day || 0;  // 5日主力净额（万元）
        // 大单+特大单净买入（万元）
        const bigNetAmount = mfThsData
            ? ((mfThsData.buy_lg_amount || 0) - (mfThsData.sell_lg_amount || 0) + (mfThsData.buy_elg_amount || 0) - (mfThsData.sell_elg_amount || 0))
            : (mfData ? ((mfData.buy_lg_amount || 0) - (mfData.sell_lg_amount || 0) + (mfData.buy_elg_amount || 0) - (mfData.sell_elg_amount || 0)) : 0);

        // 资金净流入（元）：优先用Tushare数据（万元→元），回退到同花顺HTML解析值
        const netInflowEm = netMfAmount ? netMfAmount * 10000 : (stock.net_inflow || 0);
        // 量比
        const volumeRatio = dbData?.volume_ratio || 0;
        // 流通市值（万元）
        const circMv = dbData?.circ_mv || 0;
        // 换手率（自由流通股）
        const turnoverF = dbData?.turnover_rate_f || 0;
        // 连续上涨天数
        const consecutiveUpDays = histData ? calcConsecutiveUpDays(histData) : 0;
        // 涨停数据
        const isLimitUp = limitData != null;  // 是否涨停
        // 从status字段解析连板数，格式如"4天4板"、"2天2板"、"首板"
        const statusStr = limitData?.status || '';
        const boardMatch = statusStr.match(/(\d+)天(\d+)板/);
        const limitTimes = boardMatch ? parseInt(boardMatch[2]) : (statusStr.includes('首板') ? 1 : 0);
        const limitReason = limitData?.lu_desc || '';  // 涨停原因
        const fcRatio = limitData?.limit_up_suc_rate || 0;  // 近一年涨停封板率

        // 市值过滤：流通市值 < 20亿 的跳过（容易被操纵）
        if (circMv > 0 && circMv < 200000) {
            continue;
        }

        // ===== 12子因子四维打分体系 =====
        // 目标：筛选未来1-2周有上涨潜力的风口股
        // 趋势/动量40% + 资金流/量价30% + 风口/概念20% + 风险/拥挤度10%

        // ---- 维度1：趋势/动量（权重40%，4因子）----
        let trendScore = 0;

        // 因子1：当日涨跌幅（0-25分）
        // 涨停>大涨>中涨>小涨>微涨>平盘>下跌
        if (changePct >= 9.5) {
            trendScore += 25; // 涨停级
        } else if (changePct >= 5) {
            trendScore += 15 + Math.min(10, (changePct - 5) * 2);
        } else if (changePct >= 2) {
            trendScore += 8 + (changePct - 2) * 2.33;
        } else if (changePct > 0) {
            trendScore += changePct * 4;
        } else {
            trendScore += Math.max(0, 3 + changePct); // 下跌给极少分
        }

        // 因子2：连续上涨天数（0-25分）
        // 连涨天数越多，趋势惯性越强，未来1-2周延续概率越高
        if (consecutiveUpDays >= 7) {
            trendScore += 25;
        } else if (consecutiveUpDays >= 5) {
            trendScore += 20;
        } else if (consecutiveUpDays >= 3) {
            trendScore += 12 + (consecutiveUpDays - 3) * 4;
        } else if (consecutiveUpDays >= 1) {
            trendScore += 4;
        }

        // 因子3：涨停/连板强度（0-30分）
        // 连板是最强动量信号，短期爆发力最强
        if (isLimitUp && limitTimes >= 4) {
            trendScore += 30; // 4连板+
        } else if (isLimitUp && limitTimes >= 3) {
            trendScore += 27;
        } else if (isLimitUp && limitTimes >= 2) {
            trendScore += 24;
        } else if (isLimitUp) {
            trendScore += 18 + Math.min(12, fcRatio / 10 * 2); // 首板+封板率加分
        }

        // 因子4：20日涨幅（0-20分）
        // 中期趋势强度，20日涨幅反映近一个月的趋势
        let change20d = 0;
        if (histData && histData.length >= 5) {
            const sorted = [...histData].sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
            if (sorted.length >= 2) {
                const oldestClose = Number(sorted[0].close);
                const latestClose = Number(sorted[sorted.length - 1].close);
                if (oldestClose > 0) {
                    change20d = (latestClose - oldestClose) / oldestClose * 100;
                }
            }
        }
        if (change20d >= 30) {
            trendScore += 20; // 强势趋势
        } else if (change20d >= 15) {
            trendScore += 14;
        } else if (change20d >= 5) {
            trendScore += 8;
        } else if (change20d >= 0) {
            trendScore += 3;
        } else if (change20d >= -10) {
            trendScore += 1;
        }
        // 20日跌幅过大则不加趋势分

        // ---- 维度2：资金流/量价（权重30%，4因子）----
        let fundScore = 0;

        // 因子5：5日主力净流入占比 net_mf_ratio（0-25分）
        // 占比越高说明主力资金越积极，是短期上涨的核心驱动力
        const netMfRatio = mfThsData?.net_mf_ratio || 0;
        if (netMfRatio >= 20) {
            fundScore += 25; // 主力极度积极
        } else if (netMfRatio >= 10) {
            fundScore += 18;
        } else if (netMfRatio >= 5) {
            fundScore += 12;
        } else if (netMfRatio >= 0) {
            fundScore += 5;
        } else if (netMfRatio >= -5) {
            fundScore += 2; // 小幅流出
        }
        // 大幅流出不给分

        // 因子6：5日主力净额 mf_5day（0-25分）
        // 绝对金额反映资金介入深度
        if (mf5day > 0) {
            const mf5dYi = mf5day / 10000; // 转亿
            if (mf5dYi >= 5) {
                fundScore += 25;
            } else if (mf5dYi >= 2) {
                fundScore += 16 + (mf5dYi - 2) * 3;
            } else if (mf5dYi >= 0.5) {
                fundScore += 8 + (mf5dYi - 0.5) * 5.33;
            } else {
                fundScore += mf5dYi * 16;
            }
        }

        // 因子7：换手率（0-25分）
        // 风口股需要流动性支撑！适中换手(3-10%)最佳，过低无人关注，过高过热
        if (turnover >= 3 && turnover <= 5) {
            fundScore += 25; // 最佳：温和活跃，资金参与度高
        } else if (turnover > 5 && turnover <= 7) {
            fundScore += 22; // 良好：正常活跃
        } else if (turnover > 7 && turnover <= 10) {
            fundScore += 18; // 可接受：偏活跃
        } else if (turnover > 2 && turnover < 3) {
            fundScore += 15; // 偏低但尚可
        } else if (turnover > 1 && turnover <= 2) {
            fundScore += 8;  // 偏低，流动性不足
        } else if (turnover > 10 && turnover <= 15) {
            fundScore += 10; // 偏高，游资特征
        } else if (turnover > 0 && turnover <= 1) {
            fundScore += 3;  // 极低换手，无人关注
        } else if (turnover > 15 && turnover <= 25) {
            fundScore += 4;  // 过热
        }
        // >25% 极度过热，0分

        // 因子8：量比（0-25分）
        // 量比>1说明今日放量，资金关注度提升
        if (volumeRatio >= 3) {
            fundScore += 25; // 明显放量
        } else if (volumeRatio >= 2) {
            fundScore += 18 + (volumeRatio - 2) * 7;
        } else if (volumeRatio >= 1.5) {
            fundScore += 10;
        } else if (volumeRatio >= 1) {
            fundScore += 5;
        } else if (volumeRatio > 0) {
            fundScore += 2; // 缩量
        }

        // ---- 维度3：风口/概念（权重20%，2因子）----
        let conceptScoreVal = 0;

        // 因子9：概念共振（0-60分）
        // 属于该风口概念成分股，享受板块上涨红利
        const inConcept = conceptCodes.has(stock.code);
        if (inConcept) {
            conceptScoreVal += 60;
        }

        // 因子10：板块联动（0-40分）
        // 板块连涨+个股跟涨 = 最强联动
        if (isBoardUptrend && changePct > 0) {
            conceptScoreVal += 40;
        } else if (isBoardUptrend) {
            conceptScoreVal += 15;
        } else if (changePct > 3) {
            conceptScoreVal += 20;
        }

        // ---- 维度4：风险/拥挤度（权重10%，2因子，负向）----
        let riskScore = 50; // 基准50分

        // 因子11：高换手+高涨幅减分（出货嫌疑）
        if (changePct > 7 && turnover > 20) {
            riskScore -= 40; // 极大概率出货
        } else if (changePct > 5 && turnover > 15) {
            riskScore -= 25; // 高位放量
        } else if (changePct > 3 && turnover > 10) {
            riskScore -= 10; // 温和放量
        }

        // 因子12：资金流出+上涨减分（虚涨，无资金支撑）
        if (changePct > 0 && mf5day < 0 && netMfRatio < -5) {
            riskScore -= 20; // 上涨但资金持续流出
        } else if (changePct > 0 && mf5day < 0) {
            riskScore -= 8; // 上涨但5日资金小幅流出
        }

        riskScore = Math.max(0, Math.min(100, riskScore));

        // ===== 加权求和 =====
        const totalScore = trendScore * 0.40 + fundScore * 0.30 + conceptScoreVal * 0.20 + riskScore * 0.10;

        // 跳过总分过低的股票
        if (totalScore < 15) continue;

        // ===== 生成标签和描述 =====
        let reasonTag = '';
        let reasonTagClass = '';
        let reason = limitReason || '';

        // 涨停原因缺失时，回退到公司简介（截断30字）
        if (!reason && tsCode) {
            try {
                const companyData = await getStockCompany(tsCode);
                if (companyData) {
                    reason = extractLeaderDescription(companyData.introduction || '', companyData.main_business || '');
                }
            } catch { /* ignore */ }
        }

        if (isLimitUp && limitTimes >= 2) {
            reasonTag = `${limitTimes}连板`;
            reasonTagClass = 'tag-bullish';
        } else if (isLimitUp) {
            reasonTag = '昨日涨停';
            reasonTagClass = 'tag-bullish';
        } else if (consecutiveUpDays >= 5 && mf5day > 0) {
            reasonTag = '强势连阳';
            reasonTagClass = 'tag-trend';
        } else if (consecutiveUpDays >= 3 && mf5day > 0) {
            reasonTag = '资金连阳';
            reasonTagClass = 'tag-trend';
        } else if (changePct > 5 && turnover > 5) {
            reasonTag = '量价齐升';
            reasonTagClass = 'tag-trend';
        }

        stocks.push({
            code: stock.code,
            name: stock.name,
            industry: industryName,
            score: Math.round(totalScore * 10) / 10,
            reason,
            reason_tag: reasonTag,
            reason_tag_class: reasonTagClass,
            source: reasonTag || '',
            in_concept: inConcept,
            price: stock.price,
            change_pct: stock.change_pct,
        });
    }

    // 按评分排序
    stocks.sort((a, b) => b.score - a.score);
    return stocks.slice(0, maxStocks);
}

// ==================== 构建层级流向图 ====================

interface FlowNode {
    id: string;
    type: string;
    label: string;
}

interface FlowLink {
    source: string;
    target: string;
    factor: number;
    direction: string;
}

function buildFlowData(
    conceptName: string,
    relatedIndustries: IndustryMapping[],
    transmission: TransmissionResult,
    aiAnalysis: AiAnalysis,
): { nodes: FlowNode[]; links: FlowLink[]; transfer_direction: string } {
    const nodes: FlowNode[] = [
        { id: conceptName, type: 'main', label: conceptName },
    ];
    const links: FlowLink[] = [];

    // 概念 → 强关联行业
    for (const ind of relatedIndustries) {
        nodes.push({ id: ind.name, type: 'related', label: ind.name });
        links.push({
            source: conceptName,
            target: ind.name,
            factor: ind.overlap_ratio || 0.5,
            direction: 'related',
        });
    }

    // 按 source_industry 分组，每组只取权重最高的3个上游和3个下游
    const upBySource = new Map<string, TransmissionItem[]>();
    for (const up of transmission.upstream) {
        const arr = upBySource.get(up.source_industry) || [];
        arr.push(up);
        upBySource.set(up.source_industry, arr);
    }
    const downBySource = new Map<string, TransmissionItem[]>();
    for (const down of transmission.downstream) {
        const arr = downBySource.get(down.source_industry) || [];
        arr.push(down);
        downBySource.set(down.source_industry, arr);
    }

    // 强关联行业 → 上游（每个行业最多3个）
    for (const [sourceInd, upList] of upBySource) {
        const topUp = upList.sort((a, b) => b.factor - a.factor).slice(0, 3);
        for (const up of topUp) {
            if (!nodes.some(n => n.id === up.name)) {
                nodes.push({ id: up.name, type: 'upstream', label: up.name });
            }
            links.push({
                source: up.name,
                target: up.source_industry,
                factor: up.factor,
                direction: 'upstream',
            });
        }
    }

    // 强关联行业 → 下游（每个行业最多3个）
    for (const [sourceInd, downList] of downBySource) {
        const topDown = downList.sort((a, b) => b.factor - a.factor).slice(0, 3);
        for (const down of topDown) {
            if (!nodes.some(n => n.id === down.name)) {
                nodes.push({ id: down.name, type: 'downstream', label: down.name });
            }
            links.push({
                source: down.source_industry,
                target: down.name,
                factor: down.factor,
                direction: 'downstream',
            });
        }
    }

    return {
        nodes,
        links,
        transfer_direction: aiAnalysis.transfer_direction || '',
    };
}

// ==================== 提取龙头股信息 ====================

/** 龙头地位关键词 */
const LEADER_KEYWORDS = [
    '龙头', '领先', '最大', '第一', '唯一', '首家', '核心',
    '独家', '稀缺', '不可替代', '市占率', '份额第一',
    '全球领先', '国内领先', '世界领先', '行业领先',
    '绝对龙头', '双龙头', '细分龙头', '行业第一',
    '全球最大', '国内最大', '世界最大', '全球第一', '国内第一',
    '垄断', '主导', '标杆', '领军', '先驱',
];

/** 从introduction中提取龙头优势描述（截断到maxLen字以内） */
function extractLeaderDescription(introduction: string, mainBusiness: string, maxLen = 30): string {
    if (!introduction && !mainBusiness) return '';

    // 按句号/分号拆分句子
    const sentences = introduction.split(/[。；]/).filter(s => s.trim().length > 0);

    // 找到第一句包含龙头关键词的句子
    let matched = '';
    for (const sentence of sentences) {
        for (const keyword of LEADER_KEYWORDS) {
            if (sentence.includes(keyword)) {
                matched = sentence.trim();
                break;
            }
        }
        if (matched) break;
    }

    // 无关键词匹配时用main_business
    if (!matched) {
        matched = (mainBusiness || '').trim();
    }

    if (!matched) return '';

    // 截断到maxLen字以内，优先在自然边界（，、；）处截断
    if (matched.length <= maxLen) return matched;
    const sub = matched.substring(0, maxLen);
    const lastBreak = Math.max(sub.lastIndexOf('，'), sub.lastIndexOf('、'), sub.lastIndexOf('；'));
    if (lastBreak >= Math.floor(maxLen * 0.5)) {
        return sub.substring(0, lastBreak);
    }
    return sub;
}

/** 统计introduction中龙头关键词数量 */
function countLeaderKeywords(introduction: string): number {
    if (!introduction) return 0;
    let count = 0;
    for (const keyword of LEADER_KEYWORDS) {
        if (introduction.includes(keyword)) count++;
    }
    return count;
}

interface LeadingStockInfo {
    name: string;
    code: string;
    industry: string;
    price: number | null;
    change_pct: number | null;
    reason: string;
    reason_tag: string;
    reason_tag_class: string;
    related_industry: string;
    in_concept: boolean;
}

async function extractLeadingStock(
    conceptName: string,
    concept: HotConcept,
    mainStocks: SelectedStock[],
    conceptCode: string,
    enhancement?: {
        moneyflowMap: Map<string, MoneyflowRow>;
        moneyflowThsMap: Map<string, MoneyflowThsRow>;
        dailyBasicMap: Map<string, DailyBasicFullRow>;
        dailyHistMap: Map<string, DailyPriceRow[]>;
        limitListMap: Map<string, LimitListThsRow>;
        limitStepData: LimitStepRow[];
    },
): Promise<LeadingStockInfo> {
    // 优先从同花顺概念板块页面爬取龙头股
    const conceptLeadingStocks = await fetchConceptLeadingStocks(conceptCode);
    if (conceptLeadingStocks.length > 0) {
        // 批量查询龙头股的实际行业板块
        const leadingIndustryMap = await getStocksIndustryMap(conceptLeadingStocks.map(s => s.code));
        // 按市值排序，取市值最大的龙头股
        let selectedStock = conceptLeadingStocks[0];
        let maxMarketCap = 0;

        for (const stock of conceptLeadingStocks) {
            const tsCode = toTsCodeFromEm(stock.code);
            const dbData = tsCode ? enhancement?.dailyBasicMap.get(tsCode) : undefined;
            const circMv = dbData?.circ_mv || 0; // 流通市值（万元）

            if (circMv > maxMarketCap) {
                maxMarketCap = circMv;
                selectedStock = stock;
            }
        }

        const stock = selectedStock;
        let price: number | null = null;
        let changePct: number | null = null;
        if (stock.code) {
            const result = await fetchQuoteWithRetry(stock.code);
            price = result.price;
            changePct = result.changePct;
        }

        // 从Tushare增强数据生成选股理由和标签（与mainStocks中龙头股逻辑一致）
        const tsCode = toTsCodeFromEm(stock.code);
        const limitData = tsCode ? enhancement?.limitListMap.get(tsCode) : undefined;
        const mfThsData = tsCode ? enhancement?.moneyflowThsMap.get(tsCode) : undefined;
        const dbData = tsCode ? enhancement?.dailyBasicMap.get(tsCode) : undefined;
        const histData = tsCode ? enhancement?.dailyHistMap.get(tsCode) : undefined;

        // 北交所股票Tushare不支持limit_list_ths，用涨幅判断涨停
        const isBJ = isBJStock(stock.code);
        const isLimitUp = limitData != null || (isBJ && (changePct || 0) >= 9.5);
        const statusStr = limitData?.status || (isBJ && (changePct || 0) >= 9.5 ? '涨停' : '');
        const limitTimes = statusStr.match(/(\d+)天(\d+)板/)?.[2]
            ? parseInt(statusStr.match(/(\d+)天(\d+)板/)![2])
            : (statusStr.includes('首板') ? 1 : 0);
        const mf5day = mfThsData?.mf_5day || 0;
        const turnover = dbData?.turnover_rate || 0;
        const consecutiveUpDays = histData ? calcConsecutiveUpDays(histData) : 0;
        const fcRatio = limitData?.limit_up_suc_rate || 0;
        const limitReason = limitData?.lu_desc || '';

        // 生成选股理由：优先用涨停原因，缺失时回退到公司简介（截断30字）
        let reason = limitReason || '';
        // 北交所股票Tushare不支持limit_list_ths，对涨幅较大的BJ股补充默认原因
        if (!reason && isBJStock(stock.code) && (changePct || 0) >= 9.5) {
            reason = '北交所个股涨停，资金关注度提升';
        }
        if (!reason && tsCode) {
            try {
                const companyData = await getStockCompany(tsCode);
                if (companyData) {
                    reason = extractLeaderDescription(companyData.introduction || '', companyData.main_business || '');
                }
            } catch { /* ignore */ }
        }

        // 生成理由标签：只保留有特殊信号的标签，无信号则留空
        let reasonTag = '';
        let reasonTagClass = '';
        if (isLimitUp && limitTimes >= 2) {
            reasonTag = `${limitTimes}连板`;
            reasonTagClass = 'tag-bullish';
        } else if (isLimitUp) {
            reasonTag = '昨日涨停';
            reasonTagClass = 'tag-bullish';
        } else if (consecutiveUpDays >= 5 && mf5day > 0) {
            reasonTag = '强势连阳';
            reasonTagClass = 'tag-trend';
        } else if (consecutiveUpDays >= 3 && mf5day > 0) {
            reasonTag = '资金连阳';
            reasonTagClass = 'tag-trend';
        } else if ((changePct || 0) > 5 && turnover > 5) {
            reasonTag = '量价齐升';
            reasonTagClass = 'tag-trend';
        }

        return {
            name: stock.name,
            code: stock.code,
            industry: leadingIndustryMap.get(stock.code) || conceptName,
            price,
            change_pct: changePct,
            reason,
            reason_tag: reasonTag,
            reason_tag_class: reasonTagClass,
            related_industry: conceptName,
            in_concept: true,
        };
    }

    // 同花顺页面爬取失败时，不再回退到其他数据源，确保龙头股必须来自同花顺
    console.warn(`[HotSectorAnalyzer] 概念${conceptCode}(${conceptName})同花顺页面未爬取到龙头股，不使用备选数据源`);
    return {
        name: concept.leading_stock !== '--' ? concept.leading_stock : '',
        code: '',
        industry: '',
        price: null,
        change_pct: null,
        reason: concept.driver || '',
        reason_tag: '',
        reason_tag_class: '',
        related_industry: '',
        in_concept: false,
    };
}

// ==================== 获取关联行业行情统计 ====================

async function getIndustryStats(industryNames: string[]): Promise<any[]> {
    const industryBoards = await getIndustryBoards();
    const result: any[] = [];

    for (const name of industryNames) {
        const ind = industryBoards.find(i => i.name === name);
        if (ind) {
            result.push({
                name,
                change: ind.change || 0,
                up_count: ind.up_count || 0,
                down_count: ind.down_count || 0,
                leading_stock: '--',
            });
        } else {
            result.push({ name, change: 0, up_count: 0, down_count: 0, leading_stock: '--' });
        }
    }

    return result;
}

// ==================== 完整分析流程 ====================

export interface FullAnalysisResult {
    update_time: string;
    hot_sectors: any[];
}

export class WindLeaderAnalyzerService {
    /**
     * 执行完整的风口龙头分析流程
     *
     * 流程：
     * 1. 从概念板块中识别风口概念
     * 2. 根据概念成分股映射强关联二级行业
     * 3. 展开上下游二级行业
     * 4. 计算传导因子
     * 5. AI判断持续性
     * 6. 在各行业中选股（概念标签加分）
     * 7. 构建层级流向图
     */
    static async runFullAnalysis(): Promise<FullAnalysisResult> {
        console.log('[WindLeaderAnalyzer] 开始执行风口龙头分析...');
        // 清除缓存，确保获取最新数据
        clearAllCache();

        // 1. 识别风口概念板块
        let hotConcepts = await identifyHotConcepts(8, 2, 20);
        if (hotConcepts.length === 0) {
            console.log('[HotSectorAnalyzer] 未识别到风口概念，降低筛选条件重试');
            hotConcepts = await identifyHotConcepts(8, 1, 20);
        }

        const result: FullAnalysisResult = {
            update_time: new Date().toLocaleString('zh-CN', { hour12: false }),
            hot_sectors: [],
        };

        // 预先收集所有候选股代码，用于批量获取Tushare增强数据
        const allCandidateCodes: string[] = [];
        const conceptCodeSets: Map<string, Set<string>> = new Map();
        const conceptIndustryMap: Map<string, any[]> = new Map(); // 缓存行业映射结果
        const industryBoards = await getIndustryBoards();

        // ===== 并发爬取概念板块页面（成分股+龙头股）=====
        console.log(`[HotSectorAnalyzer] 并发爬取${hotConcepts.length}个概念板块页面...`);
        const conceptPageResults = await thsCrawler.crawlAll<{
            constituents: { code: string; name: string; exchange: string }[];
            leadingStocks: { code: string; name: string }[];
        }>(
            hotConcepts.map(concept => ({
                url: `https://basic.10jqka.com.cn/48/${concept.code}/`,
                handler: async (html: string) => {
                    const $ = cheerio.load(html);
                    // 提取龙头股
                    const topStockAttr = $('input.topStock').attr('topStock') || '';
                    const topStockCodes = topStockAttr.split(',').filter((c: string) => c && /^\d{6}$/.test(c));
                    const leadingStocks: { code: string; name: string }[] = [];
                    if (topStockCodes.length > 0) {
                        for (const code of topStockCodes) {
                            const name = $(`a[code="${code}"]`).first().text().trim();
                            if (name) leadingStocks.push({ code, name });
                        }
                    }
                    if (leadingStocks.length === 0) {
                        $('span.hltip').each((i, el) => {
                            if ($(el).text().trim().includes('龙头股')) {
                                $(el).closest('td').find('a.jumpto').each((j, a) => {
                                    const code = $(a).attr('code') || '';
                                    const name = $(a).text().trim();
                                    if (code && name && /^\d{6}$/.test(code)) leadingStocks.push({ code, name });
                                });
                                return false;
                            }
                        });
                    }
                    // 提取成分股
                    let constituents: { code: string; name: string; exchange: string }[] = [];
                    const match = html.match(/id="concept_data"[^>]*>([\s\S]*?)<\/div>/);
                    if (match) {
                        try {
                            const data = JSON.parse(match[1]);
                            const listData = data.result?.listdata;
                            if (listData) {
                                const dates = Object.keys(listData);
                                if (dates.length > 0) {
                                    constituents = listData[dates[0]].map((s: string[]) => ({
                                        code: s[0], name: s[1], exchange: s[2] || '',
                                    })).filter((s: { code: string; name: string }) => s.code && s.name && /^\d{6}$/.test(s.code));
                                }
                            }
                        } catch { /* ignore */ }
                    }
                    return { constituents, leadingStocks };
                },
            }))
        );

        // 处理并发爬取结果
        for (let i = 0; i < hotConcepts.length; i++) {
            const concept = hotConcepts[i];
            const pageResult = conceptPageResults[i];

            if (pageResult) {
                // 成分股
                let conceptCons = pageResult.constituents;
                if (conceptCons.length === 0) {
                    conceptCons = (await getBoardConstituents(concept.code, 'concept', 200)).map(s => ({
                        code: s.code, name: s.name, exchange: '',
                    }));
                }
                const conceptCodes = new Set(conceptCons.map(s => s.code));
                conceptCodeSets.set(concept.code, conceptCodes);
                if (conceptCons.length > 0) {
                    cacheSet(`concept_page_cons_${concept.code}`, conceptCons);
                }

                // 龙头股
                const conceptLeadingStocks = pageResult.leadingStocks;
                if (conceptLeadingStocks.length > 0) {
                    cacheSet(`concept_leading_${concept.code}`, conceptLeadingStocks);
                }
                for (const ls of conceptLeadingStocks) {
                    if (ls.code && !allCandidateCodes.includes(ls.code)) {
                        allCandidateCodes.push(ls.code);
                    }
                }
            } else {
                // 爬取失败，回退到API
                const conceptCons = (await getBoardConstituents(concept.code, 'concept', 200)).map(s => ({
                    code: s.code, name: s.name, exchange: '',
                }));
                conceptCodeSets.set(concept.code, new Set(conceptCons.map(s => s.code)));
            }

            // 收集强关联行业的候选股代码
            const industryResult = await mapConceptToIndustries(concept.code, concept.name, 3);
            conceptIndustryMap.set(concept.code, industryResult.strongly_related);
            for (const ind of industryResult.strongly_related) {
                const topStocks = await getBoardTopStocks(ind.code, 10, 'industry');
                for (const s of topStocks) {
                    if (s.code && !allCandidateCodes.includes(s.code)) {
                        allCandidateCodes.push(s.code);
                    }
                }
            }

            // 收集上下游行业的候选股代码（限制数量，使用与流向图一致的过滤逻辑）
            const transmission = await calculateTransmissionFactor(concept.name, industryResult.all_ranked);
            const filteredTrans = filterTransmissionForFlow(transmission);
            for (const up of filteredTrans.upstream.slice(0, 1)) {
                const indCode = industryBoards.find(i => i.name === up.name)?.code || '';
                if (!indCode) continue;
                const topStocks = await getBoardTopStocks(indCode, 10, 'industry');
                for (const s of topStocks) {
                    if (s.code && !allCandidateCodes.includes(s.code)) {
                        allCandidateCodes.push(s.code);
                    }
                }
            }
            for (const down of filteredTrans.downstream.slice(0, 1)) {
                const indCode = industryBoards.find(i => i.name === down.name)?.code || '';
                if (!indCode) continue;
                const topStocks = await getBoardTopStocks(indCode, 10, 'industry');
                for (const s of topStocks) {
                    if (s.code && !allCandidateCodes.includes(s.code)) {
                        allCandidateCodes.push(s.code);
                    }
                }
            }
        }

        // 批量获取Tushare增强数据（资金流向+每日指标+近10日日线）
        console.log(`[HotSectorAnalyzer] 批量获取Tushare增强数据，共${allCandidateCodes.length}只候选股...`);
        const enhancement = await fetchTushareEnhancement(allCandidateCodes);
        console.log(`[HotSectorAnalyzer] Tushare增强数据获取完成：资金流向${enhancement.moneyflowMap.size}只，THS资金${enhancement.moneyflowThsMap.size}只，每日指标${enhancement.dailyBasicMap.size}只，涨停${enhancement.limitListMap.size}只`);

        // 清除概念板块和行业映射的缓存，让后续调用重新获取（因为前面已经获取过一次了）
        // 不清除，因为缓存TTL=1小时，同一次分析内复用是合理的

        for (const concept of hotConcepts) {
            console.log(`[HotSectorAnalyzer] 分析风口概念: ${concept.name}`);

            // 2. 映射强关联二级行业
            const industryResult = await mapConceptToIndustries(concept.code, concept.name, 3);
            const relatedIndNames = industryResult.strongly_related.map(r => r.name);

            // 获取概念成分股代码集合
            const conceptCodes = conceptCodeSets.get(concept.code) || new Set();

            // 3. 计算上下游传导（使用全排名行业）
            const transmission = await calculateTransmissionFactor(concept.name, industryResult.all_ranked);

            // 4. AI判断持续性
            const aiAnalysis = await aiAnalyzeSector(concept.name, concept, transmission);

            // 5. 选股 - 强关联行业（风口精选）
            const mainStocks: SelectedStock[] = [];

            // 优先加入概念板块页面爬取的龙头股
            const conceptLeadingStocksForConcept = await fetchConceptLeadingStocks(concept.code);
            // 批量查询龙头股的实际行业板块（从 stocks 表，与个股详情页一致）
            const leadingIndustryMap = await getStocksIndustryMap(conceptLeadingStocksForConcept.map(ls => ls.code));
            for (const ls of conceptLeadingStocksForConcept) {
                if (conceptCodes.has(ls.code)) {
                    let price: number | null = null;
                    let changePct = 0;
                    const quoteResult = await fetchQuoteWithRetry(ls.code);
                    price = quoteResult.price;
                    changePct = quoteResult.changePct ?? 0;

                    // 从Tushare增强数据获取涨停标签和选股理由
                    const tsCode = toTsCodeFromEm(ls.code);
                    const limitData = tsCode ? enhancement?.limitListMap.get(tsCode) : undefined;
                    const mfThsData = tsCode ? enhancement?.moneyflowThsMap.get(tsCode) : undefined;
                    const dbData = tsCode ? enhancement?.dailyBasicMap.get(tsCode) : undefined;
                    const histData = tsCode ? enhancement?.dailyHistMap.get(tsCode) : undefined;

                    // 涨停标签：从Tushare limit_list_ths获取
                    // 北交所股票Tushare不支持limit_list_ths，用涨幅判断涨停（BJ涨停幅度30%，新股期除外）
                    const limitTags: string[] = ['龙头股'];
                    const isBJ = isBJStock(ls.code);
                    const isLimitUp = limitData != null || (isBJ && changePct >= 9.5);
                    let statusStr = limitData?.status || '';
                    if (!statusStr && isBJ && changePct >= 9.5) {
                        statusStr = changePct >= 29.5 ? '北交所涨停' : '涨停';
                    }
                    if (isLimitUp) {
                        if (statusStr) limitTags.push(statusStr);
                        const tagStr = limitData?.tag || '';
                        if (tagStr && !statusStr.includes(tagStr)) limitTags.push(tagStr);
                    }

                    // 龙头股评分：基础分 + 涨幅加分 + 涨停加分
                    let score = 60;
                    score += Math.min(15, Math.abs(changePct) * 2);
                    if (isLimitUp) score += 10;
                    score = Math.round(score * 10) / 10;

                    // 选股理由：优先用涨停原因，缺失时回退到公司简介（截断30字）
                    const limitTimes = statusStr.match(/(\d+)天(\d+)板/)?.[2]
                        ? parseInt(statusStr.match(/(\d+)天(\d+)板/)![2])
                        : (statusStr.includes('首板') ? 1 : 0);
                    const mf5day = mfThsData?.mf_5day || 0;
                    const turnover = dbData?.turnover_rate || 0;
                    const consecutiveUpDays = histData ? calcConsecutiveUpDays(histData) : 0;
                    const limitReason = limitData?.lu_desc || '';
                    let reason = limitReason;
                    // 北交所股票Tushare不支持limit_list_ths，对涨幅较大的BJ股补充默认原因
                    if (!reason && isBJStock(ls.code) && changePct >= 9.5) {
                        reason = '北交所个股涨停，资金关注度提升';
                    }
                    if (!reason && tsCode) {
                        try {
                            const companyData = await getStockCompany(tsCode);
                            if (companyData) {
                                reason = extractLeaderDescription(companyData.introduction || '', companyData.main_business || '');
                            }
                        } catch { /* ignore */ }
                    }

                    // reason_tag：只保留有特殊信号的标签，无信号则留空
                    let reasonTag = '';
                    let reasonTagClass = '';
                    if (isLimitUp && limitTimes >= 2) {
                        reasonTag = `${limitTimes}连板`;
                        reasonTagClass = 'tag-bullish';
                    } else if (isLimitUp) {
                        reasonTag = '昨日涨停';
                        reasonTagClass = 'tag-bullish';
                    } else if (consecutiveUpDays >= 5 && mf5day > 0) {
                        reasonTag = '强势连阳';
                        reasonTagClass = 'tag-trend';
                    } else if (consecutiveUpDays >= 3 && mf5day > 0) {
                        reasonTag = '资金连阳';
                        reasonTagClass = 'tag-trend';
                    } else if (changePct > 5 && turnover > 5) {
                        reasonTag = '量价齐升';
                        reasonTagClass = 'tag-trend';
                    }

                    mainStocks.push({
                        code: ls.code,
                        name: ls.name,
                        industry: leadingIndustryMap.get(ls.code) || concept.name,
                        score,
                        reason,
                        reason_tag: reasonTag,
                        reason_tag_class: reasonTagClass,
                        source: 'concept_page',
                        in_concept: true,
                        chain_position: '核心',
                        related_industry: concept.name,
                        overlap_ratio: 1,
                        price: price || 0,
                        change_pct: changePct,
                    });
                }
            }

            for (const ind of industryResult.strongly_related) {
                const indStocks = await selectStocksFromIndustry(
                    ind.code, ind.name, concept.name, conceptCodes, 2, enhancement,
                );
                for (const s of indStocks) {
                    s.chain_position = '核心';
                    s.related_industry = ind.name;
                    s.overlap_ratio = ind.overlap_ratio;
                }
                mainStocks.push(...indStocks);
            }

            // 去重（按股票代码去重，保留评分最高的）
            const seenCodes = new Set<string>();
            const uniqueMain: SelectedStock[] = [];
            for (const s of mainStocks.sort((a, b) => b.score - a.score)) {
                if (!seenCodes.has(s.code)) {
                    seenCodes.add(s.code);
                    uniqueMain.push(s);
                }
            }
            const finalMainStocks = uniqueMain.slice(0, 5);

            // 6. 先构建层级流向图数据（选股行业必须与流向图显示的完全一致）
            const flowData = buildFlowData(concept.name, industryResult.strongly_related, transmission, aiAnalysis);

            // 从流向图 nodes 提取上下游行业名（与流向图100%一致）
            const flowUpstreamNames = flowData.nodes.filter(n => n.type === 'upstream').map(n => n.id);
            const flowDownstreamNames = flowData.nodes.filter(n => n.type === 'downstream').map(n => n.id);

            // 从 transmission 中提取对应的 TransmissionItem（按流向图顺序去重，保留 factor 最高的）
            const pickItemsByFlowNames = (items: TransmissionItem[], names: string[]): TransmissionItem[] => {
                const result: TransmissionItem[] = [];
                const seen = new Set<string>();
                for (const name of names) {
                    if (seen.has(name)) continue;
                    seen.add(name);
                    const candidates = items.filter(it => it.name === name);
                    if (candidates.length > 0) {
                        candidates.sort((a, b) => b.factor - a.factor);
                        result.push(candidates[0]);
                    }
                }
                return result;
            };
            const upstreamItems = pickItemsByFlowNames(transmission.upstream, flowUpstreamNames);
            const downstreamItems = pickItemsByFlowNames(transmission.downstream, flowDownstreamNames);

            // 7. 选股 - 上下游行业（两阶段：先保每个行业1只，再按权重补足，确保规则生效）
            const calcPerIndustryCount = (items: TransmissionItem[]): Map<string, number> => {
                const countMap = new Map<string, number>();
                const total = items.length;
                if (total <= 3) {
                    items.forEach(item => countMap.set(item.name, 2));
                } else if (total === 4) {
                    items.forEach((item, i) => countMap.set(item.name, i < 2 ? 2 : 1));
                } else {
                    items.forEach((item, i) => countMap.set(item.name, i < 1 ? 2 : 1));
                }
                return countMap;
            };

            const selectTransmissionStocks = async (
                items: TransmissionItem[], totalCount: number, chainPosition: string,
            ): Promise<SelectedStock[]> => {
                if (items.length === 0) return [];
                const countMap = calcPerIndustryCount(items);
                const result: SelectedStock[] = [];
                const selectedCodes = new Set<string>();

                // 阶段1：每个行业至少选1只（确保流向图显示的每个行业都有股票）
                for (const item of items) {
                    if (result.length >= totalCount) break;
                    const indCode = industryBoards.find(i => i.name === item.name)?.code || '';
                    if (!indCode) continue;
                    const stocks = await selectStocksFromIndustry(
                        indCode, item.name, concept.name, conceptCodes, 1, enhancement,
                    );
                    for (const s of stocks) {
                        if (selectedCodes.has(s.code)) continue;
                        selectedCodes.add(s.code);
                        s.chain_position = chainPosition;
                        s.transmission_factor = item.factor;
                        s.source_industry = item.source_industry;
                        result.push(s);
                        break;
                    }
                }

                // 阶段2：按 factor 顺序补足到 totalCount
                for (const item of items) {
                    if (result.length >= totalCount) break;
                    const perCount = countMap.get(item.name) || 1;
                    if (perCount <= 1) continue;
                    const indCode = industryBoards.find(i => i.name === item.name)?.code || '';
                    if (!indCode) continue;
                    const remaining = totalCount - result.length;
                    const stocks = await selectStocksFromIndustry(
                        indCode, item.name, concept.name, conceptCodes, Math.min(perCount - 1, remaining), enhancement,
                    );
                    for (const s of stocks) {
                        if (selectedCodes.has(s.code)) continue;
                        selectedCodes.add(s.code);
                        s.chain_position = chainPosition;
                        s.transmission_factor = item.factor;
                        s.source_industry = item.source_industry;
                        result.push(s);
                    }
                }
                return result;
            };

            const upstreamStocks = await selectTransmissionStocks(upstreamItems, 6, '上游');
            const downstreamStocks = await selectTransmissionStocks(downstreamItems, 6, '下游');

            // 跨类别去重：上游和下游中移除已出现在核心的股票
            const mainCodes = new Set(finalMainStocks.map(s => s.code));
            const filteredUpstream = upstreamStocks.filter(s => !mainCodes.has(s.code));
            const filteredDownstream = downstreamStocks.filter(s => !mainCodes.has(s.code) && !filteredUpstream.some(u => u.code === s.code));

            // 8. 获取关联行业行情数据
            const industryData = await getIndustryStats(relatedIndNames);

            // 9. 提取龙头股信息
            const leadingStockInfo = await extractLeadingStock(
                concept.name, concept, finalMainStocks, concept.code, enhancement,
            );

            // 板块综合评分（用于泡泡图大小）：频次*5 + 均涨幅*3 + 最新涨幅*2
            const sectorScore = Math.round(
                (concept.frequency || 0) * 5 +
                (concept.avg_change || 0) * 3 +
                (concept.today_change || 0) * 2
            );

            result.hot_sectors.push({
                code: concept.code,
                name: concept.name,
                type: concept.type,
                frequency: concept.frequency,
                avg_change: concept.avg_change,
                today_change: concept.today_change,
                amount_trend: concept.amount_trend,
                net_inflow: concept.net_inflow,
                leading_stock: concept.leading_stock,
                leading_change: concept.leading_change,
                up_count: concept.up_count,
                down_count: concept.down_count,
                driver: concept.driver,
                score: sectorScore,
                related_industries: relatedIndNames,
                industry_data: industryData,
                ai_analysis: aiAnalysis,
                main_stocks: finalMainStocks,
                upstream_stocks: filteredUpstream,
                downstream_stocks: filteredDownstream,
                flow_data: flowData,
                leading_stock_info: leadingStockInfo,
            });
        }

        if (result.hot_sectors.length === 0) {
            // 空结果不覆盖旧数据，避免因外部 API 暂时不可用导致历史数据丢失
            console.warn('[WindLeaderAnalyzer] 风口龙头分析结果为空（可能外部 API 无数据或为非交易日），保留上次有效数据，不覆盖 hot-sectors.json');
        } else {
            await WindLeaderService.saveData(result);
            console.log(`[WindLeaderAnalyzer] 风口龙头分析完成，共 ${result.hot_sectors.length} 个板块，结果已保存并追加历史表现`);
        }

        return result;
    }
}
