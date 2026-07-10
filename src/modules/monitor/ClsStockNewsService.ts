import * as cheerio from 'cheerio';
import { formatToChinaTime } from '../../shared/utils/datetime';
import { cailianpressThrottler } from '../../shared/utils/throttlers';
import { sessionFetch } from '../../shared/utils/httpAgent';
import pool from '../../core/db';

export interface ClsStockNewsItem {
    id: string | number;
    link: string;
    title: string;
    time: string;
    content: string;
}

export interface ClsStockNewsResult {
    stockName: string;
    keyword: string;
    total: number | null;
    items: ClsStockNewsItem[];
}

export interface ClsStockNewsOptions {
    limit: number;
    lastTime: number;
}

export class ClsStockNewsService {
    private static readonly STOCK_NEWS_URL = 'https://www.cls.cn/api/csw?app=CailianpressWeb&os=web&sv=8.4.6&sign=9f8797a1f4de66c2370f7a03990d2737';
    private static readonly STOCK_NEWS_HEADERS = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'Origin': 'https://www.cls.cn',
        'Referer': 'https://www.cls.cn/telegraph',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    };
    private static readonly BRACKET_PREFIX_PATTERN = /^【[^】]*】/;

    private static formatClsTimestamp(timestamp: unknown): string {
        if (timestamp === null || timestamp === undefined) return '';
        const tsNumber = Number(timestamp);
        if (!Number.isFinite(tsNumber)) return '';
        const ms = tsNumber < 1_000_000_000_000 ? tsNumber * 1000 : tsNumber;
        return formatToChinaTime(ms);
    }

    private static parseTimestampSeconds(timestamp: unknown): number | null {
        if (timestamp === null || timestamp === undefined) return null;
        const tsNumber = Number(timestamp);
        if (!Number.isFinite(tsNumber)) return null;
        return tsNumber >= 1_000_000_000_000 ? Math.floor(tsNumber / 1000) : Math.floor(tsNumber);
    }

    private static stripHtml(rawHtml: unknown): string {
        if (typeof rawHtml !== 'string' || !rawHtml.trim()) return '';
        const text = cheerio.load(rawHtml).text().trim();
        return text.replace(this.BRACKET_PREFIX_PATTERN, '').trim();
    }

    private static extractTelegraphTitleAndContent(rawHtml: unknown): { title: string; content: string } {
        if (typeof rawHtml !== 'string' || !rawHtml.trim()) return { title: '', content: '' };
        const $ = cheerio.load(rawHtml);
        const title = ($('.detail-header').first().text() || '').trim();
        const content = ($('.detail-telegraph-content').first().text() || '').trim();
        return {
            title: title.replace(this.BRACKET_PREFIX_PATTERN, '').trim(),
            content: content.replace(this.BRACKET_PREFIX_PATTERN, '').trim(),
        };
    }

    private static extractStockNewsEntries(payload: any): { entries: any[]; total: number | null } {
        if (payload && typeof payload === 'object') {
            if (Array.isArray(payload.list)) {
                let total: number | null = null;
                if (typeof payload.total === 'number' && Number.isFinite(payload.total)) total = payload.total;
                else if (typeof payload.total === 'string' && /^\d+$/.test(payload.total)) total = Number(payload.total);
                return { entries: payload.list, total };
            }
            if ('data' in payload) return this.extractStockNewsEntries(payload.data);
        }
        return { entries: [], total: null };
    }

    private static extractNewsLink(entry: any): string {
        const entryId = entry?.id;
        if (entryId) return `https://www.cls.cn/detail/${entryId}`;
        const schema = typeof entry?.schema === 'string' ? entry.schema : '';
        const match = schema.match(/article_id=(\d+)/);
        if (match?.[1]) return `https://www.cls.cn/detail/${match[1]}`;
        return '';
    }

    private static async resolveStockKeyword(symbol: string): Promise<{ keyword: string; stockName: string }> {
        try {
            const result = await pool.query('SELECT name FROM stocks WHERE symbol = $1 LIMIT 1', [symbol]);
            const row = result.rows[0] as { name: string } | undefined;
            const stockName = (row?.name || '').trim();
            return { keyword: stockName || symbol, stockName };
        } catch {
            return { keyword: symbol, stockName: '' };
        }
    }

    static async getStockNews(symbol: string, options: ClsStockNewsOptions): Promise<ClsStockNewsResult> {
        const { limit, lastTime } = options;
        const { keyword, stockName } = await this.resolveStockKeyword(symbol);
        const payload = {
            'lastTime': lastTime,
            'keyword': keyword,
            'category': '',
            'os': 'web',
            'sv': '8.4.6',
            'app': 'CailianpressWeb',
        };

        await cailianpressThrottler.throttle();

        const response = await sessionFetch(this.STOCK_NEWS_URL, {
            method: 'POST',
            headers: this.STOCK_NEWS_HEADERS,
            body: JSON.stringify(payload),
        });

        if (!response.ok) throw new Error(`财联社个股新闻接口请求失败: ${response.status}`);

        let rawData: any = null;
        try { rawData = await response.json(); } catch { throw new Error('Failed to decode JSON response'); }
        if (typeof rawData?.errno === 'number' && rawData.errno !== 0) throw new Error(`财联社接口返回错误: ${rawData.msg || 'Unknown error'}`);

        const { entries, total } = this.extractStockNewsEntries(rawData);
        const items: ClsStockNewsItem[] = [];

        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            const entryCtimeSec = this.parseTimestampSeconds(entry.ctime);
            if (entryCtimeSec === null || entryCtimeSec < lastTime) continue;

            const parsedFromHtml = this.extractTelegraphTitleAndContent(entry.content);
            const title = (typeof entry.title === 'string' ? entry.title.trim() : '') || parsedFromHtml.title;
            const content = parsedFromHtml.content || this.stripHtml(entry.content);

            items.push({ id: entry.id || '', link: this.extractNewsLink(entry), title, time: this.formatClsTimestamp(entry.ctime), content });
            if (items.length >= limit) break;
        }

        return { stockName, keyword, total, items };
    }

    static async getNewsFulltext(newsId: string): Promise<{ title: string; content: string; link: string; time: string } | null> {
        const url = `https://www.cls.cn/detail/${newsId}`;
        await cailianpressThrottler.throttle();

        const response = await sessionFetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Referer': 'https://www.cls.cn/telegraph',
            },
        });

        if (!response.ok) return null;

        const html = await response.text();
        const $ = cheerio.load(html);

        const title = ($('.detail-header').first().text() || $('h1').first().text() || '').trim();
        const content = ($('.detail-content').first().text() || $('.content').first().text() || '').trim();

        if (!content) return null;

        return {
            title: title.replace(this.BRACKET_PREFIX_PATTERN, '').trim(),
            content: content.slice(0, 20000),
            link: url,
            time: $('.detail-time').first().text().trim() || '',
        };
    }
}
