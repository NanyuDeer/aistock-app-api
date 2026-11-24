import { mediaSources, unknownSources, rankedHotSectors, type SourceDetails } from './hotBurstSources';
/**
 * 机构调研推荐热门股整合服务
 *
 * 整合四个独立信号源：
 * 1. 财联社快讯（clsVerified）：该股票被财联社合格概念新闻直接提及
 * 2. 格隆汇快讯（glhVerified）：该股票被格隆汇合格概念新闻直接提及
 * 3. 同花顺热点掘金（thsVerified）：股票所属板块在同花顺热榜 Top10
 * 4. 研报验证（reportVerified）：24h 内有研报提及该股票
 *
 * 任意两个及以上信号源即构成共振（resonanceCount >= 2）
 */

import pool from '../../core/db';
import {
    getAiKeywordsForStock,
    type FeishuAiAnalysis,
} from './FeishuMessageAiService';
import { HotKeywordDetectorService, fetchDetectionNews, extractStockCodes, type HotConceptResult } from './HotKeywordDetectorService';
import { getThsHot, type ThsHotRow } from '../quote/TushareService';
import { findResearchReportMessagesForStock } from '../crawler/FeishuResearchReportService';
import { TencentQuoteService } from '../quote/TencentQuoteService';
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService';

/** 完整历史窗口的参数错误与依赖不可用分别映射为400、503。 */
export class HotBurstHistoryError extends Error {
    constructor(message: string, public readonly statusCode: 400 | 503) { super(message); }
}

/**
 * 「近 N 个交易日」→ 查询起点 ISO 字符串（最近 N 个交易日中最早那天的上海 00:00）。
 * 非法入参（缺失 / 非正整数 / >60）或日历不可用 → 返回 null（回落自然日 `days` 语义，保证零回归）。
 */
export function resolveTradingDaysStart(tradingDays: number | undefined, now: Date): string | null {
    if (typeof tradingDays !== 'number' || !Number.isInteger(tradingDays) || tradingDays < 1 || tradingDays > 60) {
        return null;
    }
    try {
        const list = TradingCalendarService.getRecentTradingDays(now, tradingDays);
        if (list.length === 0) return null;
        // getRecentTradingDays 返回的 Date 已归一化为上海 08:00 → 取日期部分再拼当日 00:00
        const earliest = list[list.length - 1].toISOString().slice(0, 10);
        return `${earliest}T00:00:00+08:00`;
    } catch (err: unknown) {
        // 日期推算类函数 fail-closed 时会抛错；此处降级为自然日语义，不让接口 500
        console.warn('[HotBurst] trading_days 起点计算失败，回落自然日 days:', err instanceof Error ? err.message : String(err));
        return null;
    }
}

// ==================== 类型定义 ====================

export interface FeishuMessageRow {
    id: number;
    source: string;
    chat_id: string;
    chat_name: string;
    message_id: string;
    message_type: string;
    text: string;
    stock_codes: string[];
    keywords: { keyword: string; dimension: string }[];
    ai_status: string;
    ai_analysis: FeishuAiAnalysis | null;
    received_at: string;
}

/** 个股共振信号（个股代码为主维度，关键词为辅助解释） */
interface StockResonanceSignal {
    source_details?: SourceDetails;
    /** 股票代码，如 "300308" */
    symbol: string;
    /** 股票名称 */
    stockName: string;
    /** 资讯提及次数 */
    newsCount: number;
    /** 资讯爆发比率（当前/历史） */
    newsSurgeRatio: number;
    /** 触发标签（概念名+板块名+维度关键词，去重合并） */
    triggerTags: string[];
    /** 飞书消息中该股票被提及次数 */
    feishuMessageCount: number;
    /** 同花顺验证 */
    thsVerified: boolean;
    thsSectorName: string;
    thsSectorRank: number;
    /** 共振强度得分 (0-100) */
    resonanceScore: number;
    /** 共振等级 */
    resonanceLevel: 'critical' | 'high' | 'medium' | 'low';
    /** 最新股价 */
    price: number | null;
    /** 涨跌幅(%) */
    changePct: number | null;
    /** 板块信息（同花顺验证板块或概念共振） */
    sectorInfo: string;
    /** 概念共振信息 */
    conceptResonance: {
        conceptName: string;
        clsCount: number;
        glhCount: number;
        conceptVerified: boolean;
    } | null;
    /** 相关快讯 */
    articles: { id: string; title: string; source: string; time: string }[];
    /** 检测时间 */
    detectedAt: string;
    /** 四信号源共振状态 */
    clsVerified: boolean;           // 财联社信号：该股票被财联社合格概念新闻直接提及
    glhVerified: boolean;           // 格隆汇信号：该股票被格隆汇合格概念新闻直接提及
    reportVerified: boolean;        // 研报信号：24h内有研报提及
    /** 共振信号数量（1-4，至少2才展示） */
    resonanceCount: number;
    /** 概念详情 */
    conceptDetail: {
        conceptName: string;
        clsCount: number;
        glhCount: number;
    } | null;
    /** 研报详情 */
    reportDetail: {
        reportCount: number;
        latestReportTime?: string;
    } | null;
}

interface HotBurstResult {
    update_time: string;
    total_stocks_checked: number;
    resonance_count: number;
    ths_hot_sectors: { name: string; rank: number; change_pct: number }[];
    outbreaks: StockResonanceSignal[];
    hot_concepts: HotConceptResult[];
}

export const __hotBurstDependencies = { getThsHot };

// ==================== 同花顺热点掘金验证 ====================

