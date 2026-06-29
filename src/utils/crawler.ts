/**
 * 分布式爬虫工具 - 反反爬虫策略
 *
 * 特性：
 * 1. UA轮换 - 随机选择User-Agent，模拟不同浏览器
 * 2. 随机延迟 - 请求间隔加入随机抖动，避免固定频率被检测
 * 3. 并发控制 - 支持多并发同时爬取，提高效率
 * 4. 自动重试 - 请求失败自动重试，带指数退避
 * 5. 请求指纹 - 每次请求生成不同的headers组合
 */

import { sessionFetch } from './httpAgent';

// ==================== UA池 ====================
const USER_AGENTS = [
    // Chrome - Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    // Chrome - Mac
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    // Edge
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
    // Firefox
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
    // Safari
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
];

// Accept-Language 池
const ACCEPT_LANGUAGES = [
    'zh-CN,zh;q=0.9,en;q=0.8',
    'zh-CN,zh;q=0.9',
    'zh-CN,zh;q=0.8,en-US;q=0.6,en;q=0.4',
    'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'zh-Hans-CN,zh-Hans;q=0.9,en;q=0.8',
];

// Referer 池（同花顺相关）
const THS_REFERERS = [
    'https://www.10jqka.com.cn/',
    'https://q.10jqka.com.cn/',
    'https://basic.10jqka.com.cn/',
    'https://stockpage.10jqka.com.cn/',
    'https://www.10jqka.com.cn/',
];

// ==================== 工具函数 ====================

/** 随机整数 [min, max] */
function randInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 随机选择数组元素 */
function randPick<T>(arr: T[]): T {
    return arr[randInt(0, arr.length - 1)];
}

