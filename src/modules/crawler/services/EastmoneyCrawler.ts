/**
 * 东方财富数据抓取服务
 * 移植自 Python 爬虫 eastmoney.py
 *
 * 功能：
 * 1. 抓取公告列表（np-anotice-stock.eastmoney.com API）
 * 2. 抓取新闻列表（search-api-web.eastmoney.com JSONP API）
 * 3. 提取新闻正文（cheerio 解析 HTML）
 * 4. 提取公告详情页文本（PDF 降级方案）
 */

import * as cheerio from 'cheerio';
import type { EastmoneyAnnouncement, EastmoneyNews } from './types';
import { sessionFetch } from '../../../shared/utils/httpAgent';
import { shanghaiDateStr } from '../../../shared/utils/shanghaiTime';
import { isAShareTradingDay } from '../../../shared/utils/tradingTime';

const EASTMONEY_NOTICE_API = 'https://np-anotice-stock.eastmoney.com/api/security/ann';
const EASTMONEY_NEWS_API = 'https://search-api-web.eastmoney.com/search/jsonp';

// 中国时区 UTC+8
const CHINA_TZ_OFFSET = 8 * 60;

// E-2（2026-08-14）：窗口起点缓存——同一轮抓取内所有股票 end 相同（now）、
// days 相同（默认 30），只回溯一次即可共享。否则 200 只股票 × 30 天会触发
// 数千次节假日 API 请求（实测被 429 限流，节假日检测失效）。
const _windowStartCache = new Map<string, Date>();

/**
 * 从 end 向前回溯 days 个 A 股交易日，返回窗口起点日期（E-2，2026-08-14）。
 * 跳过周末与法定节假日（复用 tradingTime 的 isAShareTradingDay，节假日 API
 * 结果按 dateKey 缓存）——替代原"自然日 × 24h"窗口：长假后 30 自然日仅含
 * ~15 个交易日，公告密度大增时窗口过窄漏抓。
 * 语义：end 当天若为交易日计入第 1 天。
 * 结果按 `${end 上海日期}:${days}` 缓存（同轮抓取共享，避免节假日 API 限流）。
 */
export async function tradingDayWindowStart(end: Date, days: number): Promise<Date> {
    const key = `${shanghaiDateStr(end)}:${days}`;
    const cached = _windowStartCache.get(key);
    if (cached) return cached;
    const cursor = new Date(end);
    let remaining = days;
    while (remaining > 0) {
        if (await isAShareTradingDay({ now: cursor })) remaining--;
        if (remaining > 0) cursor.setDate(cursor.getDate() - 1);
    }
    _windowStartCache.set(key, cursor);
    return cursor;
}

/** 构建 PDF 下载 URL */
function buildPdfUrl(artCode: string): string {
    return `https://pdf.dfcfw.com/pdf/H2_${artCode}_1.pdf`;
}

/** 构建公告详情页 URL */
function buildDetailUrl(symbol: string, artCode: string): string {
    return `https://data.eastmoney.com/notices/detail/${symbol}/${artCode}.html`;
}

/** 构建公告 API URL */
function buildNoticeApiUrl(symbol: string, beginDate: string, endDate: string, pageSize = 20): string {
    return (
        `${EASTMONEY_NOTICE_API}` +
        `?sr=-1&page_size=${pageSize}&page_index=1&ann_type=A&client_source=web` +
        `&f_node=0&s_node=0&begin_time=${beginDate}&end_time=${endDate}&stock_list=${symbol},0`
    );
}

/** 构建新闻 API URL（JSONP 格式）。
 * E-2（2026-08-14）：sort 由 'default'（相关性）改为 'time'（时序）——
 * 最新新闻必须进入第一页，否则相关性排序下最新消息不在前 10 条即漏抓。 */
export function buildNewsApiUrl(symbol: string, pageSize = 10): string {
    const param = {
        uid: '',
        keyword: symbol,
        type: ['cmsArticleWebOld'],
        client: 'web',
        clientType: 'web',
        clientVersion: 'curr',
        param: {
            cmsArticleWebOld: {
                searchScope: 'default',
                sort: 'time',
                pageIndex: 1,
                pageSize,
                preTag: '',
                postTag: '',
            },
        },
    };
    const encoded = encodeURIComponent(JSON.stringify(param));
    return `${EASTMONEY_NEWS_API}?cb=callback&param=${encoded}&_=${Date.now()}`;
}

/** 将东方财富日期字符串转为中国时区 ISO 字符串 */
function toChinaIso(value: string): string {
    const cleaned = value.trim();
    // 尝试 "YYYY-MM-DD HH:MM:SS" 和 "YYYY-MM-DD" 两种格式
    const dt = new Date(cleaned.length >= 10 ? cleaned : cleaned);
    if (Number.isNaN(dt.getTime())) {
        throw new Error(`invalid eastmoney notice time: ${value}`);
    }
    // 转为中国时区 ISO
    const utc = dt.getTime() + dt.getTimezoneOffset() * 60_000;
    const china = new Date(utc + CHINA_TZ_OFFSET * 60_000);
    return china.toISOString().replace('Z', '+08:00');
}

/** HTML 转纯文本 */
function htmlToText(value: string): string {
    let text = value;
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p\s*>/gi, '\n');
    text = text.replace(/<script\b.*?<\/script>/gis, '');
    text = text.replace(/<style\b.*?<\/style>/gis, '');
    text = text.replace(/<[^>]+>/g, '');
    const lines = text.split('\n').map(line => {
        // unescape HTML entities
        return line
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .trim();
    });
    return lines.filter(line => line).join('\n');
}