async function fetchThsHotSectors(): Promise<{ code: string; name: string; rank: number; change_pct: number }[]> {
    const today = new Date();
    const dateStrs = [0, 1, 2].map(offset => {
        const d = new Date(today);
        d.setDate(d.getDate() - offset);
        return formatDate(d);
    });

    const results = await Promise.all(dateStrs.map(async dateStr => {
        try {
            const hotData = await withTimeout<ThsHotRow[]>(
                __hotBurstDependencies.getThsHot(dateStr, '概念板块'),
                10000,
                [],
                `同花顺热榜 date=${dateStr}`,
            );
            console.log(`[HotBurst] 同花顺热榜 date=${dateStr} rows=${hotData.length}`);
            return { dateStr, hotData };
        } catch (err) {
            console.warn(`[HotBurst] 同花顺热榜 date=${dateStr} 获取失败:`, (err as Error).message);
            return { dateStr, hotData: [] as ThsHotRow[] };
        }
    }));

    const latestAvailable = results.find(result => result.hotData.length > 0);
    if (latestAvailable) {
        console.log(`[HotBurst] 同花顺热榜使用日期 ${latestAvailable.dateStr}`);
        return rankedHotSectors(latestAvailable.hotData);
    }

    console.warn(`[HotBurst] 同花顺热榜最近 ${dateStrs.length} 天均无可用数据: ${dateStrs.join(',')}`);
    return [];
}

function formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

/** 带超时的 Promise 包装，超时后返回 fallback 值 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        promise,
        new Promise<T>((resolve) =>
            timer = setTimeout(() => {
                console.warn(`[HotBurst] ${label} 超时 (${ms}ms)，使用 fallback`);
                resolve(fallback);
            }, ms)
        ),
    ]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

// ==================== 辅助函数 ====================

/** 从 stocks 表查询股票名称 */
async function getStockName(symbol: string): Promise<string> {
    try {
        const result = await pool.query('SELECT name FROM stocks WHERE symbol = $1 LIMIT 1', [symbol]);
        return result.rows[0]?.name || '';
    } catch {
        return '';
    }
}

/** 批量查询个股所属板块（通过 stock_concept_mapping 表） */
async function getStockSectors(symbols: string[]): Promise<Map<string, string[]> & { available?: boolean; codes?: Map<string, string> }> {
    const sectorsByStock = Object.assign(new Map<string, string[]>(), { available: true, codes: new Map<string, string>() });
    if (symbols.length === 0) return sectorsByStock;

    try {
        const result = await pool.query(
            `SELECT symbol, sector_name, sector_code
             FROM stock_concept_mapping
             WHERE symbol = ANY($1::text[])
             GROUP BY symbol, sector_name, sector_code`,
            [symbols]
        );
        for (const row of result.rows) {
            if (row.sector_code) sectorsByStock.codes.set(`${row.symbol}|${row.sector_name}`, row.sector_code);
            const sectors = sectorsByStock.get(row.symbol) || [];
            sectors.push(row.sector_name);
            sectorsByStock.set(row.symbol, sectors);
        }
    } catch (err) {
        sectorsByStock.available = false;
        console.warn('[HotBurst] 板块映射查询失败，本次同花顺验证降级:', err instanceof Error ? err.message : String(err));
        // 板块验证失败时保留空映射，其他三个信号源仍可正常参与共振。
    }
    return sectorsByStock;
}

/**
 * 共振评分算法（新）
 *
 * 维度权重：
 * - 媒体爆发力（25%）：资讯频次 + 爆发比率
 * - 信号源共振加成（40%）：共振源越多分越高
 * - 板块热度（20%）：同花顺板块排名
 * - 研报加成（15%）：有研报额外加分
 */
function calculateResonanceScore(
    newsCount: number,
    newsSurgeRatio: number,
    thsRank: number,
    thsVerified: boolean,
    reportVerified: boolean,
    resonanceCount: number,
): { score: number; level: 'critical' | 'high' | 'medium' | 'low' } {
    // 媒体爆发力得分（0-100）
    const newsScore = Math.min(100, Math.min(newsCount, 10) * 10 + Math.min(newsSurgeRatio, 5) * 10);

    // 信号源共振加成（0-100）
    // 二重=40, 三重=70, 四重=100, 单源=0
    let resonanceBonus = 0;
    if (resonanceCount >= 4) resonanceBonus = 100;
    else if (resonanceCount >= 3) resonanceBonus = 70;
    else if (resonanceCount >= 2) resonanceBonus = 40;

    // 板块热度得分（0-100）
    let thsScore = 0;
    if (thsVerified) {
        if (thsRank === 1) thsScore = 100;
        else if (thsRank <= 3) thsScore = 80;
        else if (thsRank <= 5) thsScore = 60;
        else if (thsRank <= 10) thsScore = 40;
    }
    
    
     // 研报加成得分（0-100）
    const reportScore = reportVerified ? 80 : 0;

    const score = Math.round(
        newsScore * 0.25 +
        resonanceBonus * 0.40 +
        thsScore * 0.20 +
        reportScore * 0.15
    );

    let level: 'critical' | 'high' | 'medium' | 'low';
    if (score >= 80) level = 'critical';
    else if (score >= 55) level = 'high';
    else if (score >= 30) level = 'medium';
    else level = 'low';

    return { score, level };
}

/** 计算 CLS、格隆汇、同花顺和研报（含 QQ 研报）四类独立信号的共振数量。 */
export function countResonanceSources(...signals: boolean[]): number {
    return signals.filter(Boolean).length;
}

// ==================== 飞书消息查询 ====================

/**
 * 补充飞书消息中的股票代码（当 stock_codes 为空时从文本提取）
 * 依赖 loadStockNameMap 已加载（detectHotBurst 中 detectHotStocks 会预加载）
 */
export function enrichFeishuStockCodes(messages: FeishuMessageRow[]): FeishuMessageRow[] {
    return messages.map(msg => {
        if (msg.stock_codes && msg.stock_codes.length > 0) return msg;
        const codes = extractStockCodes(msg.text || '');
        const symbols = Array.from(codes.keys());
        if (symbols.length === 0) return msg;
        return { ...msg, stock_codes: symbols };
    });
}

async function getFeishuMessages(hours: number = 6): Promise<FeishuMessageRow[]> {
    try {
        const result = await pool.query(
            `SELECT id, source, chat_id, chat_name, message_id, message_type,
                    text, stock_codes, keywords, ai_status, ai_analysis, received_at
             FROM feishu_messages
             WHERE received_at > NOW() - INTERVAL '${hours} hours'
             ORDER BY received_at DESC
             LIMIT 200`,
        );
        const rows: FeishuMessageRow[] = result.rows.map((row: any) => ({
            ...row,
            stock_codes: row.stock_codes || [],
            keywords: typeof row.keywords === 'string' ? JSON.parse(row.keywords) : row.keywords || [],
            ai_status: String(row.ai_status || 'skipped'),
            ai_analysis: typeof row.ai_analysis === 'string'
                ? JSON.parse(row.ai_analysis)
                : row.ai_analysis || null,
        }));
        // 回退：当 stock_codes 为空时从文本提取
        return enrichFeishuStockCodes(rows);
    } catch (err) {
        console.warn('[HotBurst] 群消息查询失败，本次消息标签降级:', err instanceof Error ? err.message : String(err));
        return [];
    }
}