/** 随机延迟 [minMs, maxMs] */
function randomDelay(minMs: number, maxMs: number): Promise<void> {
    const ms = randInt(minMs, maxMs);
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 分布式爬虫类 ====================

export interface CrawlerOptions {
    /** 并发数，默认3 */
    concurrency?: number;
    /** 基础延迟(ms)，实际延迟 = baseDelay + random(0, jitter)，默认800 */
    baseDelay?: number;
    /** 延迟抖动(ms)，默认1200 */
    jitter?: number;
    /** 最大重试次数，默认3 */
    maxRetries?: number;
    /** 重试基础延迟(ms)，默认2000 */
    retryBaseDelay?: number;
    /** 自定义headers生成器 */
    headersFactory?: (url: string) => Record<string, string>;
}

interface CrawlTask<T> {
    url: string;
    handler: (html: string, url: string) => T | Promise<T>;
    options?: { headers?: Record<string, string>; isJson?: boolean };
}

export class DistributedCrawler {
    private concurrency: number;
    private baseDelay: number;
    private jitter: number;
    private maxRetries: number;
    private retryBaseDelay: number;
    private headersFactory: ((url: string) => Record<string, string>) | null;

    // 每个并发槽位独立追踪上次请求时间
    private slotLastTime: number[];
    // 全局请求计数
    private requestCount = 0;
    // 失败计数
    private failCount = 0;

    constructor(options: CrawlerOptions = {}) {
        this.concurrency = options.concurrency ?? 3;
        this.baseDelay = options.baseDelay ?? 800;
        this.jitter = options.jitter ?? 1200;
        this.maxRetries = options.maxRetries ?? 3;
        this.retryBaseDelay = options.retryBaseDelay ?? 2000;
        this.headersFactory = options.headersFactory ?? null;
        this.slotLastTime = new Array(this.concurrency).fill(0);
    }

    /** 生成随机请求headers */
    generateHeaders(url: string): Record<string, string> {
        if (this.headersFactory) {
            return this.headersFactory(url);
        }
        const ua = randPick(USER_AGENTS);
        const lang = randPick(ACCEPT_LANGUAGES);
        const referer = randPick(THS_REFERERS);

        // 根据URL推断Referer
        let finalReferer = referer;
        if (url.includes('basic.10jqka.com.cn')) {
            finalReferer = 'https://www.10jqka.com.cn/';
        } else if (url.includes('q.10jqka.com.cn')) {
            finalReferer = 'https://q.10jqka.com.cn/';
        }

        // 简化headers，只保留最基本的，避免被反爬检测
        return {
            'User-Agent': ua,
            'Referer': finalReferer,
            'Accept-Language': lang,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        };
    }

    /** 带反爬延迟的单次请求 */
    private async throttledFetch(
        url: string,
        slotIndex: number,
        extraHeaders?: Record<string, string>
    ): Promise<Response> {
        // 计算延迟：baseDelay + random(0, jitter)
        const delay = this.baseDelay + randInt(0, this.jitter);
        const now = Date.now();
        const elapsed = now - this.slotLastTime[slotIndex];
        if (elapsed < delay) {
            await randomDelay(delay - elapsed, delay - elapsed + randInt(0, 300));
        }
        this.slotLastTime[slotIndex] = Date.now();

        const headers = { ...this.generateHeaders(url), ...extraHeaders };
        this.requestCount++;
        return sessionFetch(url, { headers });
    }

    /** 带重试的GBK HTML请求 */
    async fetchHtml(url: string, extraHeaders?: Record<string, string>): Promise<string> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    // 指数退避 + 随机抖动
                    const backoff = this.retryBaseDelay * Math.pow(2, attempt - 1) + randInt(0, 1000);
                    console.log(`[Crawler] 重试 ${attempt}/${this.maxRetries}，等待 ${backoff}ms: ${url}`);
                    await new Promise<void>(r => setTimeout(r, backoff));
                }

                const slotIndex = this.requestCount % this.concurrency;
                const response = await this.throttledFetch(url, slotIndex, extraHeaders);

                if (response.status === 429) {
                    // 被限流，等待更长时间
                    const retryAfter = parseInt(response.headers.get('retry-after') || '30') * 1000;
                    console.warn(`[Crawler] 被限流(429)，等待 ${retryAfter}ms: ${url}`);
                    await new Promise<void>(r => setTimeout(r, retryAfter));
                    continue;
                }

                if (response.status === 403) {
                    console.warn(`[Crawler] 被拒绝(403)，可能触发反爬: ${url}`);
                    // 增加延迟后重试
                    await randomDelay(5000, 10000);
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const arrayBuffer = await response.arrayBuffer();
                return new TextDecoder('gbk').decode(Buffer.from(arrayBuffer));
            } catch (err) {
                lastError = err as Error;
                this.failCount++;
            }
        }

        throw lastError || new Error(`请求失败: ${url}`);
    }

    /** 带重试的JSON API请求 */
    async fetchJson<T = any>(url: string, extraHeaders?: Record<string, string>): Promise<T> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    const backoff = this.retryBaseDelay * Math.pow(2, attempt - 1) + randInt(0, 1000);
                    console.log(`[Crawler] 重试 ${attempt}/${this.maxRetries}，等待 ${backoff}ms: ${url}`);
                    await new Promise<void>(r => setTimeout(r, backoff));
                }

                const slotIndex = this.requestCount % this.concurrency;
                const response = await this.throttledFetch(url, slotIndex, extraHeaders);

                if (response.status === 429) {
                    const retryAfter = parseInt(response.headers.get('retry-after') || '30') * 1000;
                    console.warn(`[Crawler] 被限流(429)，等待 ${retryAfter}ms: ${url}`);
                    await new Promise<void>(r => setTimeout(r, retryAfter));
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                return await response.json() as T;
            } catch (err) {
                lastError = err as Error;
                this.failCount++;
            }
        }

        throw lastError || new Error(`请求失败: ${url}`);
    }

    /**
     * 批量并发爬取
     * @param tasks 任务列表
     * @returns 结果数组（与输入顺序一致），失败的返回null
     */
    async crawlAll<T>(tasks: CrawlTask<T>[]): Promise<(T | null)[]> {
        const results: (T | null)[] = new Array(tasks.length).fill(null);

        // 使用并发池
        let nextIndex = 0;
        const workers = Array.from({ length: Math.min(this.concurrency, tasks.length) }, async (_, workerId) => {
            while (nextIndex < tasks.length) {
                const idx = nextIndex++;
                const task = tasks[idx];
                try {
                    let content: string | object;
                    if (task.options?.isJson) {
                    content = await this.fetchJson<object>(task.url, task.options?.headers);
                } else {
                    content = await this.fetchHtml(task.url, task.options?.headers);
                }
                    const html = typeof content === 'string' ? content : JSON.stringify(content);
                    results[idx] = await task.handler(html, task.url);
                } catch (err) {
                    console.warn(`[Crawler] 任务失败 [worker${workerId}]: ${task.url}`, (err as Error).message);
                    results[idx] = null;
                }
            }
        });

        await Promise.all(workers);
        console.log(`[Crawler] 批量爬取完成: 成功${results.filter(r => r !== null).length}/${tasks.length}, 总请求${this.requestCount}, 失败${this.failCount}`);
        return results;
    }

    /** 获取统计信息 */
    getStats() {
        return {
            totalRequests: this.requestCount,
            failedRequests: this.failCount,
            successRate: this.requestCount > 0
                ? ((this.requestCount - this.failCount) / this.requestCount * 100).toFixed(1) + '%'
                : 'N/A',
        };
    }

    /** 重置统计 */
    reset() {
        this.requestCount = 0;
        this.failCount = 0;
        this.slotLastTime.fill(0);
    }
}

// ==================== 预定义爬虫实例 ====================

/** 同花顺爬虫 - 3并发，适合板块页面爬取 */
export const thsCrawler = new DistributedCrawler({
    concurrency: 3,
    baseDelay: 800,
    jitter: 1200,
    maxRetries: 3,
    retryBaseDelay: 2000,
});

/** 同花顺轻量爬虫 - 2并发，适合API请求 */
export const thsApiCrawler = new DistributedCrawler({
    concurrency: 2,
    baseDelay: 500,
    jitter: 800,
    maxRetries: 2,
    retryBaseDelay: 1500,
});
