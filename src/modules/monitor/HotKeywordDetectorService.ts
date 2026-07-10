/**
 * 风口关键词爆发检测服务
 *
 * 数据源：
 * 1. 财联社电报 - 实时快讯
 * 2. 格隆汇快讯 - 港股/A股资讯
 *
 * 核心逻辑：
 * - 定时爬取快讯文本
 * - 使用9维度关键词体系匹配
 * - 检测关键词频次异常（爆发信号）
 * - 将爆发关键词推送至后端存储
 */

import * as cheerio from 'cheerio';
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService';
import { formatToChinaTime } from '../../shared/utils/datetime';
import { cailianpressThrottler } from '../../shared/utils/throttlers';
import { sessionFetch } from '../../shared/utils/httpAgent';
import { getThsIndex, tushareRequest } from '../quote/TushareService';
import pool from '../../core/db';

// ==================== 9维度关键词体系 ====================

export const KEYWORD_DIMENSIONS: Record<string, {
    label: string;
    color: string;
    keywords: string[];
}> = {
    supply_demand: {
        label: '供需关系',
        color: '#dc2626',
        keywords: ['缺货', '断供', '无货', '库存告急', '库存见底', '供不应求', '需求旺盛', '订单积压', '排产紧张', '产能满载', '产能利用率', '扩产', '新增产能', '产能瓶颈', '去库存', '库存下降', '低库存', '补库存'],
    },
    order_level: {
        label: '订单级别',
        color: '#ea580c',
        keywords: ['百亿订单', '十亿订单', '重大合同', '战略订单', '十年订单', '长期框架', '长单锁定', '订单爆发', '订单翻倍', '订单激增', '中标', '签约', '大客户', '头部客户', '导入客户', '验证通过'],
    },
    price_change: {
        label: '价格变动',
        color: '#ca8a04',
        keywords: ['涨价', '提价', '调价', '价格上调', '价格高位', '持续上涨', '价格创新高', '降价', '价格战', '价格下行'],
    },
    tech_breakthrough: {
        label: '技术突破',
        color: '#7c3aed',
        keywords: ['量产', '规模化', '批产', '小批量产', '独家', '独家供应', '唯一', '独家合作', '首发', '率先', '首发产品', '首发认证', '通过验证', '客户认证', '验厂通过', '导入阶段'],
    },
    policy_catalyst: {
        label: '政策催化',
        color: '#0891b2',
        keywords: ['政策利好', '补贴', '纳入目录', '国家战略', '获批'],
    },
    earnings_verify: {
        label: '业绩验证',
        color: '#059669',
        keywords: ['业绩超预期', '净利翻倍', '扭亏', '预告增长'],
    },
    industry_cycle: {
        label: '行业景气',
        color: '#4f46e5',
        keywords: ['景气度上行', '行业拐点', '周期反转'],
    },
    capital_action: {
        label: '股权/资本',
        color: '#9333ea',
        keywords: ['回购', '增持', '定增', '员工持股', '机构调研'],
    },
    risk_signal: {
        label: '风险信号',
        color: '#64748b',
        keywords: ['减持', '商誉减值', '诉讼', '被调查', '退市风险'],
    },
};

// ==================== 细分概念词库 ====================

/**
 * 细分概念词库：从 Tushare ths_index 拉取同花顺概念板块名称
 * 按名称长度降序排列，优先匹配更细粒度的概念（如"六氟化硫"优先于"氟化工"）
 */
interface ConceptEntry {
    tsCode: string;   // 概念代码，如 "885853.TI"
    name: string;     // 概念名称，如 "六氟化硫"
}

let conceptVocabulary: ConceptEntry[] = [];
let conceptVocabularyLoaded = false;
let conceptVocabularyLoading = false;

/** 获取概念词库（懒加载，启动后首次调用时从 Tushare 拉取） */
export async function getConceptVocabulary(): Promise<ConceptEntry[]> {
    if (conceptVocabularyLoaded) return conceptVocabulary;
    if (conceptVocabularyLoading) {
        // 等待加载完成
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (conceptVocabularyLoaded) return conceptVocabulary;
        }
        return conceptVocabulary;
    }

    conceptVocabularyLoading = true;
    try {
        console.log('[HotKeywordDetector] 开始加载概念词库...');
        const rows = await getThsIndex('N', 'A');
        // 过滤有效名称，按长度降序排列
        conceptVocabulary = rows
            .filter(r => r.name && r.name.length >= 2)
            .map(r => ({ tsCode: r.ts_code, name: r.name }))
            .sort((a, b) => b.name.length - a.name.length);

        conceptVocabularyLoaded = true;
        console.log(`[HotKeywordDetector] 概念词库加载完成: ${conceptVocabulary.length} 个概念`);
    } catch (err) {
        console.warn('[HotKeywordDetector] 概念词库加载失败，使用空词库:', (err as Error).message);
        conceptVocabularyLoaded = true; // 标记已加载，避免反复重试
    } finally {
        conceptVocabularyLoading = false;
    }
    return conceptVocabulary;
}

/** 强制刷新概念词库（供定时任务调用） */
export async function refreshConceptVocabulary(): Promise<void> {
    conceptVocabularyLoaded = false;
    conceptVocabularyLoading = false;
    await getConceptVocabulary();
}

/** 关键词→维度映射 */
const keywordToDimension: Map<string, string> = new Map();
for (const [dimKey, dim] of Object.entries(KEYWORD_DIMENSIONS)) {
    for (const kw of dim.keywords) {
        keywordToDimension.set(kw, dimKey);
    }
}