// ==================== 整合服务 ====================

export class HotBurstService {
    /** 用缓存行情批量刷新 outbreaks 的价格和涨跌幅 */
    private static async refreshOutbreaksQuotes(outbreaks: StockResonanceSignal[]): Promise<void> {
        try {
            const symbols = outbreaks.map(s => s.symbol);
            const quotes = await TencentQuoteService.getCachedBatchQuotes(symbols, 'core');
            for (let i = 0; i < outbreaks.length; i++) {
                const q = quotes[i];
                if (q && !('错误' in q)) {
                    const price = q['最新价'];
                    const changePct = q['涨跌幅'];
                    if (price && price > 0) outbreaks[i].price = price;
                    if (changePct !== undefined && changePct !== null) outbreaks[i].changePct = changePct;
                }
            }
        } catch (e) {
            console.warn('[HotBurst] 刷新行情失败:', (e as Error).message);
        }
    }

    /**
     * 执行完整的机构调研推荐热门股检测（四信号源共振模型）：
     * 1. 财联社/格隆汇热门概念关联股票、QQ/研报提及股票共同构建候选池
     * 2. 同花顺热榜验证（股票所属板块是否上榜）
     * 3. 统一计算四类独立信号的共振数
     *
     * 四个信号源任意两个及以上即构成共振
     */
    static async detectHotBurst(): Promise<HotBurstResult> {
        console.log('[HotBurst] 开始机构调研推荐热门股检测（三源候选池）...');

        const now = new Date().toISOString();
        let news: ReturnType<typeof fetchDetectionNews> | undefined;
        const loadNews = () => news ??= withTimeout(fetchDetectionNews(), 15000, {
            clsArticles: [], glhArticles: [], sourceAvailability: { cls: false, glh: false },
        }, '新闻源获取');

        // ===== Step 1: 个股爆发检测（代码提取替代关键词匹配） =====
        const hotStocks = await withTimeout(
            HotKeywordDetectorService.detectHotStocks(loadNews), 30000, [], 'Step1:个股爆发检测'
        );
        console.log(`[HotBurst] Step1: 检测到 ${hotStocks.length} 只爆发个股`);

        // ===== Step 1.5: 细分概念爆发检测（共振一：交叉验证） =====
        const hotConcepts = await withTimeout(
            HotKeywordDetectorService.detectHotConcepts(loadNews).catch(err => { console.warn('[HotBurst] 概念检测失败', err); return Object.assign([], { sourceAvailability: { cls: false, glh: false } }); }), 20000, Object.assign([], { sourceAvailability: { cls: false, glh: false } }), 'Step1.5:概念爆发检测'
        );
        console.log(`[HotBurst] Step1.5: 检测到 ${hotConcepts.length} 个爆发细分概念`);

        // 构建：股票代码 → 匹配到的概念列表
        const stockConceptMap = new Map<string, HotConceptResult>();
        for (const concept of hotConcepts) {
            for (const stock of concept.stockCodes) {
                if (!stockConceptMap.has(stock.symbol)) {
                    stockConceptMap.set(stock.symbol, concept);
                }
            }
        }

        // 对爆发个股，同步匹配关键词作为"原因标签"
        const keywordResults = await withTimeout(
            HotKeywordDetectorService.detectHotKeywords(loadNews).catch(err => { console.warn('[HotBurst] 关键词降级:', err); return []; }),
            15000, [], '关键词标签',
        );

        // 构建：每个股票代码 → 与其相关的关键词列表（通过 articleIds 交叉匹配）
        const stockKeywordsMap = new Map<string, string[]>();
        for (const stock of hotStocks) {
            const stockArticleIds = new Set(stock.articles.map(a => a.id));
            const matchedKws: string[] = [];
            for (const kw of keywordResults) {
                for (const a of kw.articles) {
                    if (stockArticleIds.has(a.id)) {
                        matchedKws.push(kw.keyword);
                        break;
                    }
                }
            }
            stockKeywordsMap.set(stock.symbol, [...new Set(matchedKws)]);
        }

        // ===== Step 2: 飞书群消息关联 =====
        const feishuWindowHours = TradingCalendarService.getFeishuWindowHours();
        console.log(`[HotBurst] 飞书消息查询窗口: ${feishuWindowHours}h`);
        const feishuMessages = await withTimeout(
            getFeishuMessages(feishuWindowHours), 15000, [], 'Step2:飞书消息查询'
        );
        console.log(`[HotBurst] Step2: 获取到 ${feishuMessages.length} 条飞书群消息`);

        // 构建：股票代码 → 飞书消息数 + 关键词
        const feishuStockMap = new Map<string, {
            messageCount: number;
            keywords: Set<string>;
            aiKeywords: Set<string>;
        }>();
        for (const msg of feishuMessages) {
            for (const code of msg.stock_codes) {
                const existing = feishuStockMap.get(code);
                if (existing) {
                    existing.messageCount++;
                    for (const kw of msg.keywords) existing.keywords.add(kw.keyword);
                    if (msg.ai_status === 'succeeded') {
                        for (const kw of getAiKeywordsForStock(msg.ai_analysis, code)) {
                            existing.aiKeywords.add(kw);
                        }
                    }
                } else {
                    const kwSet = new Set<string>();
                    for (const kw of msg.keywords) kwSet.add(kw.keyword);
                    const aiKeywordSet = new Set<string>();
                    if (msg.ai_status === 'succeeded') {
                        for (const kw of getAiKeywordsForStock(msg.ai_analysis, code)) {
                            aiKeywordSet.add(kw);
                        }
                    }
                    feishuStockMap.set(code, {
                        messageCount: 1,
                        keywords: kwSet,
                        aiKeywords: aiKeywordSet,
                    });
                }
            }
        }

        // ===== Step 2.5: 预加载研报数据（批量，避免逐个查询） =====
        // QQ 已接替原飞书研报群：QQ 群内带股票代码的消息均作为研报信号。
        let reportsAvailable = true;
        const reportStockSet = new Map<string, { count: number; latestTime: string; ids: Set<number> }>();
        try {
            const reportMessages = await pool.query(
                `SELECT id, stock_codes, received_at FROM feishu_messages
                 WHERE received_at > NOW() - INTERVAL '24 hours'
                   AND (source = 'qq' OR chat_name LIKE '%研报%')
                   AND array_length(stock_codes, 1) IS NOT NULL`
            );
            for (const row of reportMessages.rows) {
                for (const code of new Set<string>(row.stock_codes || [])) {
                    const existing = reportStockSet.get(code);
                    if (existing) {
                        existing.ids.add(row.id);
                        existing.count = existing.ids.size;
                        if (new Date(row.received_at).getTime() > new Date(existing.latestTime).getTime()) {
                            existing.latestTime = row.received_at;
                        }
                    } else {
                        reportStockSet.set(code, { count: 1, latestTime: row.received_at, ids: new Set([row.id]) });
                    }
                }
            }
            console.log(`[HotBurst] Step2.5: 预加载研报数据，覆盖 ${reportStockSet.size} 只股票`);
        } catch (err) {
            reportsAvailable = false;
            console.warn('[HotBurst] Step2.5: 研报预加载失败:', (err as Error).message);
        }

        // 候选池不再受“爆发个股”限制：热门概念关联股票与 QQ/研报提及股票均可参与共振计算。
        const candidateStocks = new Map<string, string>();
        for (const concept of hotConcepts) {
            for (const stock of concept.stockCodes) {
                candidateStocks.set(stock.symbol, stock.name);
            }
        }
        for (const symbol of reportStockSet.keys()) {
            if (!candidateStocks.has(symbol)) candidateStocks.set(symbol, '');
        }
        console.log(`[HotBurst] 候选池: 热门概念 + QQ/研报，共 ${candidateStocks.size} 只股票`);

        // Step1 仅补充候选股票的快讯强度和关键词，不再作为候选池的准入条件。
        const hotStockMap = new Map(hotStocks.map(stock => [stock.symbol, stock]));

        // ===== Step 3: 同花顺热榜验证 =====
        const thsHotSectors = await withTimeout(
            fetchThsHotSectors(), 30000, [], 'Step3:同花顺热榜'
        );
        console.log(`[HotBurst] Step3: 同花顺热榜 ${thsHotSectors.length} 个板块`);

        const stockSectorsMap = await getStockSectors(Array.from(candidateStocks.keys()));

        // ===== 整合：对候选池统一计算四类信号 =====
        const outbreaks: StockResonanceSignal[] = [];

        for (const [symbol, candidateName] of candidateStocks) {
            const hotStock = hotStockMap.get(symbol);
            const feishuData = feishuStockMap.get(symbol);
            const feishuMsgCount = feishuData?.messageCount || 0;

            // 同花顺验证：查该股票所属板块是否在热榜
            let thsVerified = false;
            let thsSectorName = '';
            let thsSectorRank = 0;

            const stockSectors = stockSectorsMap.get(symbol) || [];
            const matchedSectors = stockSectors.flatMap(sector => {
                const code = stockSectorsMap.codes?.get(`${symbol}|${sector}`);
                const hot = thsHotSectors.find(s => code
                    ? s.code.split('.')[0] === code.split('.')[0]
                    : s.name === sector);
                return hot ? [{ code: hot.code, name: hot.name, rank: hot.rank }] : [];
            }).sort((a, b) => a.rank - b.rank);
            if (matchedSectors.length) {
                thsVerified = true;
                thsSectorName = matchedSectors[0].name;
                thsSectorRank = matchedSectors[0].rank;
            }
            const stockName = hotStock?.stockName || candidateName || await getStockName(symbol);

            // 构建触发标签：概念名 + 板块名 + 维度关键词
            const triggerTagsSet = new Set<string>();
            if (feishuData) {
                for (const kw of feishuData.aiKeywords) triggerTagsSet.add(kw);
                for (const kw of feishuData.keywords) triggerTagsSet.add(kw);
            }
            const conceptInfo = stockConceptMap.get(symbol);
            if (conceptInfo?.conceptName) triggerTagsSet.add(conceptInfo.conceptName);
            if (thsVerified && thsSectorName) triggerTagsSet.add(thsSectorName);
            const dimKws = stockKeywordsMap.get(symbol) || [];
            for (const kw of dimKws) triggerTagsSet.add(kw);

            outbreaks.push({
                symbol,
                source_details: { ...unknownSources(), ths: { status: thsVerified ? 'passed' : 'not_passed', matched_sectors: matchedSectors } },
                stockName,
                newsCount: hotStock?.currentCount || 0,
                newsSurgeRatio: hotStock?.surgeRatio || 0,
                triggerTags: Array.from(triggerTagsSet),
                feishuMessageCount: feishuMsgCount,
                thsVerified,
                thsSectorName,
                thsSectorRank,
                resonanceScore: 0,
                resonanceLevel: 'low',
                price: null,
                changePct: null,
                sectorInfo: thsVerified ? thsSectorName : (conceptInfo?.conceptName || ''),
                conceptResonance: stockConceptMap.has(symbol) ? {
                    conceptName: stockConceptMap.get(symbol)!.conceptName,
                    clsCount: stockConceptMap.get(symbol)!.clsCount,
                    glhCount: stockConceptMap.get(symbol)!.glhCount,
                    conceptVerified: stockConceptMap.get(symbol)!.crossVerified,
                } : null,
                articles: hotStock?.articles || [],
                detectedAt: hotStock?.detectedAt || now,
                clsVerified: false,
                glhVerified: false,
                reportVerified: false,
                resonanceCount: 0,
                conceptDetail: null,
                reportDetail: null,
            });
        }

        // 补充共振状态
        for (const signal of outbreaks) {
            // 财联社信号：所属概念在财联社被提及
            const matchedSectors = signal.source_details?.ths.matched_sectors ?? [];
            signal.source_details = mediaSources(signal.symbol, hotConcepts, hotConcepts.sourceAvailability ?? { cls: true, glh: true });
            signal.clsVerified = signal.source_details.cls.status === 'passed';
            // 格隆汇信号：所属概念在格隆汇被提及
            signal.glhVerified = signal.source_details.glh.status === 'passed';

            // 概念详情
            if (signal.conceptResonance) {
                signal.conceptDetail = {
                    conceptName: signal.conceptResonance.conceptName,
                    clsCount: signal.conceptResonance.clsCount,
                    glhCount: signal.conceptResonance.glhCount,
                };
            }

            // 研报验证（从预加载的 reportStockSet 批量查询）
            const reportData = reportStockSet.get(signal.symbol);
            signal.reportVerified = !!reportData && reportData.count > 0;
            if (reportData && reportData.count > 0) {
                signal.reportDetail = {
                    reportCount: reportData.count,
                    latestReportTime: reportData.latestTime,
                };
            }

            signal.source_details.qq = {
                status: !reportsAvailable ? 'unavailable' : signal.reportVerified ? 'passed' : 'not_passed',
                stock_mention_count: reportData?.count ?? 0,
                evidence_message_ids: [...(reportData?.ids ?? [])].sort((a, b) => a - b),
            };
            signal.source_details.ths = {
                status: !thsHotSectors.length || !stockSectorsMap.available ? 'unavailable' : signal.thsVerified ? 'passed' : 'not_passed',
                matched_sectors: matchedSectors,
            };
            // 计算共振数量（四个信号源）：CLS、格隆汇、同花顺、研报/QQ 
            signal.resonanceCount = countResonanceSources(
                signal.clsVerified,
                signal.glhVerified,
                signal.thsVerified,
                signal.reportVerified,
            );

            // 重新计算评分（使用新算法）
            const { score, level } = calculateResonanceScore(
                signal.newsCount, signal.newsSurgeRatio,
                signal.thsSectorRank, signal.thsVerified,
                signal.reportVerified,
                signal.resonanceCount,
            );
            signal.resonanceScore = score;
            signal.resonanceLevel = level;
        }

        const qualifiedOutbreaks = outbreaks
            .filter(signal => signal.resonanceCount >= 2)
            .sort((a, b) => b.resonanceScore - a.resonanceScore);
        console.log(`[HotBurst] 检测完成: ${qualifiedOutbreaks.length} 个二源及以上机构调研热门信号`);

        // 批量获取股价（走缓存，避免重复请求接口）
        // 交易时间用实时行情，非交易时间也查询一次获取最新收盘价
        const isTradingHours = (() => {
            const now = new Date();
            const h = now.getHours();
            const m = now.getMinutes();
            const day = now.getDay();
            // 周一至周五 9:15-15:05（北京时间，TZ=Asia/Shanghai）
            return day >= 1 && day <= 5 && ((h === 9 && m >= 15) || (h >= 10 && h < 15) || (h === 15 && m <= 5));
        })();

        const symbols = qualifiedOutbreaks.map(s => s.symbol);
        const quoteResults = await TencentQuoteService.getCachedBatchQuotes(symbols, 'core');
        for (let i = 0; i < qualifiedOutbreaks.length; i++) {
            const signal = qualifiedOutbreaks[i];
            const quote = quoteResults[i];
            if (quote && !('错误' in quote)) {
                const price = quote['最新价'];
                const changePct = quote['涨跌幅'];
                // 只在交易时间或首次获取时写入，避免非交易时间写入 0
                if (isTradingHours || !signal.price) {
                    signal.price = (price && price > 0) ? price : null;
                    signal.changePct = (changePct !== undefined && changePct !== null) ? changePct : null;
                }
            }
        }
        if (!isTradingHours) {
            console.log('[HotBurst] 非交易时间，已获取最新收盘价');
        }

        const result: HotBurstResult = {
            update_time: now,
            total_stocks_checked: candidateStocks.size,
            resonance_count: qualifiedOutbreaks.length,
            ths_hot_sectors: thsHotSectors,
            outbreaks: qualifiedOutbreaks,
            hot_concepts: hotConcepts,
        };

        // 历史发布成功后才能替换上次成功结果；写入失败继续保留旧缓存。
        await HotBurstService.saveHistory(result);

        // 更新缓存
        HotBurstService.lastDetectResult = result;
        HotBurstService.lastDetectTime = Date.now();

        return result;
    }

