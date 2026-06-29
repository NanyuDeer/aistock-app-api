/**
 * AI 研判服务
 * 移植自 Python 爬虫 ai.py + clients.py(AiClient)
 *
 * 使用 CRAWLER_AI_* 环境变量，与后端 EVA_MODEL 隔离
 * prompt 和 JSON 解析逻辑直接移植自 Python
 */

import type { AiJudgement, EastmoneyAnnouncement, EastmoneyNews, PdfContent } from './types';
import { sessionFetch } from '../../utils/httpAgent';

const IMPACTS = new Set(['重大利好', '利好', '中性', '利空', '重大利空']);
const HORIZONS = new Set(['短期', '中期', '长期', '中长期']);

const SYSTEM_PROMPT_ANNOUNCEMENT =
    '你是A股公告研判助手。只根据用户提供的公告PDF信息判断对股票的影响。必须只返回JSON，不要解释，不要Markdown。';

const SYSTEM_PROMPT_NEWS =
    '你是A股新闻研判助手。只根据用户提供的新闻信息判断对股票的影响。必须只返回JSON，不要解释，不要Markdown。';

/** 截断文本 */
function trim(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return value.slice(0, maxChars) + '\n[已截断]';
}

/** 构建公告研判 prompt */
function buildAnnouncementPrompt(announcement: EastmoneyAnnouncement, pdf: PdfContent): string {
    const tables = pdf.tables.join('\n\n');
    return (
        '请研判这份A股公告对股票的影响，并返回严格JSON：\n' +
        '{' +
        '"ai_impact":"重大利好|利好|中性|利空|重大利空",' +
        '"ai_horizon":"短期|中期|长期|中长期",' +
        '"ai_keywords":["最多8个关键词"],' +
        '"ai_summary":"一句最终短结论"' +
        '}\n\n' +
        `股票代码：${announcement.symbol}\n` +
        `股票名称：${announcement.stock_name}\n` +
        `公告标题：${announcement.title}\n` +
        `公告时间：${announcement.published_at}\n` +
        `公告链接：${announcement.detail_url}\n` +
        `PDF链接：${announcement.pdf_url}\n\n` +
        `PDF文本：\n${trim(pdf.text, 18000)}\n\n` +
        `PDF表格：\n${trim(tables, 8000)}`
    );
}

/** 构建新闻研判 prompt */
function buildNewsPrompt(news: EastmoneyNews): string {
    return (
        '请研判这条A股新闻对股票的影响，并返回严格JSON：\n' +
        '{' +
        '"ai_impact":"重大利好|利好|中性|利空|重大利空",' +
        '"ai_horizon":"短期|中期|长期|中长期",' +
        '"ai_keywords":["最多8个关键词"],' +
        '"ai_summary":"一句最终短结论"' +
        '}\n\n' +
        `股票代码：${news.symbol}\n` +
        `股票名称：${news.stock_name}\n` +
        `新闻标题：${news.title}\n` +
        `新闻来源：${news.media_name}\n` +
        `新闻时间：${news.published_at}\n` +
        `新闻链接：${news.url}\n\n` +
        `新闻正文：\n${trim(news.content, 18000)}`
    );
}

/** 从 AI 返回的文本中提取 JSON 对象（移植自 Python _load_json_object） */
function loadJsonObject(raw: string): Record<string, any> | null {
    let text = raw.trim();
    // 去除 markdown fence
    if (text.startsWith('```')) {
        text = text.replace(/^`+/, '').replace(/`+$/, '').trim();
        if (text.toLowerCase().startsWith('json')) {
            text = text.slice(4).trim();
        }
    }
    // 找到第一个 { 和最后一个 }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    try {
        const data = JSON.parse(text.slice(start, end + 1));
        return typeof data === 'object' && data !== null ? data : null;
    } catch {
        return null;
    }
}

/** 解析 AI 研判结果（移植自 Python parse_ai_judgement） */
function parseAiJudgement(raw: string): AiJudgement | null {
    const data = loadJsonObject(raw);
    if (!data) return null;

    const impact = String(data.ai_impact || '').trim();
    const horizon = String(data.ai_horizon || '').trim();
    const summary = String(data.ai_summary || '').trim();
    if (!IMPACTS.has(impact) || !HORIZONS.has(horizon) || !summary) return null;

    let keywords = data.ai_keywords || [];
    if (!Array.isArray(keywords)) keywords = [];
    const cleanKeywords = keywords
        .map((k: any) => String(k).trim())
        .filter((k: string) => k)
        .slice(0, 8);

    return {
        ai_impact: impact,
        ai_horizon: horizon,
        ai_keywords: cleanKeywords,
        ai_summary: summary,
    };
}

export class StockInfoJudgeService {
    /** 调用 AI API（带重试） */
    private static async callAi(messages: Array<{ role: string; content: string }>): Promise<string> {
        const baseUrl = process.env.CRAWLER_AI_BASE_URL || 'https://as.yaozhineng.com/v1';
        const apiKey = process.env.CRAWLER_AI_API_KEY;
        const model = process.env.CRAWLER_AI_MODEL || 'qwen-plus';
        const timeoutMs = Number(process.env.CRAWLER_AI_TIMEOUT_MS || 60_000);
        const maxRetries = Number(process.env.CRAWLER_AI_MAX_RETRIES || 3);

        if (!apiKey) throw new Error('缺少 CRAWLER_AI_API_KEY 配置');

        const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
        const body = JSON.stringify({
            model,
            messages,
            temperature: 0.1,
            max_tokens: 1024,
            response_format: { type: 'json_object' },
            extra_body: { enable_thinking: false },
        });

        let lastError: Error | null = null;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await sessionFetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                    },
                    body,
                    signal: controller.signal,
                });
                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`AI API HTTP ${response.status}: ${errText.slice(0, 300)}`);
                }
                const data: any = await response.json();
                const content = data?.choices?.[0]?.message?.content || '';
                return content;
            } catch (err) {
                lastError = err as Error;
                if (attempt < maxRetries - 1) {
                    const wait = (attempt + 1) * 2;
                    console.warn(`[StockInfoJudge] 第${attempt + 1}次调用失败，${wait}秒后重试: ${(err as Error).message.slice(0, 80)}`);
                    await new Promise(r => setTimeout(r, wait * 1000));
                }
            } finally {
                clearTimeout(timeout);
            }
        }
        throw lastError || new Error('AI 调用失败');
    }

    /** 研判公告 */
    static async judgeAnnouncement(
        announcement: EastmoneyAnnouncement,
        pdf: PdfContent,
    ): Promise<AiJudgement | null> {
        const userText = buildAnnouncementPrompt(announcement, pdf);
        const content = await this.callAi([
            { role: 'system', content: SYSTEM_PROMPT_ANNOUNCEMENT },
            { role: 'user', content: userText },
        ]);
        return parseAiJudgement(content);
    }

    /** 研判新闻 */
    static async judgeNews(news: EastmoneyNews): Promise<AiJudgement | null> {
        const userText = buildNewsPrompt(news);
        const content = await this.callAi([
            { role: 'system', content: SYSTEM_PROMPT_NEWS },
            { role: 'user', content: userText },
        ]);
        return parseAiJudgement(content);
    }
}
