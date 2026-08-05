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

export interface ClsTelegraphItem {
    id: string | number;
    title: string;
    content: string;
    time: string;       // 格式化后的上海时间字符串
    timestamp: number;   // unix 秒
}

export interface ClsTelegraphResult {
    date: string;        // YYYY-MM-DD
    items: ClsTelegraphItem[];
    total: number;
    degraded: boolean;    // 部分分页失败时为 true
}

// ============================================================================
// 依赖注入（便于单测替换 sessionFetch / cailianpressThrottler；
// 生产环境默认指向真实导出。tsx 使用 ESM live binding，named import 不可
// monkey-patch，故通过对象属性注入。与 MarketSnapshotService 同一约定）
// ============================================================================

export interface ClsStockNewsDeps {
    sessionFetch: typeof sessionFetch;
    cailianpressThrottler: typeof cailianpressThrottler;
}

export const __clsNewsDependencies: ClsStockNewsDeps = {
    sessionFetch,
    cailianpressThrottler,
};

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
        return this.fetchAndParseNews(keyword, stockName, limit, lastTime);
    }

    /**
     * 获取财联社最新快讯（不带股票关键词，用于晨报）
     */
    static async getLatestNews(limit: number = 10): Promise<ClsStockNewsResult> {
        return this.fetchAndParseNews('', '', limit, 0);
    }

    /**
     * 按日期拉取财联社当日全量电报流（用于溯源事件证据）。
     *
     * 通过 lastTime 分页向前翻页，拉取指定日期 09:00-15:30 的全量电报。
     * 复用 cailianpressThrottler 限流，避免触发反爬。
     *
     * @param date YYYY-MM-DD 格式日期
     * @param options.limit 最大条数，默认 200
     */
    static async fetchTelegraphByDate(
        date: string,
        options: { limit?: number } = {},
    ): Promise<ClsTelegraphResult> {
        const limit = Math.min(options.limit ?? 200, 500);
        // 当日 09:00-15:30 上海时间转 unix 秒（边界宽松 ±30 分钟）
        const dateStart = this.parseDateToUnixSeconds(date, 8, 30);   // 08:30 起宽松
        const dateEnd = this.parseDateToUnixSeconds(date, 16, 0);     // 16:00 止宽松

        const items: ClsTelegraphItem[] = [];
        const processedIds = new Set<string | number>();  // 去重，避免分页边界条目重复
        let lastTime = 0;
        let degraded = false;
        let page = 0;
        // 翻页上限：财联社电报约 3 分钟/条，从晚间触发（如 20:30 review_full）翻回
        // 当日 08:30-16:00 窗口需要跨越数小时（约 200-400 条）。
        // 原 MAX_PAGES=10（约 100 条）在晚间触发时会翻不到窗口内数据 → total=0（线上根因）。
        // 50 页 × 10 条 = 500 条，覆盖 08:30-触发时刻的全量电报，同时受 items.length<limit 限制。
        const MAX_PAGES = 50;

        while (page < MAX_PAGES && items.length < limit) {
            try {
                const pageItems = await this.fetchTelegraphPage(lastTime);
                if (pageItems.length === 0) break;

                for (const item of pageItems) {
                    if (item.timestamp < dateStart) {
                        // 已早于目标日期，停止
                        return { date, items: items.slice(0, limit), total: items.length, degraded };
                    }
                    if (item.timestamp > dateEnd) {
                        // 晚于目标日期上限，跳过（继续向前翻页可能拿到更早的）
                        continue;
                    }
                    // 去重：分页边界可能返回已处理的条目
                    if (processedIds.has(item.id)) continue;
                    processedIds.add(item.id);
                    items.push(item);
                    if (items.length >= limit) break;
                }

                // 下一页的 lastTime 用本页最早一条的 timestamp
                lastTime = pageItems[pageItems.length - 1].timestamp;
                page++;
            } catch (err) {
                console.error(`[ClsStockNews] telegraph page ${page} failed:`, err);
                degraded = true;
                break;
            }
        }

        return { date, items: items.slice(0, limit), total: items.length, degraded };
    }

    private static parseDateToUnixSeconds(date: string, hour: number, minute: number): number {
        // YYYY-MM-DD → 当日 hour:minute 上海时间 → unix 秒
        const [y, m, d] = date.split('-').map(Number);
        // 上海时间 UTC+8
        const utcMs = Date.UTC(y, m - 1, d, hour - 8, minute, 0);
        return Math.floor(utcMs / 1000);
    }

    private static async fetchTelegraphPage(lastTime: number): Promise<ClsTelegraphItem[]> {
        const payload = {
            'lastTime': lastTime,
            'keyword': '',
            'category': '',
            'os': 'web',
            'sv': '8.4.6',
            'app': 'CailianpressWeb',
        };

        await __clsNewsDependencies.cailianpressThrottler.throttle();

        const response = await __clsNewsDependencies.sessionFetch(this.STOCK_NEWS_URL, {
            method: 'POST',
            headers: this.STOCK_NEWS_HEADERS,
            body: JSON.stringify(payload),
        });

        if (!response.ok) throw new Error(`财联社电报接口请求失败: ${response.status}`);

        const rawData: any = await response.json();
        if (typeof rawData?.errno === 'number' && rawData.errno !== 0) {
            throw new Error(`财联社接口返回错误: ${rawData.msg || 'Unknown error'}`);
        }

        // 财联社实际返回 {total, list: [...]}（2026-08-03 真实接口验证）
        const { entries } = this.extractStockNewsEntries(rawData);
        const items: ClsTelegraphItem[] = [];

        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            const ts = this.parseTimestampSeconds(entry.ctime);
            // 不再过滤 ts < lastTime：财联社 lastTime 语义是 "load more"（返回 ctime < lastTime 的更早条目），
            // 过滤会导致分页失效。去重在 fetchTelegraphByDate 层用 Set 处理。
            if (ts === null) continue;

            const parsed = this.extractTelegraphTitleAndContent(entry.content);
            const title = (typeof entry.title === 'string' ? entry.title.trim() : '') || parsed.title;
            const content = parsed.content || this.stripHtml(entry.content);

            items.push({
                id: entry.id ?? '',
                title,
                content,
                time: this.formatClsTimestamp(entry.ctime),
                timestamp: ts,
            });
        }

        return items;
    }

    private static async fetchAndParseNews(
        keyword: string,
        stockName: string,
        limit: number,
        lastTime: number,
    ): Promise<ClsStockNewsResult> {
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