    /** 将检测结果保存到历史表 */
    static async saveHistory(result: HotBurstResult): Promise<void> {
        // 历史表保留二源及以上的检测快照；展示与 Agent 在查询时各自筛选。
        const qualifiedSignals = result.outbreaks.filter(s => s.resonanceCount >= 2);
        if (!qualifiedSignals.length) {
            console.log('[HotBurst] 无二源共振信号，跳过历史入库');
            return;
        }
        try {
            // legacy detected_at 是无时区列，历史写入使用 ISO UTC。
            // 显式落为 UTC 墙上时间；读取转回 timestamptz，不能按主机本地时区解释。
            const detectedAt = result.update_time;
            const rows = qualifiedSignals.map(s => [
                detectedAt, s.symbol, s.stockName || s.symbol,
                s.resonanceScore, s.resonanceLevel,
                s.price, s.changePct, s.sectorInfo,
                s.triggerTags.join('、'),
                s.newsCount, s.feishuMessageCount, s.thsVerified,
                s.resonanceCount, JSON.stringify(s.source_details ?? unknownSources()),
            ]);
            const placeholders = rows.map((_, i) =>
                `(($${i * 14 + 1}::timestamptz AT TIME ZONE 'UTC'), $${i * 14 + 2}, $${i * 14 + 3}, $${i * 14 + 4}, $${i * 14 + 5}, $${i * 14 + 6}, $${i * 14 + 7}, $${i * 14 + 8}, $${i * 14 + 9}, $${i * 14 + 10}, $${i * 14 + 11}, $${i * 14 + 12}, $${i * 14 + 13}, $${i * 14 + 14}::jsonb)`
            ).join(', ');
            const values = rows.flat();
            await pool.query(
                `INSERT INTO institution_research_history (detected_at, symbol, stock_name, resonance_score, resonance_level, price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count, source_details)
                 VALUES ${placeholders}`,
                values
            );
            console.log(`[HotBurst] 保存 ${rows.length} 条二源及以上共振历史记录（总信号 ${result.outbreaks.length} 条）`);
        } catch (err) {
            console.error('[HotBurst] 保存历史记录失败:', (err as Error).message);
            throw err;
        }
    }

