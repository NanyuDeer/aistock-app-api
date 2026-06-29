/**
 * 机构调研推荐热门股整合服务
 *
 * 整合四个独立信号源：
 * 1. 财联社快讯（clsVerified）：该股票所属概念在财联社被提及
 * 2. 格隆汇快讯（glhVerified）：该股票所属概念在格隆汇被提及
 * 3. 同花顺热点掘金（thsVerified）：股票所属板块在同花顺热榜 Top10
 * 4. 研报验证（reportVerified）：24h 内有研报提及该股票
 *
 * 任意两个及以上信号源即构成共振（resonanceCount >= 2）
 */

import pool from '../db';
import { HotKeywordDetectorService, extractStockCodes, type HotConceptResult } from './HotKeywordDetectorService';
import { getThsHot, type ThsHotRow } from './TushareService';
import { findResearchReportMessagesForStock } from './FeishuResearchReportService';
import { TencentQuoteService } from './TencentQuoteService';
import { TradingCalendarService } from './TradingCalendarService';

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
    received_at: string;
}

/** 个股共振信号（个股代码为主维度，关键词为辅助解释） */
interface StockResonanceSignal {
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
    clsVerified: boolean;           // 财联社信号：该股票所属概念在财联社被提及
    glhVerified: boolean;           // 格隆汇信号：该股票所属概念在格隆汇被提及
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

// ==================== 同花顺热点掘金验证 ====================

async function fetchThsHotSectors(): Promise<{ name: string; rank: number; change_pct: number }[]> {
    try {
        const today = new Date();
        for (let offset = 0; offset < 3; offset++) {
            const d = new Date(today);
            d.setDate(d.getDate() - offset);
            const dateStr = formatDate(d);

            const hotData: ThsHotRow[] = await getThsHot(dateStr, '概念板块');
            if (hotData.length > 0) {
                return hotData.slice(0, 10).map((row, idx) => ({
                    name: row.ts_name || '',
                    rank: idx + 1,
                    change_pct: Number(row.pct_change) || 0,
                }));
            }
        }
    } catch (err) {
        console.warn('[HotBurst] 同花顺热榜获取失败:', (err as Error).message);
    }
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
    return Promise.race([
        promise,
        new Promise<T>((resolve) =>
            setTimeout(() => {
                console.warn(`[HotBurst] ${label} 超时 (${ms}ms)，使用 fallback`);
                resolve(fallback);
            }, ms)
        ),
    ]);
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

/** 查询个股所属板块（通过 stock_concept_mapping 表） */
async function getStockSector(symbol: string): Promise<string[]> {
    try {
        const result = await pool.query(
            `SELECT DISTINCT sector_name FROM stock_concept_mapping
             WHERE symbol = $1 LIMIT 20`,
            [symbol]
        );
        return result.rows.map((r: any) => r.sector_name);
    } catch {
        return [];
    }
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
            `SELECT id, source, chat_id, chat_name, message_id, message_type, text, stock_codes, keywords, received_at
             FROM feishu_messages
             WHERE received_at > NOW() - INTERVAL '${hours} hours'
             ORDER BY received_at DESC
             LIMIT 200`,
        );
        const rows: FeishuMessageRow[] = result.rows.map((row: any) => ({
            ...row,
            stock_codes: row.stock_codes || [],
            keywords: typeof row.keywords === 'string' ? JSON.parse(row.keywords) : row.keywords || [],
        }));
        // 回退：当 stock_codes 为空时从文本提取
        return enrichFeishuStockCodes(rows);
    } catch {
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
     * 1. 个股爆发检测（财联社/格隆汇快讯中提取股票代码）
     * 2. 同花顺热榜验证（股票所属板块是否上榜）
     * 3. 研报验证（24h 内是否有研报提及）
     *
     * 四个信号源任意两个及以上即构成共振
     */
    static async detectHotBurst(): Promise<HotBurstResult> {
        console.log('[HotBurst] 开始三步机构调研推荐热门股检测（个股驱动）...');

        const now = new Date().toISOString();

        // ===== Step 1: 个股爆发检测（代码提取替代关键词匹配） =====
        const hotStocks = await withTimeout(
            HotKeywordDetectorService.detectHotStocks(), 30000, [], 'Step1:个股爆发检测'
        );
        console.log(`[HotBurst] Step1: 检测到 ${hotStocks.length} 只爆发个股`);

        // ===== Step 1.5: 细分概念爆发检测（共振一：交叉验证） =====
        const hotConcepts = await withTimeout(
            HotKeywordDetectorService.detectHotConcepts(), 20000, [], 'Step1.5:概念爆发检测'
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
        const keywordResults = await HotKeywordDetectorService.detectHotKeywords();

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
        const feishuStockMap = new Map<string, { messageCount: number; keywords: Set<string> }>();
        for (const msg of feishuMessages) {
            for (const code of msg.stock_codes) {
                const existing = feishuStockMap.get(code);
                if (existing) {
                    existing.messageCount++;
                    for (const kw of msg.keywords) existing.keywords.add(kw.keyword);
                } else {
                    const kwSet = new Set<string>();
                    for (const kw of msg.keywords) kwSet.add(kw.keyword);
                    feishuStockMap.set(code, { messageCount: 1, keywords: kwSet });
                }
            }
        }

        // ===== Step 2.5: 预加载研报数据（批量，避免逐个查询） =====
        const reportStockSet = new Map<string, { count: number; latestTime: string }>();
        try {
            const reportMessages = await pool.query(
                `SELECT stock_codes, received_at FROM feishu_messages
                 WHERE received_at > NOW() - INTERVAL '24 hours'
                   AND chat_name LIKE '%研报%'
                   AND array_length(stock_codes, 1) IS NOT NULL`
            );
            for (const row of reportMessages.rows) {
                for (const code of row.stock_codes || []) {
                    const existing = reportStockSet.get(code);
                    if (existing) {
                        existing.count++;
                    } else {
                        reportStockSet.set(code, { count: 1, latestTime: row.received_at });
                    }
                }
            }
            console.log(`[HotBurst] Step2.5: 预加载研报数据，覆盖 ${reportStockSet.size} 只股票`);
        } catch (err) {
            console.warn('[HotBurst] Step2.5: 研报预加载失败:', (err as Error).message);
        }

        // ===== Step 3: 同花顺热榜验证 =====
        const thsHotSectors = await withTimeout(
            fetchThsHotSectors(), 15000, [], 'Step3:同花顺热榜'
        );
        console.log(`[HotBurst] Step3: 同花顺热榜 ${thsHotSectors.length} 个板块`);

        const thsSectorNameSet = new Set(thsHotSectors.map(s => s.name));
        const thsSectorRankMap = new Map(thsHotSectors.map(s => [s.name, s.rank]));

        // ===== 整合：三个来源按股票代码对齐 =====
        const outbreaks: StockResonanceSignal[] = [];
        let resonanceCount = 0;

        for (const stock of hotStocks) {
            const feishuData = feishuStockMap.get(stock.symbol);
            const feishuMsgCount = feishuData?.messageCount || 0;

            // 同花顺验证：查该股票所属板块是否在热榜
            let thsVerified = false;
            let thsSectorName = '';
            let thsSectorRank = 0;

            const stockSectors = await getStockSector(stock.symbol);
            // 精确匹配
            for (const sector of stockSectors) {
                if (thsSectorNameSet.has(sector)) {
                    thsVerified = true;
                    thsSectorName = sector;
                    thsSectorRank = thsSectorRankMap.get(sector) || 0;
                    break;
                }
            }

            // 模糊匹配：热榜板块名包含在股票板块中或反之
            if (!thsVerified) {
                outer: for (const sector of stockSectors) {
                    for (const thsName of thsSectorNameSet) {
                        if (sector.includes(thsName) || thsName.includes(sector)) {
                            thsVerified = true;
                            thsSectorName = thsName;
                            thsSectorRank = thsSectorRankMap.get(thsName) || 0;
                            break outer;
                        }
                    }
                }
            }

            // 初步评分（共振数量尚未确定，先用保守值做初筛）
            const { score, level } = calculateResonanceScore(
                stock.currentCount, stock.surgeRatio,
                thsSectorRank, thsVerified,
                false,  // 研报暂未知
                thsVerified ? 2 : 1,  // 有同花顺至少算二重
            );

            // 过滤：仅快讯暴增但无板块验证的低分信号
            if (level === 'low' && !thsVerified) continue;

            resonanceCount++;

            const stockName = stock.stockName || await getStockName(stock.symbol);

            // 构建触发标签：概念名 + 板块名 + 维度关键词
            const triggerTagsSet = new Set<string>();
            const conceptInfo = stockConceptMap.get(stock.symbol);
            if (conceptInfo?.conceptName) triggerTagsSet.add(conceptInfo.conceptName);
            if (thsVerified && thsSectorName) triggerTagsSet.add(thsSectorName);
            const dimKws = stockKeywordsMap.get(stock.symbol) || [];
            for (const kw of dimKws) triggerTagsSet.add(kw);

            outbreaks.push({
                symbol: stock.symbol,
                stockName,
                newsCount: stock.currentCount,
                newsSurgeRatio: stock.surgeRatio,
                triggerTags: Array.from(triggerTagsSet),
                feishuMessageCount: feishuMsgCount,
                thsVerified,
                thsSectorName,
                thsSectorRank,
                resonanceScore: score,
                resonanceLevel: level,
                price: null,
                changePct: null,
                sectorInfo: thsVerified ? thsSectorName : (conceptInfo?.conceptName || ''),
                conceptResonance: stockConceptMap.has(stock.symbol) ? {
                    conceptName: stockConceptMap.get(stock.symbol)!.conceptName,
                    clsCount: stockConceptMap.get(stock.symbol)!.clsCount,
                    glhCount: stockConceptMap.get(stock.symbol)!.glhCount,
                    conceptVerified: stockConceptMap.get(stock.symbol)!.crossVerified,
                } : null,
                articles: stock.articles,
                detectedAt: stock.detectedAt,
                clsVerified: false,
                glhVerified: false,
                reportVerified: false,
                resonanceCount: 0,
                conceptDetail: null,
                reportDetail: null,
            });
        }

        // 按共振评分降序
        outbreaks.sort((a, b) => b.resonanceScore - a.resonanceScore);

        // 补充共振状态
        for (const signal of outbreaks) {
            // 财联社信号：所属概念在财联社被提及
            signal.clsVerified = (signal.conceptResonance?.clsCount ?? 0) > 0;
            // 格隆汇信号：所属概念在格隆汇被提及
            signal.glhVerified = (signal.conceptResonance?.glhCount ?? 0) > 0;

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

            // 计算共振数量（四个信号源）
            signal.resonanceCount = [signal.clsVerified, signal.glhVerified, signal.thsVerified, signal.reportVerified].filter(Boolean).length;

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

        console.log(`[HotBurst] 检测完成: ${outbreaks.length} 个机构调研热门信号`);

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

        const symbols = outbreaks.map(s => s.symbol);
        const quoteResults = await TencentQuoteService.getCachedBatchQuotes(symbols, 'core');
        for (let i = 0; i < outbreaks.length; i++) {
            const signal = outbreaks[i];
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
            total_stocks_checked: hotStocks.length,
            resonance_count: outbreaks.length,
            ths_hot_sectors: thsHotSectors,
            outbreaks,
            hot_concepts: hotConcepts,
        };

        // 更新缓存
        HotBurstService.lastDetectResult = result;
        HotBurstService.lastDetectTime = Date.now();

        // 保存到历史表（不阻塞返回）
        HotBurstService.saveHistory(result).catch(() => {});

        return result;
    }

    /** 将检测结果保存到历史表 */
    static async saveHistory(result: HotBurstResult): Promise<void> {
        // 入库三源共振信号
        const qualifiedSignals = result.outbreaks.filter(s => s.resonanceCount >= 3);
        if (!qualifiedSignals.length) {
            console.log('[HotBurst] 无三源共振信号，跳过历史入库');
            return;
        }
        try {
            const detectedAt = result.update_time;
            const rows = qualifiedSignals.map(s => [
                detectedAt, s.symbol, s.stockName || s.symbol,
                s.resonanceScore, s.resonanceLevel,
                s.price, s.changePct, s.sectorInfo,
                s.triggerTags.join('、'),
                s.newsCount, s.feishuMessageCount, s.thsVerified,
                s.resonanceCount,
            ]);
            const placeholders = rows.map((_, i) =>
                `($${i * 13 + 1}, $${i * 13 + 2}, $${i * 13 + 3}, $${i * 13 + 4}, $${i * 13 + 5}, $${i * 13 + 6}, $${i * 13 + 7}, $${i * 13 + 8}, $${i * 13 + 9}, $${i * 13 + 10}, $${i * 13 + 11}, $${i * 13 + 12}, $${i * 13 + 13})`
            ).join(', ');
            const values = rows.flat();
            await pool.query(
                `INSERT INTO institution_research_history (detected_at, symbol, stock_name, resonance_score, resonance_level, price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count)
                 VALUES ${placeholders}`,
                values
            );
            console.log(`[HotBurst] 保存 ${rows.length} 条三源共振历史记录（总信号 ${result.outbreaks.length} 条）`);
        } catch (err) {
            console.error('[HotBurst] 保存历史记录失败:', (err as Error).message);
        }
    }

    /**
     * 查询历史机构调研推荐热门股记录
     * @param minResonanceOnly 仅返回三源共振及以上（resonance_count >= 3）的记录
     */
    static async getHistory(
        limit: number = 50,
        offset: number = 0,
        minResonanceOnly: boolean = true
    ): Promise<{ total: number; records: any[] }> {
        let total: number;
        let records: any[];

        if (minResonanceOnly) {
            const countResult = await pool.query(
                `SELECT COUNT(*)::int AS total FROM institution_research_history
                 WHERE resonance_count >= 3`
            );
            total = countResult.rows[0]?.total || 0;

            const result = await pool.query(
                `SELECT id, detected_at, symbol, stock_name, resonance_score, resonance_level,
                        price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count
                 FROM institution_research_history
                 WHERE resonance_count >= 3
                 ORDER BY detected_at DESC, resonance_score DESC
                 LIMIT $1 OFFSET $2`,
                [limit, offset]
            );
            records = result.rows;
        } else {
            const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM institution_research_history');
            total = countResult.rows[0]?.total || 0;

            const result = await pool.query(
                `SELECT id, detected_at, symbol, stock_name, resonance_score, resonance_level,
                        price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count
                 FROM institution_research_history
                 ORDER BY detected_at DESC, resonance_score DESC
                 LIMIT $1 OFFSET $2`,
                [limit, offset]
            );
            records = result.rows;
        }

        // 刷新行情数据
        try {
            const symbols = records.map((r: any) => r.symbol);
            const quotes = await TencentQuoteService.getCachedBatchQuotes(symbols, 'core');
            for (let i = 0; i < records.length; i++) {
                const q = quotes[i];
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
    static async getRecentBursts(_hours: number = 6, minResonanceCount: number = 0): Promise<HotBurstResult | null> {
        if (HotBurstService.lastDetectResult && (Date.now() - HotBurstService.lastDetectTime) < HotBurstService.DETECT_CACHE_TTL) {
            // 刷新内存缓存中的行情数据
            await HotBurstService.refreshOutbreaksQuotes(HotBurstService.lastDetectResult.outbreaks);
            if (minResonanceCount > 0) {
                return {
                    ...HotBurstService.lastDetectResult,
                    outbreaks: HotBurstService.lastDetectResult.outbreaks.filter(
                        s => s.resonanceCount >= minResonanceCount
                    ),
                };
            }
            return HotBurstService.lastDetectResult;
        }
        try {
            const result = await HotBurstService.detectHotBurst();

            // 如果检测结果为空（无 outbreaks），尝试从 DB 历史表恢复
            if (!result.outbreaks || result.outbreaks.length === 0) {
                console.log('[HotBurst] detectHotBurst 返回空结果，尝试从 DB 历史表恢复...');
                const dbFallback = await HotBurstService.fallbackFromDB(minResonanceCount);
                if (dbFallback) {
                    return dbFallback;
                }
            }

            HotBurstService.lastDetectResult = result;
            HotBurstService.lastDetectTime = Date.now();
            if (minResonanceCount > 0) {
                return {
                    ...result,
                    outbreaks: result.outbreaks.filter(
                        s => s.resonanceCount >= minResonanceCount
                    ),
                };
            }
            return result;
        } catch (err) {
            console.error('[HotBurst] getRecentBursts 检测失败，尝试旧缓存:', (err as Error).message);
            if (HotBurstService.lastDetectResult) {
                return HotBurstService.lastDetectResult;
            }
            // 内存缓存为空（如服务器刚重启），从 DB 历史表兜底
            console.log('[HotBurst] 内存缓存为空，从 DB 历史表恢复...');
            return await HotBurstService.fallbackFromDB(minResonanceCount);
        }
    }

    /** 从 DB 历史表恢复数据（兜底） */
    private static async fallbackFromDB(minResonanceCount: number): Promise<HotBurstResult | null> {
        try {
            const dbResult = await pool.query(
                `SELECT detected_at, symbol, stock_name, resonance_score, resonance_level,
                        price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count
                 FROM institution_research_history
                 WHERE resonance_count >= 3
                 ORDER BY detected_at DESC, resonance_score DESC
                 LIMIT 50`
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
                    changePct: r.change_pct && Number(r.change_pct) !== 0 ? Number(r.change_pct) : null,
                    sectorInfo: r.sector_info || '',
                    conceptResonance: null,
                    articles: [],
                    detectedAt: r.detected_at,
                    clsVerified: false,
                    glhVerified: false,
                    reportVerified: false,
                    resonanceCount: r.resonance_count,
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
                HotBurstService.lastDetectResult = fallbackResult;
                HotBurstService.lastDetectTime = Date.now();
                console.log(`[HotBurst] 从 DB 恢复 ${outbreaks.length} 条三源共振记录`);
                if (minResonanceCount > 0) {
                    return {
                        ...fallbackResult,
                        outbreaks: fallbackResult.outbreaks.filter(
                            s => s.resonanceCount >= minResonanceCount
                        ),
                    };
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
     * 首页面板专用：直接返回 DB 中最新的 N 条三源共振记录
     */
    static async getLatestFromDB(limit: number = 5): Promise<HotBurstResult | null> {
        try {
            const result = await pool.query(
                `SELECT detected_at, symbol, stock_name, resonance_score, resonance_level,
                        price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count
                 FROM institution_research_history
                 WHERE resonance_count >= 3
                 ORDER BY detected_at DESC, resonance_score DESC
                 LIMIT $1`,
                [limit]
            );
            if (result.rows.length === 0) {
                return null;
            }
            const records = result.rows;
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
                changePct: r.change_pct && Number(r.change_pct) !== 0 ? Number(r.change_pct) : null,
                sectorInfo: r.sector_info || '',
                conceptResonance: null,
                articles: [],
                detectedAt: r.detected_at,
                clsVerified: false,
                glhVerified: false,
                reportVerified: false,
                resonanceCount: r.resonance_count,
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
}