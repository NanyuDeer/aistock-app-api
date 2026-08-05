// src/modules/insight/LimitUpRadarCrawler.ts
// 涨停雷达（每日牛股资讯）列表采集器：列表分页 + 详情解析
//
// 说明：
// - thsCrawler.fetchHtml 内部已完成 GBK 解码（见 shared/utils/crawler.ts），
//   与 monitor/WindLeaderAnalyzerService 保持一致，直接传 URL 即可，无需 decode 参数。
// - 列表页发布日期仅展示"08月05日 11:21"这类无年份字符串，无法直接得到完整日期；
//   文章日期统一从详情 URL 的 /YYYYMMDD/ 段提取（见 extractTradeDate），
//   采集器据此判断是否已越过回溯日期。
import * as cheerio from 'cheerio';
import { thsCrawler } from '../../shared/utils/crawler';
import type { MentionedSymbol } from './types';

const LIST_URL = 'https://yuanchuang.10jqka.com.cn/mrnxgg_list/';
const MAX_PAGES = 30;                 // 安全上限（PRD：连续 2 页无新 ID 或 30 页上限）
const CONSECUTIVE_EMPTY_LIMIT = 2;

export interface RawArticle {
    articleId: string;
    title: string;
    excerpt: string;
    publishedAt: string;   // "08月05日 11:21"（列表页展示的发布时间，无年份）
    tradeDate: string;     // YYYY-MM-DD，从详情 URL 提取
    detailUrl: string;
}

export interface ParsedDetail {
    content: string;          // 异动原因揭秘正文（含免责声明前全文）
    // 与 types.ts MentionedSymbol 对齐（change_pct），避免 camelCase 死字段
    mentionedSymbols: MentionedSymbol[];
    publishedAt: string;      // "2026-08-05 11:26:03"
}

/** 解析标题关键词：'涨停雷达：半导体靶材+央企+超跌反弹 东方钽业触及涨停' → ['半导体靶材','央企','超跌反弹'] */
export function parseTitleKeywords(title: string): string[] {
    const m = title.match(/涨停雷达[:：]\s*(.+?)(?:\s+[\u4e00-\u9fa5A-Za-z0-9*]+(?:触及涨停|触及跌停))/);
    if (!m) return [];
    return m[1].split(/[+＋]/).map(s => s.trim()).filter(Boolean);
}

/** 从详情 URL 提取文章日期：/20260805/c678683171.shtml → '2026-08-05'；无法提取返回空串 */
export function extractTradeDate(detailUrl: string): string {
    const m = detailUrl.match(/\/(\d{8})\//);
    if (!m) return '';
    const y = m[1].slice(0, 4);
    const mo = m[1].slice(4, 6);
    const d = m[1].slice(6, 8);
    return `${y}-${mo}-${d}`;
}

/** 解析列表页 HTML（纯函数，便于单测） */
export function parseListHtml(html: string): RawArticle[] {
    const $ = cheerio.load(html);
    const items: RawArticle[] = [];
    $('a[href*="yuanchuang.10jqka.com.cn/20"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const title = $(el).text().trim();
        const m = href.match(/\/(\d{8})\/(c\d+)\.shtml/);
        if (!m) return;
        items.push({
            articleId: m[2],
            title,
            excerpt: '',
            publishedAt: '',
            tradeDate: extractTradeDate(href),
            detailUrl: `https://yuanchuang.10jqka.com.cn/${m[1]}/${m[2]}.shtml`,
        });
    });
    return items;
}

/** 抓取列表第 page 页（1 起始） */
export async function fetchListPage(page: number): Promise<RawArticle[]> {
    const url = page === 1 ? LIST_URL : `${LIST_URL}index_${page}.shtml`;
    const html = await thsCrawler.fetchHtml(url);
    return parseListHtml(html);
}

/** 按页抓取，遇连续无新文章或到达上限停止 */
export async function fetchLatest(
    knownArticleIds: Set<string>,
    sinceDate: string, // YYYY-MM-DD，冷启动回溯 2 个交易日
): Promise<RawArticle[]> {
    const result: RawArticle[] = [];
    let consecutiveEmpty = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
        const items = await fetchListPage(page);
        const fresh = items.filter(i => !knownArticleIds.has(i.articleId));
        if (fresh.length === 0) {
            consecutiveEmpty++;
            if (consecutiveEmpty >= CONSECUTIVE_EMPTY_LIMIT) break;
            continue;
        }
        consecutiveEmpty = 0;
        result.push(...fresh);
        // 列表按发布时间倒序，已越过回溯日期则提前停止
        if (fresh.every(i => i.tradeDate < sinceDate)) break;
    }
    return result;
}

/** 解析详情页 HTML（纯函数，便于单测） */
export function parseDetailHtml(html: string): ParsedDetail {
    const $ = cheerio.load(html);
    const content = $('.art_p, .content, article').first().text().trim() || $('body').text().trim();
    const mentionedSymbols: ParsedDetail['mentionedSymbols'] = [];
    $('a[href*="stockpage.10jqka.com.cn/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const sym = href.match(/(\d{6})/)?.[1];
        const name = $(el).text().trim().replace(/（\d{6}）/g, '');
        if (sym && name) mentionedSymbols.push({ symbol: sym, name });
    });
    const publishedAt = ($('.time, .pub_time, .atc_time').first().text().trim()) || '';
    return { content, mentionedSymbols, publishedAt };
}

/** 抓取详情页正文、文章提及标的、发布时间 */
export async function fetchDetail(detailUrl: string): Promise<ParsedDetail> {
    const html = await thsCrawler.fetchHtml(detailUrl);
    return parseDetailHtml(html);
}