    /**
     * 查询历史机构调研推荐热门股记录
     * @param minResonanceOnly 旧参数：true 时仅返回二源及以上，false 时不过滤
     * @param minResonance 新参数：显式传入时覆盖 minResonanceOnly
     * @param all 单条SELECT取全1至3交易日窗口，忽略limit/offset；参数错误400、无法确定窗口503
     */
    static async getHistory(
        limit: number = 50,
        offset: number = 0,
        minResonanceOnly: boolean = true,
        days: number = 30,
        minResonance?: number,
        tradingDays?: number,
        all: boolean = false,
    ): Promise<{ total: number; records: any[] }> {
        let total: number;
        let records: any[];
        const safeDays = Math.min(Math.max(days, 1), 365);
        const isoStart = resolveTradingDaysStart(tradingDays, new Date());

        if (all) {
            if (!Number.isInteger(tradingDays) || tradingDays! < 1 || tradingDays! > 3) {
                throw new HotBurstHistoryError('完整窗口查询仅支持1至3个交易日', 400);
            }
            if (!isoStart) throw new HotBurstHistoryError('交易日历不可用，无法确定完整窗口', 503);
            const minimum = minResonance === undefined
                ? (minResonanceOnly ? 2 : 0)
                : Math.min(Math.max(minResonance, 2), 4);
            // 单条SELECT使用同一MVCC快照，无跨页offset移动和count/select不一致。
            const result = await pool.query(
                `SELECT id, (detected_at AT TIME ZONE 'UTC') AS detected_at, symbol, stock_name,
                        resonance_score, resonance_level, price, change_pct, sector_info, keywords,
                        news_count, feishu_count, ths_verified, resonance_count, source_details
                 FROM institution_research_history
                 WHERE resonance_count >= $1
                   AND detected_at >= ($2::timestamptz AT TIME ZONE 'UTC')
                 ORDER BY institution_research_history.detected_at DESC, resonance_score DESC, id DESC`,
                [minimum, isoStart],
            );
            records = result.rows.map(r => ({ ...r, source_details: r.source_details ?? unknownSources() }));
            total = records.length;
        } else if (minResonance !== undefined) {
            const safeMinResonance = Math.min(Math.max(minResonance, 2), 4);
            const countResult = await pool.query(
                `SELECT COUNT(*)::int AS total FROM institution_research_history
                 WHERE resonance_count >= $1
                   AND ${isoStart ? "detected_at >= ($2::timestamptz AT TIME ZONE 'UTC')" : "detected_at >= (NOW() AT TIME ZONE 'UTC') - ($2::text || ' days')::interval"}`,
                isoStart ? [safeMinResonance, isoStart] : [safeMinResonance, safeDays]
            );
            total = countResult.rows[0]?.total || 0;

            const result = await pool.query(
                `SELECT id, (detected_at AT TIME ZONE 'UTC') AS detected_at, symbol, stock_name, resonance_score, resonance_level,
                        price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count, source_details
                 FROM institution_research_history
                 WHERE resonance_count >= $3
                   AND ${isoStart ? "detected_at >= ($4::timestamptz AT TIME ZONE 'UTC')" : "detected_at >= (NOW() AT TIME ZONE 'UTC') - ($4::text || ' days')::interval"}
                 ORDER BY institution_research_history.detected_at DESC, resonance_score DESC, id DESC
                 LIMIT $1 OFFSET $2`,
                isoStart ? [limit, offset, safeMinResonance, isoStart] : [limit, offset, safeMinResonance, safeDays]
            );
            records = result.rows.map(r => ({ ...r, source_details: r.source_details ?? unknownSources() }));
        } else

        if (minResonanceOnly) {
            const countResult = await pool.query(
                `SELECT COUNT(*)::int AS total FROM institution_research_history
                 WHERE resonance_count >= 2
                   AND ${isoStart ? "detected_at >= ($1::timestamptz AT TIME ZONE 'UTC')" : "detected_at >= (NOW() AT TIME ZONE 'UTC') - ($1::text || ' days')::interval"}`,
                isoStart ? [isoStart] : [safeDays]
            );
            total = countResult.rows[0]?.total || 0;

            const result = await pool.query(
                `SELECT id, (detected_at AT TIME ZONE 'UTC') AS detected_at, symbol, stock_name, resonance_score, resonance_level,
                        price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count, source_details
                 FROM institution_research_history
                 WHERE resonance_count >= 2
                   AND ${isoStart ? "detected_at >= ($3::timestamptz AT TIME ZONE 'UTC')" : "detected_at >= (NOW() AT TIME ZONE 'UTC') - ($3::text || ' days')::interval"}
                 ORDER BY institution_research_history.detected_at DESC, resonance_score DESC, id DESC
                 LIMIT $1 OFFSET $2`,
                isoStart ? [limit, offset, isoStart] : [limit, offset, safeDays]
            );
            records = result.rows.map(r => ({ ...r, source_details: r.source_details ?? unknownSources() }));
        } else {
            const countResult = await pool.query(
                `SELECT COUNT(*)::int AS total FROM institution_research_history
                 WHERE ${isoStart ? "detected_at >= ($1::timestamptz AT TIME ZONE 'UTC')" : "detected_at >= (NOW() AT TIME ZONE 'UTC') - ($1::text || ' days')::interval"}`,
                isoStart ? [isoStart] : [safeDays]
            );
            total = countResult.rows[0]?.total || 0;

            const result = await pool.query(
                `SELECT id, (detected_at AT TIME ZONE 'UTC') AS detected_at, symbol, stock_name, resonance_score, resonance_level,
                        price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count, source_details
                 FROM institution_research_history
                 WHERE ${isoStart ? "detected_at >= ($3::timestamptz AT TIME ZONE 'UTC')" : "detected_at >= (NOW() AT TIME ZONE 'UTC') - ($3::text || ' days')::interval"}
                 ORDER BY institution_research_history.detected_at DESC, resonance_score DESC, id DESC
                 LIMIT $1 OFFSET $2`,
                isoStart ? [limit, offset, isoStart] : [limit, offset, safeDays]
            );
            records = result.rows.map(r => ({ ...r, source_details: r.source_details ?? unknownSources() }));
        }

        // 刷新行情数据
        try {
            const symbols: string[] = [...new Set<string>(records.map(r => r.symbol))];
            const quotes = await TencentQuoteService.getCachedBatchQuotes(symbols, 'core');
            const bySymbol = new Map(symbols.map((symbol, i) => [symbol, quotes[i]]));
            for (let i = 0; i < records.length; i++) {
                const q = bySymbol.get(records[i].symbol);
                if (q && !('错误' in q)) {
                    const price = q['最新价'];
                    const changePct = q['涨跌幅'];
                    if (price && price > 0) records[i].price = price;
                    if (changePct !== undefined && changePct !== null) records[i].change_pct = changePct;
                }
            }
        } catch (e) {
            console.warn('[HotBurst] getHistory 刷新行情失败:', (e as Error).message);
        }

        return { total, records };
    }