/** 获取关键词所属维度 */
export function getKeywordDimension(keyword: string): { key: string; label: string; color: string } | null {
    const dimKey = keywordToDimension.get(keyword);
    if (!dimKey) return null;
    const dim = KEYWORD_DIMENSIONS[dimKey];
    return { key: dimKey, label: dim.label, color: dim.color };
}

// ==================== 个股代码提取 ====================

/** 匹配 A 股 6 位代码（0/3/6 开头） */
const STOCK_CODE_RE = /\b([036]\d{5})\b/g;

/** 匹配 "中际旭创(300308)" "宁德时代：300750" "茅台-600519" 等模式 */
const STOCK_NAME_CODE_RE = /([\u4e00-\u9fff]{2,8})\s*[（(:：\-—]\s*([036]\d{5})\s*[）):]?/g;

// ==================== A股名称→代码映射 ====================

let stockNameMap = new Map<string, { symbol: string; name: string }>();
let stockNameMapLoaded = false;
let stockNameMapLoading: Promise<void> | null = null;

/** 按名称长度降序排列的名称数组，用于匹配 */
let sortedNames: { symbol: string; name: string }[] = [];

/** 加载 A 股名称→代码映射（懒加载，首次调用时从 Tushare 拉取） */
export async function loadStockNameMap(): Promise<void> {
    if (stockNameMapLoaded) return;
    if (stockNameMapLoading) {
        await stockNameMapLoading;
        return;
    }
    stockNameMapLoading = (async () => {
        try {
            const rows = await tushareRequest('stock_basic', { exchange: '', list_status: 'L' }, 'ts_code,symbol,name');
            for (const row of rows) {
                const name = (row.name || '').trim();
                const symbol = (row.symbol || '').trim();
                if (name && symbol && name.length >= 2) {
                    stockNameMap.set(name.toLowerCase(), { symbol, name });
                }
            }
            // 按名称长度降序排列，优先匹配更长的名称（如"中际旭创"优先于"中际"）
            sortedNames = Array.from(stockNameMap.values()).sort((a, b) => b.name.length - a.name.length);
            console.log(`[HotKeywordDetector] A股名称映射加载完成: ${stockNameMap.size} 只`);
            stockNameMapLoaded = true;
        } catch (err) {
            console.warn('[HotKeywordDetector] A股名称映射加载失败:', (err as Error).message);
            stockNameMapLoaded = true; // 失败也标记为已加载，避免反复重试
        } finally {
            stockNameMapLoading = null;
        }
    })();
    await stockNameMapLoading;
}

/**
 * 从文本中提取所有 A 股代码及其关联名称
 * 返回 Map<symbol, stockName | ''>
 *
 * 注意：调用前需先 await loadStockNameMap() 预加载名称映射，否则仅匹配代码
 */
export function extractStockCodes(text: string): Map<string, string> {
    const stocks = new Map<string, string>();

    // 1. 优先匹配"名称(代码)"模式，可获取名称
    for (const m of text.matchAll(STOCK_NAME_CODE_RE)) {
        const name = m[1].trim();
        const code = m[2];
        if (!stocks.has(code) || !stocks.get(code)) {
            stocks.set(code, name);
        }
    }

    // 2. 补充匹配裸代码，补充可能遗漏的代码
    for (const m of text.matchAll(STOCK_CODE_RE)) {
        const code = m[0];
        if (!stocks.has(code)) {
            stocks.set(code, '');
        }
    }

    // 3. 通过 A 股名称匹配（解决快讯中只有公司名称、无代码的情况）
    // 遍历名称列表，用 includes 检查文本中是否包含公司名称
    for (const entry of sortedNames) {
        if (text.includes(entry.name)) {
            if (!stocks.has(entry.symbol) || !stocks.get(entry.symbol)) {
                stocks.set(entry.symbol, entry.name);
            }
        }
    }

    return stocks;
}

// ==================== 财联社电报爬取 ====================

const CLS_TELEGRAPH_URL = 'https://www.cls.cn/api/csw?app=CailianpressWeb&os=web&sv=8.4.6&sign=9f8797a1f4de66c2370f7a03990d2737';
const CLS_HEADERS: Record<string, string> = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    'Origin': 'https://www.cls.cn',
    'Referer': 'https://www.cls.cn/telegraph',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

interface TelegraphItem {
    id: string;
    title: string;
    content: string;
    time: string;
    timestamp: number;
}

