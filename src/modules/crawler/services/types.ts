/**
 * 爬虫共享类型定义
 * 移植自 Python 爬虫 eastmoney.py / ai.py / pdf_extract.py
 */

/** 东方财富公告 */
export interface EastmoneyAnnouncement {
    symbol: string;
    stock_name: string;
    art_code: string;
    title: string;
    published_at: string;
    detail_url: string;
    pdf_url: string;
}

/** 东方财富新闻 */
export interface EastmoneyNews {
    symbol: string;
    stock_name: string;
    code: string;
    title: string;
    content: string;
    published_at: string;
    media_name: string;
    url: string;
}

/** PDF 提取结果 */
export interface PdfContent {
    text: string;
    tables: string[];
    images: string[];
}

/**
 * 新闻与目标股票的相关性，由 AI 研判时判定。
 *
 * 为什么需要：东方财富新闻接口是**按股票代码做全文检索**（keyword=600519），返回的是
 * 「正文里出现过这串数字的最新 N 篇」，其中大量是全市场统计/名单类文章
 * （「百元股数量达153只」「77股今日获机构买入评级」「主力动向：特大单净流入…」）——
 * 代码只被列举，与这只股票没有实质关系。若不判定相关性，这些文章会被当成该股票的资讯入库，
 * 最终出现在用户的「个股资讯异动」里。
 */
export type StockRelevance = 'stock_specific' | 'sector' | 'market' | 'mention_only';

export const STOCK_RELEVANCES: readonly StockRelevance[] = ['stock_specific', 'sector', 'market', 'mention_only'];

/** 允许入库的相关性：个股本身 + 所处行业景气；市场统计/名单、被动提及都算噪音，不入库 */
const INGESTABLE_RELEVANCES: readonly StockRelevance[] = ['stock_specific', 'sector'];

export function isStockRelevance(value: unknown): value is StockRelevance {
    return typeof value === 'string' && (STOCK_RELEVANCES as readonly string[]).includes(value);
}

export function isIngestableRelevance(relevance: StockRelevance): boolean {
    return INGESTABLE_RELEVANCES.includes(relevance);
}

/** AI 研判结果 */
export interface AiJudgement {
    ai_impact: string;
    ai_horizon: string;
    ai_keywords: string[];
    ai_summary: string;
    /** 与目标股票的相关性（公告路径恒有值；新闻路径缺失时按 stock_specific 兜底，避免误杀） */
    ai_relevance: StockRelevance;
}

/** 公告或新闻联合类型 */
export type CrawlCandidate = EastmoneyAnnouncement | EastmoneyNews;

/** 判断是否为公告 */
export function isAnnouncement(item: CrawlCandidate): item is EastmoneyAnnouncement {
    return 'art_code' in item;
}

/** 来源引用（用于去重和提交）；symbol 参与去重键：同一篇文章对每只股票各存一行 */
export interface SourceRef {
    symbol: string;
    source: string;
    info_type: 'news' | 'announcement';
    source_id: string;
}

/** 提交项 */
export interface SubmitItem {
    symbol: string;
    stock_name: string;
    source: string;
    info_type: 'news' | 'announcement';
    source_id: string;
    title: string;
    url: string;
    published_at: string;
    ai_impact: string;
    ai_horizon: string;
    ai_keywords: string[];
    ai_summary: string;
    ai_relevance: StockRelevance;
}

/** 抓取配置 */
export interface CrawlOptions {
    source?: 'all' | 'favorites' | 'leaders';
    limit?: number;
    lookback_days?: number;
    announcement_page_size?: number;
    news_page_size?: number;
    max_announcements_per_stock?: number;
    max_news_per_stock?: number;
    max_pdf_pages?: number;
}

/** 抓取结果 */
export interface CrawlResult {
    targets: number;
    candidates: number;
    existing: number;
    submitted: number;
    skipped: number;
    response: any;
}

/** 完整周期结果 */
export interface CycleResult {
    crawler: CrawlResult;
    push: any;
}