    /** 最近一次检测结果缓存 */
    private static lastDetectResult: HotBurstResult | null = null;
    private static lastDetectTime: number = 0;
    private static readonly DETECT_CACHE_TTL = 90 * 60 * 1000; // 1.5小时缓存（缩短避免长时间显示旧数据）

    /**
     * 获取最近的机构调研推荐热门股检测结果
     * 优先返回缓存，缓存过期则执行一次检测
     * @param minResonanceCount 最小有效共振数量过滤（0=不过滤）
     */
    static async getRecentBursts(hours: number = 6, minResonanceCount: number = 0): Promise<HotBurstResult | null> {
        const safeHours = Math.min(Math.max(hours, 1), 72);
        if (HotBurstService.lastDetectResult && (Date.now() - HotBurstService.lastDetectTime) < HotBurstService.DETECT_CACHE_TTL) {
            // 刷新内存缓存中的行情数据
            await HotBurstService.refreshOutbreaksQuotes(HotBurstService.lastDetectResult.outbreaks);
            if (minResonanceCount > 0) {
                const cachedResult = {
                    ...HotBurstService.lastDetectResult,
                    outbreaks: HotBurstService.lastDetectResult.outbreaks.filter(
                        s => s.resonanceCount >= minResonanceCount
                    ),
                };
                cachedResult.resonance_count = cachedResult.outbreaks.length;
                return cachedResult.outbreaks.length
                    ? cachedResult
                    : await HotBurstService.fallbackFromDB(safeHours, minResonanceCount);
            }
            return HotBurstService.lastDetectResult;
        }
        try {
            const result = await HotBurstService.detectHotBurst();

            // 如果检测结果为空（无 outbreaks），尝试从指定小时窗口内的 DB 历史表恢复
            if (!result.outbreaks || result.outbreaks.length === 0) {
                console.log('[HotBurst] detectHotBurst 返回空结果，尝试从 DB 历史表恢复...');
                const dbFallback = await HotBurstService.fallbackFromDB(safeHours, minResonanceCount);
                if (dbFallback) {
                    return dbFallback;
                }
            }

            HotBurstService.lastDetectResult = result;
            HotBurstService.lastDetectTime = Date.now();
            if (minResonanceCount > 0) {
                const filteredResult = {
                    ...result,
                    outbreaks: result.outbreaks.filter(
                        s => s.resonanceCount >= minResonanceCount
                    ),
                };
                filteredResult.resonance_count = filteredResult.outbreaks.length;
                return filteredResult.outbreaks.length
                    ? filteredResult
                    : await HotBurstService.fallbackFromDB(safeHours, minResonanceCount);
            }
            return result;
        } catch (err) {
            console.error('[HotBurst] getRecentBursts 检测失败，尝试旧缓存:', (err as Error).message);
            if (HotBurstService.lastDetectResult) {
                const previous = HotBurstService.lastDetectResult;
                const outbreaks = previous.outbreaks.filter(s => s.resonanceCount >= minResonanceCount);
                return { ...previous, outbreaks, resonance_count: outbreaks.length };
            }
            // 内存缓存为空（如服务器刚重启），从 DB 历史表兜底
            console.log('[HotBurst] 内存缓存为空，从 DB 历史表恢复...');
            return await HotBurstService.fallbackFromDB(safeHours, minResonanceCount);
        }
    }

