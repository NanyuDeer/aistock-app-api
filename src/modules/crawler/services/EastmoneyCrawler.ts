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

const EASTMONEY_NOTICE_API = 'https://np-anotice-stock.eastmoney.com/api/security/ann';
const EASTMONEY_NEWS_API = 'https://search-api-web.eastmoney.com/search/jsonp';

// 中国时区 UTC+8
const CHINA_TZ_OFFSET = 8 * 60;

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

/** 构建新闻 API URL（JSONP 格式） */
function buildNewsApiUrl(symbol: string, pageSize = 10): string {
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
                sort: 'default',
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
        const begin = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
        const beginDate = begin.toISOString().slice(0, 10);
        const endDate = end.toISOString().slice(0, 10);
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
