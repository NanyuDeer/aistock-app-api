/**
 * 个股资讯抓取编排服务
 * 移植自 Python 爬虫 runner.py
 *
 * 核心改进：
 * - 直接调用 StockInfoService 内部方法，省去 4 轮 HTTP 往返
 * - 直接调用 StockInfoPushService.push()，省去推送 HTTP
 * - 41 只股票串行处理，不会阻塞 Express 事件循环
 */

import { StockInfoService } from '../StockInfoService';
import { StockInfoPushService } from '../StockInfoPushService';
import { EastmoneyCrawler } from './EastmoneyCrawler';
import { extractPdfContent } from './PdfExtractor';
import { StockInfoJudgeService } from './StockInfoJudgeService';
import type {
    AiJudgement,
    CrawlCandidate,
    CrawlOptions,
    CrawlResult,
    CycleResult,
    EastmoneyAnnouncement,
    EastmoneyNews,
    PdfContent,
    SourceRef,
    SubmitItem,
} from './types';
import { isAnnouncement } from './types';

/** 构建来源引用（移植自 submitter.py build_source_ref） */
function buildSourceRef(item: CrawlCandidate): SourceRef {
    if (isAnnouncement(item)) {
        return {
            source: 'eastmoney',
            info_type: 'announcement',
            source_id: `eastmoney-announcement-${item.art_code}`,
        };
    }
    return {
        source: 'eastmoney',
        info_type: 'news',
        source_id: `eastmoney-news-${item.code}`,
    };
}

/** 构建提交项（移植自 submitter.py build_submit_item） */
function buildSubmitItem(item: CrawlCandidate, judgement: AiJudgement): SubmitItem {
    const sourceRef = buildSourceRef(item);
    if (isAnnouncement(item)) {
        return {
            symbol: item.symbol,
            stock_name: item.stock_name,
            ...sourceRef,
            title: item.title,
            url: item.detail_url,
            published_at: item.published_at,
            ai_impact: judgement.ai_impact,
            ai_horizon: judgement.ai_horizon,
            ai_keywords: judgement.ai_keywords,
            ai_summary: judgement.ai_summary,
        };
    }
    return {
        symbol: item.symbol,
        stock_name: item.stock_name,
        ...sourceRef,
        title: item.title,
        url: item.url,
        published_at: item.published_at,
        ai_impact: judgement.ai_impact,
        ai_horizon: judgement.ai_horizon,
        ai_keywords: judgement.ai_keywords,
        ai_summary: judgement.ai_summary,
    };
}

/** 默认配置 */
const DEFAULT_OPTIONS: Required<CrawlOptions> = {
    source: 'all',
    limit: 200,
    lookback_days: 30,
    announcement_page_size: 20,
    news_page_size: 10,
    max_announcements_per_stock: 3,
    max_news_per_stock: 3,
    max_pdf_pages: 6,
};