    /** 从 DB 历史表恢复数据（兜底） */
    private static async fallbackFromDB(hours: number, minResonanceCount: number): Promise<HotBurstResult | null> {
        try {
            const dbResult = await pool.query(
                `SELECT (detected_at AT TIME ZONE 'UTC') AS detected_at, symbol, stock_name, resonance_score, resonance_level,
                        price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count, source_details
                 FROM institution_research_history
                 WHERE resonance_count >= $2
                   AND detected_at >= (NOW() AT TIME ZONE 'UTC') - ($1::text || ' hours')::interval
                 ORDER BY institution_research_history.detected_at DESC, resonance_score DESC, id DESC
                 LIMIT 50`,
                [hours, Math.min(Math.max(minResonanceCount, 2), 4)]
            );
            if (dbResult.rows.length > 0) {
                const records = dbResult.rows;
                const latestTime = records[0].detected_at;
                const outbreaks: StockResonanceSignal[] = records.map((r: any) => ({
                    symbol: r.symbol,
                    stockName: r.stock_name,
                    newsCount: r.news_count,
                    newsSurgeRatio: 0,
                    triggerTags: r.keywords ? r.keywords.split('、') : [],
                    feishuMessageCount: r.feishu_count,
                    thsVerified: r.ths_verified,
                    thsSectorName: r.sector_info || '',
                    thsSectorRank: 0,
                    resonanceScore: r.resonance_score,
                    resonanceLevel: r.resonance_level,
                    price: r.price && Number(r.price) > 0 ? Number(r.price) : null,
                    changePct: r.change_pct !== null && r.change_pct !== undefined ? Number(r.change_pct) : null,
                    sectorInfo: r.sector_info || '',
                    conceptResonance: null,
                    articles: [],
                    detectedAt: r.detected_at,
                    clsVerified: r.source_details?.cls?.status === 'passed',
                    glhVerified: r.source_details?.glh?.status === 'passed',
                    reportVerified: r.source_details?.qq?.status === 'passed',
                    resonanceCount: r.resonance_count,
                    source_details: r.source_details ?? unknownSources(),
                    conceptDetail: null,
                    reportDetail: null,
                }));
                const fallbackResult: HotBurstResult = {
                    update_time: latestTime,
                    total_stocks_checked: outbreaks.length,
                    resonance_count: outbreaks.length,
                    ths_hot_sectors: [],
                    outbreaks,
                    hot_concepts: [],
                };
                // 刷新行情数据
                await HotBurstService.refreshOutbreaksQuotes(outbreaks);
                // 历史兜底受hours/minResonanceCount约束，不能冒充全局当前检测快照。
                // 否则后续不同窗口/门槛请求会复用本次历史子集。
                console.log(`[HotBurst] 从 DB 恢复 ${outbreaks.length} 条二源及以上共振记录`);
                if (minResonanceCount > 0) {
                    const outbreaks = fallbackResult.outbreaks.filter(s => s.resonanceCount >= minResonanceCount);
                    return { ...fallbackResult, outbreaks, resonance_count: outbreaks.length };
                }
                return fallbackResult;
            }
        } catch (dbErr) {
            console.error('[HotBurst] DB 兜底也失败:', (dbErr as Error).message);
        }
        return null;
    }

