import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import { formatToChinaTime } from '../../shared/utils/datetime';
import * as cheerio from 'cheerio';
import { cailianpressThrottler } from '../../shared/utils/throttlers';
import { sessionFetch } from '../../shared/utils/httpAgent';
import { ClsStockNewsService } from './ClsStockNewsService';

export class NewsController {
    private static readonly BASE_URL = 'https://www.cls.cn/v3/depth/home/assembled';
    private static readonly STOCK_NEWS_DEFAULT_LIMIT = 8;
    private static readonly STOCK_NEWS_MAX_LIMIT = 50;
    private static readonly SIGN = '9f8797a1f4de66c2370f7a03990d2737';
    private static readonly BRACKET_PREFIX_PATTERN = /^【[^】]*】\s*/;

    private static cleanSummaryPrefix(summary: unknown): string {
        if (typeof summary !== 'string') return '';
        return summary.trim().replace(this.BRACKET_PREFIX_PATTERN, '').trim();
    }

    private static async fetchNews(categoryId: number, categoryName: string, res: Response): Promise<void> {
        const url = new URL(`${this.BASE_URL}/${categoryId}`);
        url.searchParams.set('app', 'CailianpressWeb');
        url.searchParams.set('os', 'web');
        url.searchParams.set('sv', '8.4.6');
        url.searchParams.set('sign', this.SIGN);

        try {
            await cailianpressThrottler.throttle();

            const response = await sessionFetch(url.toString(), {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'Referer': 'https://www.cls.cn/',
                },
            });

            if (!response.ok) {
                throw new Error(`财联社接口请求失败: ${response.status}`);
            }

            const data: any = await response.json();

            if (data.errno !== 0) {
                throw new Error(`财联社接口返回错误: ${data.msg || 'Unknown error'}`);
            }

            let articles = data.data?.top_article || [];
            if (articles.length < 5) {
                const depthList = data.data?.depth_list || [];
                articles = [...articles, ...depthList.slice(0, 5 - articles.length)];
            }

            const topArticles = articles.slice(0, 5).map((article: any) => {
                const link = article.id ? `https://www.cls.cn/detail/${article.id}` : '';
                return {
                    'ID': article.id || '',
                    '时间': formatToChinaTime(article.ctime * 1000),
                    '标题': (article.title || '').trim(),
                    '摘要': this.cleanSummaryPrefix(article.brief),
                    '作者': (article.author || article.source || '').trim(),
                    '标签': [],
                    '链接': link,
                };
            });

            createResponse(res, 200, 'success', {
                '来源': '财联社',
                '分类': categoryName,
                '更新时间': formatToChinaTime(Date.now()),
                '新闻数量': topArticles.length,
                '头条新闻': topArticles,
            });
        } catch (error: any) {
            createResponse(res, 500, error.message);
        }
    }

    static async getHeadlines(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        await this.fetchNews(1000, '头条新闻', res);
    }

    static async getCnNews(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        await this.fetchNews(1003, 'A股市场', res);
    }

    static async getHkNews(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        await this.fetchNews(1135, '港股市场', res);
    }

    static async getGlobalNews(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        await this.fetchNews(1007, '环球', res);
    }

    static async getFundNews(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        await this.fetchNews(1110, '基金/ETF', res);
    }

    static async getStockNews(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = String(req.params.symbol || '');
        if (!symbol || !/^\d{6}$/.test(symbol)) {
            createResponse(res, 400, 'Invalid symbol - A股代码必须是6位数字');
            return;
        }

        const limitParam = req.query.limit as string;
        const lastTimeParam = req.query.lastTime as string;

        let limit = this.STOCK_NEWS_DEFAULT_LIMIT;
        if (limitParam) {
            const parsedLimit = Number(limitParam);
            if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > this.STOCK_NEWS_MAX_LIMIT) {
                createResponse(res, 400, `Invalid limit - limit 必须是 1-${this.STOCK_NEWS_MAX_LIMIT} 的整数`);
                return;
            }
            limit = parsedLimit;
        }

        let lastTime = 0;
        if (lastTimeParam) {
            const parsedLastTime = Number(lastTimeParam);
            if (!Number.isInteger(parsedLastTime) || parsedLastTime < 0) {
                createResponse(res, 400, 'Invalid lastTime - lastTime 必须是大于等于0的整数');
                return;
            }
            lastTime = parsedLastTime;
        }

        try {
            const result = await ClsStockNewsService.getStockNews(symbol, { limit, lastTime });

            const normalizedItems = result.items.map(item => ({
                'ID': item.id,
                '链接': item.link,
                '标题': item.title,
                '时间': item.time,
                '内容': item.content,
            }));

            createResponse(res, 200, 'success', {
                '来源': '财联社',
                '股票代码': symbol,
                '股票简称': result.stockName,
                '查询关键词': result.keyword,
                '更新时间': formatToChinaTime(Date.now()),
                lastTime,
                '新闻数量': normalizedItems.length,
                '总数量': result.total ?? normalizedItems.length,
                '个股新闻': normalizedItems,
            });
        } catch (error: any) {
            createResponse(res, 500, error.message);
        }
    }

    static async getNewsDetail(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const id = String(req.params.id || '');
        if (!id || !/^\d+$/.test(id)) {
            createResponse(res, 400, '无效的新闻 ID');
            return;
        }

        const url = `https://www.cls.cn/detail/${id}`;

        try {
            await cailianpressThrottler.throttle();

            const response = await sessionFetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                },
            });

            if (!response.ok) {
                throw new Error(`财联社新闻页面请求失败: ${response.status}`);
            }

            const html = await response.text();
            const cleanHtml = html
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<!--[\s\S]*?-->/g, '');

            const $ = cheerio.load(cleanHtml, { scriptingEnabled: false });

            let title = '';
            $('.detail-title span').each((_, elem) => { title = $(elem).text().trim(); return false; });
            if (!title) {
                $('.detail-header').each((_, elem) => { title = $(elem).text().trim(); return false; });
            }

            let publishTime = '';
            const normalizePublishTime = (raw: string): string => {
                if (!raw) return '';
                const trimmed = raw.trim();
                if (/^\d{10,13}$/.test(trimmed)) {
                    const timestamp = Number(trimmed);
                    const ms = trimmed.length === 10 ? timestamp * 1000 : timestamp;
                    return formatToChinaTime(ms);
                }
                const normalized = trimmed
                    .replace(/\s*星期[一二三四五六日天]\s*/g, ' ')
                    .replace(/年|\//g, '-')
                    .replace(/月/g, '-')
                    .replace(/日/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                const dateTimeMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
                if (dateTimeMatch) {
                    const [, year, month, day, hour, minute, second] = dateTimeMatch;
                    const pad = (n: string) => n.padStart(2, '0');
                    return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second || '00')}`;
                }
                return trimmed;
            };

            const timeCandidates = [
                $('.m-b-20.f-s-14.l-h-2.c-999.clearfix .f-l.m-r-10').first().text(),
                $('.detail-time').first().text(),
                $('[class*="detail-time"]').first().text(),
                $('time').first().attr('datetime') || $('time').first().text(),
                $('meta[property="article:published_time"]').attr('content'),
                $('meta[name="pubdate"]').attr('content'),
            ].map(value => (value || '').trim()).filter(Boolean);

            if (timeCandidates.length > 0) {
                publishTime = normalizePublishTime(timeCandidates[0]);
            }

            let brief = '';
            $('[class*="detail-brief"]').each((_, elem) => {
                brief = this.cleanSummaryPrefix($(elem).text().trim());
                return false;
            });

            let content = '';
            $('.detail-content').each((_, elem) => {
                let htmlContent = $(elem).html() || '';
                htmlContent = htmlContent.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '');
                content = htmlContent.replace(/\n\s*\n/g, '\n').trim();
                return false;
            });

            if (!content) {
                const telegraphContent = $('.detail-telegraph-content').first();
                const telegraphImages = $('.telegraph-images-box img');
                if (telegraphContent.length > 0) {
                    let htmlContent = telegraphContent.html() || '';
                    telegraphImages.each((_, img) => {
                        const src = $(img).attr('src');
                        if (src) htmlContent += `\n<p><img src="${src}" alt="image"></p>`;
                    });
                    content = htmlContent.trim();
                }
            }

            if (!title && !brief && !content) {
                createResponse(res, 404, '未找到新闻内容');
                return;
            }

            createResponse(res, 200, 'success', {
                'ID': id,
                '链接': url,
                '时间': publishTime,
                '标题': title,
                '摘要': brief,
                '标签': [],
                '正文': content,
            });
        } catch (error: any) {
            createResponse(res, 500, error.message);
        }
    }
}