async function fetchClsTelegraph(lastTime: number = 0, limit: number = 100, sinceHours: number = 0): Promise<TelegraphItem[]> {
    const payload = {
        lastTime,
        keyword: '',
        category: '',
        os: 'web',
        sv: '8.4.6',
        app: 'CailianpressWeb',
    };

    await cailianpressThrottler.throttle();

    const response = await sessionFetch(CLS_TELEGRAPH_URL, {
        method: 'POST',
        headers: CLS_HEADERS,
        body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error(`财联社电报请求失败: ${response.status}`);

    let rawData: any = null;
    try { rawData = await response.json(); } catch { return []; }
    if (typeof rawData?.errno === 'number' && rawData.errno !== 0) return [];

    // 时间过滤下限（sinceHours=0 表示不过滤）
    const minTimestamp = sinceHours > 0 ? Math.floor(Date.now() / 1000) - sinceHours * 3600 : 0;

    const entries = rawData?.data?.list || rawData?.list || [];
    const items: TelegraphItem[] = [];

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const ctime = Number(entry.ctime) || 0;
        if (ctime <= lastTime) continue;
        // 时间窗口过滤：丢弃超过 sinceHours 的旧快讯
        if (minTimestamp > 0 && ctime < minTimestamp) continue;

        const $ = cheerio.load(entry.content || '');
        const title = (entry.title || '').trim() || ($.text() || '').trim().slice(0, 100);
        const content = ($.text() || '').trim();

        items.push({
            id: String(entry.id || ''),
            title: title.replace(/^【[^】]*】/, '').trim(),
            content: content.replace(/^【[^】]*】/, '').trim(),
            time: formatToChinaTime(ctime < 1e12 ? ctime * 1000 : ctime),
            timestamp: ctime,
        });

        if (items.length >= limit) break;
    }

    return items;
}

// ==================== 格隆汇快讯爬取 ====================

const GELONGHUI_URL = 'https://www.gelonghui.com/live/?channelId=AStock';
const GELONGHUI_HEADERS: Record<string, string> = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': 'https://www.gelonghui.com/live',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

/**
 * 解析格隆汇网页中的 window.__NUXT__ 数据，提取快讯列表
 *
 * 格隆汇使用 Nuxt.js SSR，页面内嵌 window.__NUXT__=(function(a,b,c){...})("arg1","arg2",...)
 * 需要解析 IIFE 的实参列表，建立变量名→值的映射，再匹配快讯条目
 */
export function parseGelonghuiNuxtData(html: string): any[] {
    const marker = 'window.__NUXT__=';
    const idx = html.indexOf(marker);
    if (idx < 0) return [];

    const dataStart = idx + marker.length;
    const scriptEnd = html.indexOf('</script>', dataStart);
    const nuxtData = scriptEnd > 0 ? html.substring(dataStart, scriptEnd) : html.substring(dataStart);

    // 解析 IIFE 实参：window.__NUXT__=(function(a,b,c){...})("arg1","arg2",...)
    // 注意：格隆汇的实参列表分隔符是 }(" 而非 })("，需要用 lastIndexOf('}(') 定位
    const lastParen = nuxtData.lastIndexOf('}(');
    const argValues: string[] = [];
    if (lastParen > 0) {
        let argStr = nuxtData.substring(lastParen + 2).trim();
        // 去除结尾的 ); 或 )
        argStr = argStr.replace(/\)\s*;?\s*$/, '');
        // 匹配字符串、数字、布尔、null、undefined 实参
        const argRegex = /("(?:[^"\\]|\\.)*"|\d+|true|false|null|undefined)/g;
        let am: RegExpExecArray | null;
        while ((am = argRegex.exec(argStr)) !== null) {
            let val = am[1];
            if (val.startsWith('"')) {
                // 字符串字面量，去除引号并反转义
                val = val.slice(1, -1).replace(/\\u002F/g, '/').replace(/\\n/g, '\n').replace(/\\"/g, '"');
            }
            argValues.push(val);
        }
    }

    // 建立变量名→实参值的映射：a→argValues[0], b→argValues[1], ...
    const varMap: Record<string, string> = {};
    const varNames = 'abcdefghijklmnopqrstuvwxyz';
    for (let i = 0; i < argValues.length && i < varNames.length; i++) {
        varMap[varNames[i]] = argValues[i];
    }

    // 匹配快讯条目：{id:123,title:d,content:"...",createTimestamp:i,...}
    // title 和 createTimestamp 可能是变量引用（如 d、i），需要从 varMap 解析
    const entryRegex = /\{id:(\d+),title:([^,]+?),createTimestamp:([a-z0-9]+)[\s\S]*?content:"((?:[^"\\]|\\.)*)"/g;
    const entries: any[] = [];
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(nuxtData)) !== null) {
        const id = match[1];
        const titleRaw = match[2];
        const tsRaw = match[3];
        let content = match[4];

        // 反转义 content
        content = content.replace(/\\u002F/g, '/').replace(/\\n/g, '\n').replace(/\\"/g, '"');

        // 解析 title：可能是变量引用（如 d）或字符串字面量
        let title = '';
        if (/^[a-z]$/.test(titleRaw)) {
            title = varMap[titleRaw] || '';
        } else if (titleRaw.startsWith('"')) {
            title = titleRaw.replace(/^"|"$/g, '').replace(/\\u002F/g, '/').replace(/\\"/g, '"');
        } else {
            title = titleRaw;
        }

        // 解析 createTimestamp：可能是变量引用或数字字面量
        let ts = 0;
        if (/^[a-z]$/.test(tsRaw)) {
            ts = Number(varMap[tsRaw]) || 0;
        } else {
            ts = Number(tsRaw) || 0;
        }

        entries.push({ id, title, content, createTimestamp: ts });
    }

    return entries;
}

async function fetchGelonghuiNews(limit: number = 50, sinceHours: number = 0): Promise<TelegraphItem[]> {
    try {
        const response = await sessionFetch(GELONGHUI_URL, {
            method: 'GET',
            headers: GELONGHUI_HEADERS,
        });

        if (!response.ok) {
            console.warn(`[HotKeywordDetector] 格隆汇网页请求失败: HTTP ${response.status}`);
            return [];
        }

        const html = await response.text();
        const entries = parseGelonghuiNuxtData(html);

        const items: TelegraphItem[] = [];
        // 时间过滤下限（sinceHours=0 表示不过滤）
        const minTimestamp = sinceHours > 0 ? Date.now() - sinceHours * 3600 * 1000 : 0;
        for (const entry of entries) {
            const text = (entry.title || entry.content || '').trim();
            if (!text) continue;

            const ts = entry.createTimestamp || 0;
            // 时间窗口过滤（ts 单位可能是秒或毫秒）
            const tsMs = ts < 1e12 ? ts * 1000 : ts;
            if (minTimestamp > 0 && tsMs < minTimestamp) continue;

            items.push({
                id: String(entry.id || ''),
                title: text.slice(0, 100),
                content: entry.content || text,
                time: ts ? formatToChinaTime(ts < 1e12 ? ts * 1000 : ts) : '',
                timestamp: ts,
            });
            if (items.length >= limit) break;
        }

        return items;
    } catch (err) {
        console.warn('[HotKeywordDetector] 格隆汇快讯获取失败:', (err as Error).message);
        return [];
    }
}

// ==================== 关键词匹配与爆发检测 ====================

interface KeywordMatch {
    keyword: string;
    dimension: string;
    dimensionLabel: string;
    count: number;
    articles: { id: string; title: string; source: string }[];
}

interface HotKeywordResult {
    keyword: string;
    dimension: string;
    dimensionLabel: string;
    dimensionColor: string;
    currentCount: number;
    previousCount: number;
    surgeRatio: number;
    articles: { id: string; title: string; source: string; time: string }[];
    detectedAt: string;
}

interface HotStockResult {
    symbol: string;
    stockName: string;
    currentCount: number;
    previousCount: number;
    surgeRatio: number;
    articles: { id: string; title: string; source: string; time: string }[];
    detectedAt: string;
}

/** 细分概念爆发检测结果 */
export interface HotConceptResult {
    conceptName: string;       // 概念名称，如 "六氟化硫"
    conceptTsCode: string;     // 概念代码，如 "885853.TI"
    clsCount: number;          // 财联社提及次数
    glhCount: number;          // 格隆汇提及次数
    totalCount: number;        // 合计提及次数
    previousCount: number;     // 历史频次
    surgeRatio: number;        // 爆发比率
    crossVerified: boolean;    // 共振一是否通过（合计≥2次）
    crossSource: boolean;      // 是否双源同时出现（加分项）
    stockCodes: {              // 该概念关联的个股
        symbol: string;
        name: string;
        source: 'cls' | 'glh' | 'both';
    }[];
    articles: { id: string; title: string; source: string; time: string }[];
    detectedAt: string;
}

/** 从文本中匹配关键词 */
function matchKeywords(text: string): Map<string, { dimension: string; dimensionLabel: string }> {
    const matched = new Map<string, { dimension: string; dimensionLabel: string }>();
    for (const [kw, dimKey] of keywordToDimension.entries()) {
        if (text.includes(kw)) {
            const dim = KEYWORD_DIMENSIONS[dimKey];
            matched.set(kw, { dimension: dimKey, dimensionLabel: dim.label });
        }
    }
    return matched;
}

/** 分析一批快讯，返回关键词匹配统计 */
function analyzeArticles(articles: TelegraphItem[], source: string): Map<string, KeywordMatch> {
    const keywordMap = new Map<string, KeywordMatch>();

    for (const article of articles) {
        const text = `${article.title} ${article.content}`;
        const matched = matchKeywords(text);

        for (const [kw, dimInfo] of matched.entries()) {
            const existing = keywordMap.get(kw);
            if (existing) {
                existing.count++;
                existing.articles.push({ id: article.id, title: article.title, source });
            } else {
                keywordMap.set(kw, {
                    keyword: kw,
                    dimension: dimInfo.dimension,
                    dimensionLabel: dimInfo.dimensionLabel,
                    count: 1,
                    articles: [{ id: article.id, title: article.title, source }],
                });
            }
        }
    }

    return keywordMap;
}

// ==================== DB 持久化 ====================

async function ensureSchema(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS hot_keyword_snapshots (
            id SERIAL PRIMARY KEY,
            snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            keyword TEXT NOT NULL,
            dimension TEXT NOT NULL,
            dimension_label TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            article_count INT NOT NULL DEFAULT 0,
            article_ids TEXT[] DEFAULT '{}',
            article_titles TEXT[] DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_hks_keyword ON hot_keyword_snapshots(keyword);
        CREATE INDEX IF NOT EXISTS idx_hks_snapshot_time ON hot_keyword_snapshots(snapshot_time);
        CREATE INDEX IF NOT EXISTS idx_hks_dimension ON hot_keyword_snapshots(dimension);
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS stock_mention_snapshots (
            id SERIAL PRIMARY KEY,
            snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            symbol TEXT NOT NULL,
            stock_name TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            mention_count INT NOT NULL DEFAULT 0,
            article_ids TEXT[] DEFAULT '{}',
            article_titles TEXT[] DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_sms_symbol ON stock_mention_snapshots(symbol);
        CREATE INDEX IF NOT EXISTS idx_sms_snapshot_time ON stock_mention_snapshots(snapshot_time);
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS concept_mention_snapshots (
            id SERIAL PRIMARY KEY,
            snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            concept_name TEXT NOT NULL,
            concept_ts_code TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            mention_count INT NOT NULL DEFAULT 0,
            article_ids TEXT[] DEFAULT '{}',
            article_titles TEXT[] DEFAULT '{}',
            stock_codes TEXT[] DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_cms_concept_name ON concept_mention_snapshots(concept_name);
        CREATE INDEX IF NOT EXISTS idx_cms_snapshot_time ON concept_mention_snapshots(snapshot_time);
        CREATE INDEX IF NOT EXISTS idx_cms_source ON concept_mention_snapshots(source);
    `);
}

/** 保存关键词快照 */
async function saveSnapshot(keywordMatches: Map<string, KeywordMatch>, source: string): Promise<void> {
    await ensureSchema();

    const now = new Date().toISOString();
    for (const [, match] of keywordMatches.entries()) {
        await pool.query(
            `INSERT INTO hot_keyword_snapshots (snapshot_time, keyword, dimension, dimension_label, source, article_count, article_ids, article_titles)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                now,
                match.keyword,
                match.dimension,
                match.dimensionLabel,
                source,
                match.count,
                match.articles.map(a => a.id),
                match.articles.map(a => a.title),
            ],
        );
    }
}

/** 获取关键词历史频次（滚动窗口，默认最近7天，排除本次刚写入的快照） */
async function getKeywordHistory(keyword: string, hours: number = 168): Promise<{ snapshot_time: string; article_count: number }[]> {
    // 排除最近10分钟内的快照（本次运行刚写入的），只统计历史基准
    const result = await pool.query(
        `SELECT snapshot_time, article_count
         FROM hot_keyword_snapshots
         WHERE keyword = $1
           AND snapshot_time > NOW() - INTERVAL '${hours} hours'
           AND snapshot_time < NOW() - INTERVAL '10 minutes'
         ORDER BY snapshot_time ASC`,
        [keyword],
    );
    return result.rows;
}

/** 保存个股提及快照 */
async function saveStockMentionSnapshot(
    stockMentions: Map<string, { name: string; count: number; articleIds: string[]; articleTitles: string[] }>,
    source: string
): Promise<void> {
    await ensureSchema();

    const now = new Date().toISOString();
    for (const [symbol, data] of stockMentions.entries()) {
        await pool.query(
            `INSERT INTO stock_mention_snapshots (snapshot_time, symbol, stock_name, source, mention_count, article_ids, article_titles)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [now, symbol, data.name, source, data.count, data.articleIds, data.articleTitles]
        );
    }
}

/** 查询个股历史提及频次（滚动窗口，默认最近7天，排除本次刚写入的快照） */
async function getStockMentionHistory(symbol: string, hours: number = 168): Promise<{
    snapshot_time: string;
    mention_count: number;
}[]> {
    // 排除最近10分钟内的快照（本次运行刚写入的），只统计历史基准
    const result = await pool.query(
        `SELECT snapshot_time, mention_count
         FROM stock_mention_snapshots
         WHERE symbol = $1
           AND snapshot_time > NOW() - INTERVAL '${hours} hours'
           AND snapshot_time < NOW() - INTERVAL '10 minutes'
         ORDER BY snapshot_time ASC`,
        [symbol]
    );
    return result.rows;
}

/** 保存概念提及快照 */
async function saveConceptMentionSnapshot(
    conceptMentions: Map<string, ConceptMentionMatch>,
    source: string,
): Promise<void> {
    await ensureSchema();

    const now = new Date().toISOString();
    for (const [, match] of conceptMentions.entries()) {
        await pool.query(
            `INSERT INTO concept_mention_snapshots (snapshot_time, concept_name, concept_ts_code, source, mention_count, article_ids, article_titles, stock_codes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                now,
                match.conceptName,
                match.conceptTsCode,
                source,
                match.count,
                match.articles.map(a => a.id),
                match.articles.map(a => a.title),
                Array.from(match.stockCodes.keys()),
            ],
        );
    }
}

/** 查询概念历史提及频次（滚动窗口，默认最近7天，排除本次刚写入的快照） */
async function getConceptMentionHistory(
    conceptName: string,
    hours: number = 168,
): Promise<{ snapshot_time: string; mention_count: number; source: string }[]> {
    // 排除最近10分钟内的快照（本次运行刚写入的），只统计历史基准
    const result = await pool.query(
        `SELECT snapshot_time, mention_count, source
         FROM concept_mention_snapshots
         WHERE concept_name = $1
           AND snapshot_time > NOW() - INTERVAL '${hours} hours'
           AND snapshot_time < NOW() - INTERVAL '10 minutes'
         ORDER BY snapshot_time ASC`,
        [conceptName],
    );
    return result.rows;
}

interface StockMentionMatch {
    symbol: string;
    stockName: string;
    count: number;
    articleIds: string[];
    articleTitles: string[];
}

/**
 * 从快讯列表中提取个股代码，按股票聚合统计提及次数
 */
function analyzeStockMentions(articles: TelegraphItem[], source: string): Map<string, StockMentionMatch> {
    const stockMap = new Map<string, StockMentionMatch>();

    for (const article of articles) {
        const text = `${article.title} ${article.content}`;
        const stocks = extractStockCodes(text);

        for (const [symbol, name] of stocks.entries()) {
            const existing = stockMap.get(symbol);
            if (existing) {
                existing.count++;
                existing.articleIds.push(article.id);
                existing.articleTitles.push(article.title);
                if (!existing.stockName && name) {
                    existing.stockName = name;
                }
            } else {
                stockMap.set(symbol, {
                    symbol,
                    stockName: name,
                    count: 1,
                    articleIds: [article.id],
                    articleTitles: [article.title],
                });
            }
        }
    }

    return stockMap;
}

// ==================== 细分概念匹配 ====================

/** 概念匹配结果 */
export interface ConceptMentionMatch {
    conceptName: string;    // 概念名称，如 "六氟化硫"
    conceptTsCode: string;  // 概念代码，如 "885853.TI"
    count: number;          // 提及次数
    articles: { id: string; title: string; source: string }[];
    stockCodes: Map<string, string>;  // 该概念下提及的个股 symbol→name
}

/**
 * 从快讯列表中匹配细分概念，提取概念+关联个股
 * 按概念词库长度降序匹配，避免"氟化工"先于"六氟化硫"匹配
 */
export async function analyzeConceptMentions(
    articles: TelegraphItem[],
    source: string,
): Promise<Map<string, ConceptMentionMatch>> {
    const vocabulary = await getConceptVocabulary();
    const conceptMap = new Map<string, ConceptMentionMatch>();

    for (const article of articles) {
        const text = `${article.title} ${article.content}`;
        // 提取该条快讯中的个股代码
        const articleStocks = extractStockCodes(text);

        // 匹配概念（词库已按长度降序排列）
        for (const concept of vocabulary) {
            if (!text.includes(concept.name)) continue;

            const existing = conceptMap.get(concept.name);
            if (existing) {
                existing.count++;
                existing.articles.push({ id: article.id, title: article.title, source });
                // 合并个股代码
                for (const [sym, name] of articleStocks.entries()) {
                    if (!existing.stockCodes.has(sym)) {
                        existing.stockCodes.set(sym, name);
                    }
                }
            } else {
                conceptMap.set(concept.name, {
                    conceptName: concept.name,
                    conceptTsCode: concept.tsCode,
                    count: 1,
                    articles: [{ id: article.id, title: article.title, source }],
                    stockCodes: new Map(articleStocks),
                });
            }
        }
    }

    return conceptMap;
}

// ==================== 爆发检测核心 ====================

export class HotKeywordDetectorService {
    /**
     * 执行一次完整的爆发检测流程：
     * 1. 爬取财联社电报 + 格隆汇快讯
     * 2. 匹配8维度关键词
     * 3. 与历史频次对比，检测爆发信号
     * 4. 返回爆发关键词列表
     */
    static async detectHotKeywords(): Promise<HotKeywordResult[]> {
        console.log('[HotKeywordDetector] 开始关键词爆发检测...');

        // 1. 爬取快讯
        const windowHours = TradingCalendarService.getDynamicWindowHours();
        console.log(`[HotKeywordDetector] detectHotKeywords 时间窗口: ${windowHours}h`);
        const [clsArticles, glhArticles] = await Promise.all([
            fetchClsTelegraph(0, 100, windowHours).catch(err => {
                console.warn('[HotKeywordDetector] 财联社电报获取失败:', err.message);
                return [] as TelegraphItem[];
            }),
            fetchGelonghuiNews(50, windowHours).catch(err => {
                console.warn('[HotKeywordDetector] 格隆汇快讯获取失败:', err.message);
                return [] as TelegraphItem[];
            }),
        ]);

        console.log(`[HotKeywordDetector] 获取快讯: 财联社=${clsArticles.length}, 格隆汇=${glhArticles.length}`);

        // 2. 匹配关键词
        const clsMatches = analyzeArticles(clsArticles, '财联社');
        const glhMatches = analyzeArticles(glhArticles, '格隆汇');

        // 合并匹配结果
        const allMatches = new Map<string, KeywordMatch>();
        for (const [kw, match] of clsMatches.entries()) {
            allMatches.set(kw, { ...match });
        }
        for (const [kw, match] of glhMatches.entries()) {
            const existing = allMatches.get(kw);
            if (existing) {
                existing.count += match.count;
                existing.articles.push(...match.articles);
            } else {
                allMatches.set(kw, { ...match });
            }
        }

        // 3. 保存快照
        await saveSnapshot(clsMatches, '财联社');
        await saveSnapshot(glhMatches, '格隆汇');

        // 4. 爆发检测：与历史对比
        const hotKeywords: HotKeywordResult[] = [];
        const now = new Date().toISOString();

        for (const [kw, match] of allMatches.entries()) {
            // 跳过只出现1次的关键词（噪声过滤）
            if (match.count < 2) continue;

            const dim = KEYWORD_DIMENSIONS[match.dimension];
            const history = await getKeywordHistory(kw);

            // 历史基准：按实际快照次数平均（非直接求和）
            // getKeywordHistory 已排除本次快照（10分钟内），此处直接用全部历史
            let previousCount = 0;
            if (history.length > 0) {
                const totalMentions = history.reduce((sum, h) => sum + h.article_count, 0);
                previousCount = Math.round((totalMentions / history.length) * 100) / 100;
            }

            // 爆发比率：当前频次 / 历史平均频次
            let surgeRatio = 0;
            if (previousCount > 0) {
                surgeRatio = match.count / previousCount;
            } else {
                // 无历史数据时，频次>=2即视为爆发
                surgeRatio = match.count >= 2 ? 2 : 0;
            }

            // 爆发阈值：surgeRatio>=1.5 或首次出现且频次>=2（与概念/个股检测一致）
            if (surgeRatio >= 1.5 || (previousCount === 0 && match.count >= 2)) {
                hotKeywords.push({
                    keyword: kw,
                    dimension: match.dimension,
                    dimensionLabel: match.dimensionLabel,
                    dimensionColor: dim?.color || '#64748b',
                    currentCount: match.count,
                    previousCount,
                    surgeRatio: Math.round(surgeRatio * 100) / 100,
                    articles: match.articles.slice(0, 5).map(a => ({
                        id: a.id,
                        title: a.title,
                        source: a.source,
                        time: '',
                    })),
                    detectedAt: now,
                });
            }
        }

        // 按爆发比率降序排序
        hotKeywords.sort((a, b) => b.surgeRatio - a.surgeRatio);

        console.log(`[HotKeywordDetector] 检测到 ${hotKeywords.length} 个爆发关键词`);
        return hotKeywords;
    }

    /**
     * 个股爆发检测（股票代码驱动）：
     * 1. 爬取财联社电报 + 格隆汇快讯
     * 2. 提取 A 股代码，按股票聚合
     * 3. 与历史频次对比，检测爆发信号
     * 4. 返回爆发个股列表
     */
    static async detectHotStocks(): Promise<HotStockResult[]> {
        console.log('[HotKeywordDetector] 开始个股爆发检测...');

        // 0. 预加载 A 股名称映射（用于公司名称→代码匹配，幂等调用）
        await loadStockNameMap();

        // 1. 爬取快讯
        const windowHours = TradingCalendarService.getDynamicWindowHours();
        console.log(`[HotKeywordDetector] detectHotStocks 时间窗口: ${windowHours}h`);
        const [clsArticles, glhArticles] = await Promise.all([
            fetchClsTelegraph(0, 100, windowHours).catch(err => {
                console.warn('[HotKeywordDetector] 财联社电报获取失败:', err.message);
                return [] as TelegraphItem[];
            }),
            fetchGelonghuiNews(50, windowHours).catch(err => {
                console.warn('[HotKeywordDetector] 格隆汇快讯获取失败:', err.message);
                return [] as TelegraphItem[];
            }),
        ]);

        // 2. 提取个股
        const clsStocks = analyzeStockMentions(clsArticles, '财联社');
        const glhStocks = analyzeStockMentions(glhArticles, '格隆汇');

        // 合并两个来源
        const allStocks = new Map<string, StockMentionMatch>();
        for (const [sym, data] of clsStocks.entries()) {
            allStocks.set(sym, { ...data });
        }
        for (const [sym, data] of glhStocks.entries()) {
            const existing = allStocks.get(sym);
            if (existing) {
                existing.count += data.count;
                existing.articleIds.push(...data.articleIds);
                existing.articleTitles.push(...data.articleTitles);
                if (!existing.stockName && data.stockName) existing.stockName = data.stockName;
            } else {
                allStocks.set(sym, { ...data });
            }
        }

        // 3. 保存快照
        const clsStockMap = new Map<string, { name: string; count: number; articleIds: string[]; articleTitles: string[] }>();
        for (const [sym, data] of clsStocks.entries()) {
            clsStockMap.set(sym, { name: data.stockName, count: data.count, articleIds: data.articleIds, articleTitles: data.articleTitles });
        }
        await saveStockMentionSnapshot(clsStockMap, '财联社');

        const glhStockMap = new Map<string, { name: string; count: number; articleIds: string[]; articleTitles: string[] }>();
        for (const [sym, data] of glhStocks.entries()) {
            glhStockMap.set(sym, { name: data.stockName, count: data.count, articleIds: data.articleIds, articleTitles: data.articleTitles });
        }
        await saveStockMentionSnapshot(glhStockMap, '格隆汇');

        // 4. 爆发检测（滚动窗口：与最近7天日均频次对比）
        const hotStocks: HotStockResult[] = [];
        const now = new Date().toISOString();

        for (const [symbol, data] of allStocks.entries()) {
            // 仅出现1次的噪声过滤
            if (data.count < 2) continue;

            const history = await getStockMentionHistory(symbol);
            // 历史基准：按实际快照次数平均（非固定除以7）
            let previousCount = 0;
            if (history.length > 0) {
                const totalMentions = history.reduce((sum, h) => sum + h.mention_count, 0);
                previousCount = Math.round((totalMentions / history.length) * 100) / 100;
            }

            let surgeRatio = 0;
            if (previousCount > 0) {
                surgeRatio = data.count / previousCount;
            } else {
                surgeRatio = data.count >= 2 ? 2 : 0;
            }

            if (surgeRatio >= 1.5 || (previousCount === 0 && data.count >= 2)) {
                hotStocks.push({
                    symbol,
                    stockName: data.stockName,
                    currentCount: data.count,
                    previousCount,
                    surgeRatio: Math.round(surgeRatio * 100) / 100,
                    articles: data.articleIds.slice(0, 5).map((id, i) => ({
                        id,
                        title: data.articleTitles[i] || '',
                        source: '财联社/格隆汇',
                        time: '',
                    })),
                    detectedAt: now,
                });
            }
        }

        hotStocks.sort((a, b) => b.surgeRatio - a.surgeRatio);
        console.log(`[HotKeywordDetector] 检测到 ${hotStocks.length} 只爆发个股`);
        return hotStocks;
    }

    /**
     * 获取最近爆发关键词（从DB查询）
     */
    static async getRecentHotKeywords(hours: number = 6, limit: number = 20): Promise<HotKeywordResult[]> {
        await ensureSchema();

        const result = await pool.query(
            `SELECT keyword, dimension, dimension_label, article_count, snapshot_time,
                    MAX(array_length(article_ids, 1)) as article_total
             FROM hot_keyword_snapshots
             WHERE snapshot_time > NOW() - INTERVAL '${hours} hours'
             GROUP BY keyword, dimension, dimension_label, article_count, snapshot_time
             ORDER BY article_count DESC
             LIMIT $1`,
            [limit],
        );

        return result.rows.map((row: any) => {
            const dim = KEYWORD_DIMENSIONS[row.dimension];
            return {
                keyword: row.keyword,
                dimension: row.dimension,
                dimensionLabel: row.dimension_label || dim?.label || '',
                dimensionColor: dim?.color || '#64748b',
                currentCount: row.article_count,
                previousCount: 0,
                surgeRatio: 0,
                articles: [],
                detectedAt: row.snapshot_time,
            };
        });
    }

    // ==================== 细分概念爆发检测 ====================

    /** 概念爆发检测结果 */
    static async detectHotConcepts(): Promise<HotConceptResult[]> {
        console.log('[HotKeywordDetector] 开始细分概念爆发检测...');

        // 0. 预加载 A 股名称映射（用于概念关联个股的代码提取，幂等调用）
        await loadStockNameMap();

        // 1. 爬取快讯
        const windowHours = TradingCalendarService.getDynamicWindowHours();
        console.log(`[HotKeywordDetector] detectHotConcepts 时间窗口: ${windowHours}h`);
        const [clsArticles, glhArticles] = await Promise.all([
            fetchClsTelegraph(0, 100, windowHours).catch(err => {
                console.warn('[HotKeywordDetector] 财联社电报获取失败:', err.message);
                return [] as TelegraphItem[];
            }),
            fetchGelonghuiNews(50, windowHours).catch(err => {
                console.warn('[HotKeywordDetector] 格隆汇快讯获取失败:', err.message);
                return [] as TelegraphItem[];
            }),
        ]);

        console.log(`[HotKeywordDetector] 概念检测获取快讯: 财联社=${clsArticles.length}, 格隆汇=${glhArticles.length}`);

        // 2. 分别匹配概念
        const [clsConcepts, glhConcepts] = await Promise.all([
            analyzeConceptMentions(clsArticles, '财联社'),
            analyzeConceptMentions(glhArticles, '格隆汇'),
        ]);

        // 3. 保存快照
        await saveConceptMentionSnapshot(clsConcepts, '财联社');
        await saveConceptMentionSnapshot(glhConcepts, '格隆汇');

        // 4. 交叉验证：两源合计≥2次即通过（不强制双源同时出现）
        //    双源同时出现标记为 crossSource=true（加分项），单源≥2次也通过
        const crossVerifiedConcepts = new Map<string, {
            clsCount: number;
            glhCount: number;
            totalCount: number;
            crossSource: boolean;
            clsArticles: { id: string; title: string; source: string }[];
            glhArticles: { id: string; title: string; source: string }[];
            stockCodes: Map<string, string>;
            conceptTsCode: string;
        }>();

        // 合并两源概念，合计≥2次即通过
        const allConceptNames = new Set([...clsConcepts.keys(), ...glhConcepts.keys()]);
        for (const conceptName of allConceptNames) {
            const clsMatch = clsConcepts.get(conceptName);
            const glhMatch = glhConcepts.get(conceptName);
            const clsCount = clsMatch?.count || 0;
            const glhCount = glhMatch?.count || 0;
            const totalCount = clsCount + glhCount;

            // 合计≥2次即通过（不强制双源同时出现）
            if (totalCount < 2) continue;

            const mergedStocks = new Map(clsMatch?.stockCodes || []);
            if (glhMatch) {
                for (const [sym, name] of glhMatch.stockCodes.entries()) {
                    if (!mergedStocks.has(sym)) mergedStocks.set(sym, name);
                }
            }
            crossVerifiedConcepts.set(conceptName, {
                clsCount,
                glhCount,
                totalCount,
                crossSource: clsCount > 0 && glhCount > 0,
                clsArticles: clsMatch?.articles || [],
                glhArticles: glhMatch?.articles || [],
                stockCodes: mergedStocks,
                conceptTsCode: clsMatch?.conceptTsCode || glhMatch?.conceptTsCode || '',
            });
        }

        const crossSourceCount = Array.from(crossVerifiedConcepts.values()).filter(c => c.crossSource).length;
        console.log(`[HotKeywordDetector] 共振一验证: ${crossVerifiedConcepts.size} 个概念通过 (双源${crossSourceCount}/单源${crossVerifiedConcepts.size - crossSourceCount})`);

        // 5. 爆发检测：对交叉验证通过的概念，与最近7天日均频次对比
        const hotConcepts: HotConceptResult[] = [];
        const now = new Date().toISOString();

        for (const [conceptName, data] of crossVerifiedConcepts.entries()) {
            // 合计≥2次已在交叉验证中过滤，此处不再重复判断

            const history = await getConceptMentionHistory(conceptName);

            // 历史基准：按实际快照次数平均（非固定除以7）
            // 交易日每天多次快照，除以7会高估基准、压低surgeRatio
            let previousCount = 0;
            if (history.length > 0) {
                const totalMentions = history.reduce((sum, h) => sum + h.mention_count, 0);
                previousCount = Math.round((totalMentions / history.length) * 100) / 100;
            }

            // 爆发比率
            let surgeRatio = 0;
            if (previousCount > 0) {
                surgeRatio = data.totalCount / previousCount;
            } else {
                // 无历史数据时，合计≥2即视为爆发
                surgeRatio = data.totalCount >= 2 ? 2 : 0;
            }

            // 爆发阈值：交叉验证通过后，surgeRatio≥1.5 或合计≥2即爆发
            if (surgeRatio >= 1.5 || (previousCount === 0 && data.totalCount >= 2)) {
                const allArticles = [...data.clsArticles, ...data.glhArticles].slice(0, 8);

                hotConcepts.push({
                    conceptName,
                    conceptTsCode: data.conceptTsCode,
                    clsCount: data.clsCount,
                    glhCount: data.glhCount,
                    totalCount: data.totalCount,
                    previousCount,
                    surgeRatio: Math.round(surgeRatio * 100) / 100,
                    crossVerified: true,
                    crossSource: data.crossSource,
                    stockCodes: Array.from(data.stockCodes.entries()).map(([symbol, name]) => ({
                        symbol,
                        name,
                        source: (data.clsArticles.some(a => a.id !== '') && data.glhArticles.some(a => a.id !== '')) ? 'both' as const
                            : data.clsArticles.length > 0 ? 'cls' as const : 'glh' as const,
                    })),
                    articles: allArticles.map(a => ({
                        id: a.id,
                        title: a.title,
                        source: a.source,
                        time: '',
                    })),
                    detectedAt: now,
                });
            }
        }

        // 按爆发比率降序排序
        hotConcepts.sort((a, b) => b.surgeRatio - a.surgeRatio);

        console.log(`[HotKeywordDetector] 检测到 ${hotConcepts.length} 个爆发细分概念`);
        return hotConcepts;
    }
}