    /**
     * 从 DB 获取最新的机构调研推荐热门股记录（轻量查询，不触发检测）
     * 首页面板专用：直接返回 DB 中最新的 N 条二源及以上共振记录
     */
    static async getLatestFromDB(limit: number = 5): Promise<HotBurstResult | null> {
        try {
            const result = await pool.query(
                `SELECT (detected_at AT TIME ZONE 'UTC') AS detected_at, symbol, stock_name, resonance_score, resonance_level,
                        price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count, source_details
                 FROM institution_research_history
                 WHERE resonance_count >= 2
                 ORDER BY institution_research_history.detected_at DESC, resonance_score DESC, id DESC
                 LIMIT $1`,
                [limit]
            );
            if (result.rows.length === 0) {
                return null;
            }
            const records = result.rows.map(r => ({ ...r, source_details: r.source_details ?? unknownSources() }));
            const latestTime = records[0].detected_at;
            const outbreaks: StockResonanceSignal[] = records.map((r: any) => ({
                symbol: r.symbol,
                stockName: r.stock_name,
                newsCount: r.news_count,
                newsSurgeRatio: 0,
                triggerTags: r.keywords ? r.keywords.split(/[、,]/) : [],
                feishuMessageCount: r.feishu_count,
                thsVerified: r.ths_verified,
                thsSectorName: r.sector_info || '',
                thsSectorRank: 0,
                resonanceScore: r.resonance_score,
                resonanceLevel: r.resonance_level,
                price: r.price && Number(r.price) > 0 ? Number(r.price) : null,
                changePct: r.change_pct !== null && r.change_pct !== undefined ? Number(r.change_pct) : null,
                sectorInfo: r.sector_info || '',
                conceptResonance: null,
                articles: [],
                detectedAt: r.detected_at,
                clsVerified: r.source_details?.cls?.status === 'passed',
                glhVerified: r.source_details?.glh?.status === 'passed',
                reportVerified: r.source_details?.qq?.status === 'passed',
                resonanceCount: r.resonance_count,
                    source_details: r.source_details ?? unknownSources(),
                conceptDetail: null,
                reportDetail: null,
            }));

            // 用缓存行情实时刷新价格和涨跌幅
            try {
                const symbols = outbreaks.map(s => s.symbol);
                const quotes = await TencentQuoteService.getCachedBatchQuotes(symbols, 'core');
                for (let i = 0; i < outbreaks.length; i++) {
                    const q = quotes[i];
                    if (q && !('错误' in q)) {
                        const price = q['最新价'];
                        const changePct = q['涨跌幅'];
                        if (price && price > 0) outbreaks[i].price = price;
                        if (changePct !== undefined && changePct !== null) outbreaks[i].changePct = changePct;
                    }
                }
            } catch (e) {
                console.warn('[HotBurst] getLatestFromDB 刷新行情失败:', (e as Error).message);
            }

            return {
                update_time: latestTime,
                total_stocks_checked: outbreaks.length,
                resonance_count: outbreaks.length,
                ths_hot_sectors: [],
                outbreaks,
                hot_concepts: [],
            };
        } catch (err) {
            console.error('[HotBurst] getLatestFromDB 失败:', (err as Error).message);
            return null;
        }
    }

    /**
     * 获取机构调研推荐热门股检测结果（供 /internal/institution-research 接口调用）
     * 包装 getRecentBursts()，优先返回缓存，缓存过期则触发一次检测
     */
    static async getHotBurst(query: {
        hours?: number;
        minResonanceCount?: number;
        limit?: number;
    }): Promise<HotBurstResult | null> {
        const result = await this.getRecentBursts(query.hours ?? 6, query.minResonanceCount ?? 0);
        if (!result) return null;
        const safeLimit = Math.min(Math.max(query.limit ?? 20, 1), 100);
        const outbreaks = result.outbreaks.slice(0, safeLimit);
        return { ...result, outbreaks, resonance_count: outbreaks.length };
    }

    /**
     * 获取机构调研推荐热门股历史记录（供 /internal/institution-research/history 接口调用）
     * 包装 getHistory()，从数据库查询历史共振记录
     */
    static async getHotBurstHistory(query: {
        limit?: number;
        offset?: number;
        minResonanceOnly?: boolean;
        days?: number;
        minResonance?: number;
        tradingDays?: number;
        all?: boolean;
    }): Promise<{ total: number; records: unknown[] }> {
        return this.getHistory(
            query.limit ?? 50,
            query.offset ?? 0,
            query.minResonanceOnly ?? true,
            query.days ?? 30,
            query.minResonance,
            query.tradingDays,
            query.all ?? false,
        );
    }
}