export class StockInfoCrawlService {
    /**
     * 单次抓取（替代 Python runner.run_once）
     * 1. 从 DB 获取目标股票
     * 2. 逐只抓取公告 + 新闻
     * 3. PDF 提取 + AI 研判
     * 4. 去重 + 入库
     */
    static async runOnce(options: CrawlOptions = {}): Promise<CrawlResult> {
        const opts = { ...DEFAULT_OPTIONS, ...options };

        // 1. 直接调内部方法获取目标（省去 HTTP）
        const targets = await StockInfoService.getTargets(
            StockInfoService.normalizeSource(opts.source),
            StockInfoService.normalizeLimit(opts.limit),
        );
        console.log(`[CrawlService] 目标股票: ${targets.length} 只`);

        const candidates: CrawlCandidate[] = [];
        let skipped = 0;

        // 2. 逐只股票抓取公告 + 新闻
        for (const target of targets) {
            const symbol = target.symbol.trim();
            const stockName = target.stock_name.trim();
            if (!symbol || !stockName) {
                skipped++;
                continue;
            }

            try {
                // 抓公告
                const announcements = (await EastmoneyCrawler.fetchAnnouncements(
                    symbol,
                    stockName,
                    opts.lookback_days,
                    opts.announcement_page_size,
                )).slice(0, opts.max_announcements_per_stock);
                candidates.push(...announcements);

                // 抓新闻
                const news = (await EastmoneyCrawler.fetchNews(
                    symbol,
                    stockName,
                    opts.news_page_size,
                )).slice(0, opts.max_news_per_stock);
                candidates.push(...news);
            } catch (err) {
                console.warn(`[CrawlService] 抓取失败 ${symbol} ${stockName}:`, (err as Error).message);
            }
        }

        console.log(`[CrawlService] 候选资讯: ${candidates.length} 条`);

        // 3. 去重检查（直接查 DB，省去 HTTP）
        const sourceRefs = candidates.map(buildSourceRef);
        const existingKeys = await StockInfoService.getExistingJudgements(sourceRefs);
        const existingSet = new Set(
            existingKeys.map(k => `${k.source}|${k.info_type}|${k.source_id}`),
        );
        console.log(`[CrawlService] 已存在: ${existingSet.size} 条`);

        // 4. PDF 提取 + AI 研判 + 构建提交项
        const submitItems: SubmitItem[] = [];

        for (const item of candidates) {
            const sourceRef = buildSourceRef(item);
            const sourceKey = `${sourceRef.source}|${sourceRef.info_type}|${sourceRef.source_id}`;
            if (existingSet.has(sourceKey)) {
                skipped++;
                continue;
            }

            if (isAnnouncement(item)) {
                // 公告：下载 PDF → 提取文本 → AI 研判
                const pdfBuffer = await EastmoneyCrawler.fetchPdfBuffer(item.pdf_url);
                if (!pdfBuffer) {
                    skipped++;
                    continue;
                }

                let pdf: PdfContent;
                if (!pdfBuffer.subarray(0, 5).toString('ascii').startsWith('%PDF')) {
                    // 非 PDF 内容，降级到详情页提取
                    console.log(`[CrawlService] 非PDF内容，尝试详情页: ${item.symbol} ${item.title.slice(0, 30)}`);
                    const detailText = await EastmoneyCrawler.fetchDetailPageText(item.detail_url);
                    if (!detailText) {
                        console.log(`[CrawlService] 详情页也无内容，跳过: ${item.symbol}`);
                        skipped++;
                        continue;
                    }
                    pdf = { text: detailText, tables: [], images: [] };
                } else {
                    pdf = await extractPdfContent(pdfBuffer, opts.max_pdf_pages);
                    if (!pdf.text) {
                        console.log(`[CrawlService] PDF无文本，跳过: ${item.symbol} ${item.title.slice(0, 30)}`);
                        skipped++;
                        continue;
                    }
                }

                try {
                    const judgement = await StockInfoJudgeService.judgeAnnouncement(item, pdf);
                    if (judgement) {
                        console.log(`[CrawlService] AI研判成功: ${item.symbol} ${judgement.ai_impact} - ${judgement.ai_summary.slice(0, 30)}`);
                        submitItems.push(buildSubmitItem(item, judgement));
                    } else {
                        console.log(`[CrawlService] AI研判返回None，跳过: ${item.symbol}`);
                        skipped++;
                    }
                } catch (err) {
                    console.warn(`[CrawlService] AI研判异常，跳过: ${item.symbol} - ${(err as Error).message.slice(0, 80)}`);
                    skipped++;
                }
            } else {
                // 新闻：提取正文 → AI 研判
                const content = await EastmoneyCrawler.fetchNewsContent(item.url, item.content);
                const news: EastmoneyNews = {
                    ...item,
                    content,
                };

                try {
                    const judgement = await StockInfoJudgeService.judgeNews(news);
                    if (judgement) {
                        console.log(`[CrawlService] AI研判成功: ${news.symbol} ${judgement.ai_impact} - ${judgement.ai_summary.slice(0, 30)}`);
                        submitItems.push(buildSubmitItem(news, judgement));
                    } else {
                        console.log(`[CrawlService] AI研判返回None，跳过: ${news.symbol}`);
                        skipped++;
                    }
                } catch (err) {
                    console.warn(`[CrawlService] AI研判异常，跳过: ${news.symbol} - ${(err as Error).message.slice(0, 80)}`);
                    skipped++;
                }
            }
        }

        // 5. 入库（直接调 upsert，省去 HTTP）
        let response = null;
        if (submitItems.length > 0) {
            response = await StockInfoService.upsertJudgements(submitItems as Record<string, any>[]);
            console.log(`[CrawlService] 入库完成: 插入${response.summary.inserted} 更新${response.summary.updated} 失败${response.summary.failed}`);
        }

        return {
            targets: targets.length,
            candidates: candidates.length,
            existing: existingSet.size,
            submitted: submitItems.length,
            skipped,
            response,
        };
    }

    /**
     * 完整周期（替代 Python runner.run_cycle）
     * runOnce + 推送
     */
    static async runCycle(
        window: 'morning' | 'closing',
        options: CrawlOptions = {},
    ): Promise<CycleResult> {
        const crawlerResult = await this.runOnce(options);

        // 直接调 push()，省去 HTTP
        const pushResult = await StockInfoPushService.push({ window });
        console.log(`[CrawlService] 推送完成: 候选${pushResult.candidates} 发送${pushResult.sent} 跳过${pushResult.skipped}`);

        return { crawler: crawlerResult, push: pushResult };
    }
}
