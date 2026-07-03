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

/** AI 研判结果 */
export interface AiJudgement {
    ai_impact: string;
    ai_horizon: string;
    ai_keywords: string[];
    ai_summary: string;
}

/** 公告或新闻联合类型 */
export type CrawlCandidate = EastmoneyAnnouncement | EastmoneyNews;

/** 判断是否为公告 */
export function isAnnouncement(item: CrawlCandidate): item is EastmoneyAnnouncement {
    return 'art_code' in item;
}

/** 来源引用（用于去重和提交） */
export interface SourceRef {
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