/** 从 JSONP 响应中提取 JSON */
function extractJsonpPayload(raw: string): any {
    const text = raw.trim();
    const match = text.match(/^[^(]+\((.*)\)\s*;?$/s);
    if (match) {
        return JSON.parse(match[1]);
    }
    return JSON.parse(text);
}

/** 从公告 API 行中提取股票代码 */
function rowSymbol(row: any): string | null {
    const codes = row?.codes;
    if (!Array.isArray(codes) || codes.length === 0) return null;
    const code = String(codes[0]?.stock_code || '').trim();
    return code || null;
}

/** 从公告 API 行中提取股票名称 */
function rowStockName(row: any): string | null {
    const codes = row?.codes;
    if (!Array.isArray(codes) || codes.length === 0) return null;
    const name = String(codes[0]?.short_name || '').trim();
    return name || null;
}

/** 解析公告列表 API 响应 */
function parseAnnouncements(payload: any, symbol: string, stockName: string): EastmoneyAnnouncement[] {
    const rows = payload?.data?.list || [];
    const announcements: EastmoneyAnnouncement[] = [];

    for (const row of rows) {
        const artCode = String(row.art_code || '').trim();
        const title = String(row.title || row.title_ch || '').trim();
        const noticeDate = String(row.notice_date || row.display_time || '').trim();
        if (!artCode || !title || !noticeDate) continue;

        const itemSymbol = rowSymbol(row) || symbol;
        const itemName = rowStockName(row) || stockName;
        announcements.push({
            symbol: itemSymbol,
            stock_name: itemName,
            art_code: artCode,
            title,
            published_at: toChinaIso(noticeDate),
            detail_url: buildDetailUrl(itemSymbol, artCode),
            pdf_url: buildPdfUrl(artCode),
        });
    }
    return announcements;
}

/** 解析新闻列表 API 响应 */
function parseNews(payload: any, symbol: string, stockName: string): EastmoneyNews[] {
    const rows = payload?.result?.cmsArticleWebOld || [];
    const news: EastmoneyNews[] = [];

    for (const row of rows) {
        const code = String(row.code || '').trim();
        const title = htmlToText(String(row.title || ''));
        const content = htmlToText(String(row.content || ''));
        const publishedAt = String(row.date || '').trim();
        const url = String(row.url || '').trim();
        if (!code || !title || !publishedAt || !url) continue;

        news.push({
            symbol,
            stock_name: stockName,
            code,
            title,
            content,
            published_at: toChinaIso(publishedAt),
            media_name: String(row.mediaName || '').trim(),
            url,
        });
    }
    return news;
}

/** 从新闻详情页 HTML 中提取正文 */
function extractNewsBody(html: string): string {
    const $ = cheerio.load(html);

    // 尝试 #ContentBody
    let body = $('#ContentBody').text();
    if (body && body.trim()) return body.trim();

    // 尝试 .txtinfos
    body = $('.txtinfos').text();
    if (body && body.trim()) return body.trim();

    // 降级到 meta description
    const meta = $('meta[name="description"]').attr('content');
    return meta ? meta.trim() : '';
}

export class EastmoneyCrawler {
    /** 抓取公告列表 */
    static async fetchAnnouncements(
        symbol: string,
        stockName: string,
        days: number,
        pageSize = 20,
    ): Promise<EastmoneyAnnouncement[]> {
        const end = new Date();
        // E-2（2026-08-14）：窗口按 A 股交易日回溯（跳过周末/节假日），
        // 替代原自然日 × 24h——长假后 30 自然日仅 ~15 个交易日，窗口过窄漏抓。
        const begin = await tradingDayWindowStart(end, days);
        const beginDate = shanghaiDateStr(begin);
        const endDate = shanghaiDateStr(end);
        const url = buildNoticeApiUrl(symbol, beginDate, endDate, pageSize);

        const response = await sessionFetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (!response.ok) {
            throw new Error(`公告API请求失败: ${response.status}`);
        }
        const payload = await response.json();
        return parseAnnouncements(payload, symbol, stockName);
    }

    /** 抓取新闻列表 */
    static async fetchNews(
        symbol: string,
        stockName: string,
        pageSize = 10,
    ): Promise<EastmoneyNews[]> {
        const url = buildNewsApiUrl(symbol, pageSize);
        const response = await sessionFetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (!response.ok) {
            throw new Error(`新闻API请求失败: ${response.status}`);
        }
        const text = await response.text();
        const payload = extractJsonpPayload(text);
        return parseNews(payload, symbol, stockName);
    }

    /** 抓取新闻正文（从详情页 HTML 提取） */
    static async fetchNewsContent(url: string, fallback: string): Promise<string> {
        try {
            const response = await sessionFetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            if (!response.ok) return fallback;
            const html = await response.text();
            return extractNewsBody(html) || fallback;
        } catch {
            return fallback;
        }
    }

    /** 下载 PDF 二进制数据 */
    static async fetchPdfBuffer(pdfUrl: string): Promise<Buffer | null> {
        try {
            const response = await sessionFetch(pdfUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            if (!response.ok) return null;
            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        } catch {
            return null;
        }
    }

    /** 从公告详情页提取文本（PDF 降级方案） */
    static async fetchDetailPageText(detailUrl: string): Promise<string> {
        try {
            const response = await sessionFetch(detailUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            if (!response.ok) return '';
            const html = await response.text();
            return extractNewsBody(html);
        } catch {
            return '';
        }
    }
}
