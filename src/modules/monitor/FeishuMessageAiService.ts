import { z } from 'zod';
import pool from '../../core/db';
import { sessionFetch } from '../../shared/utils/httpAgent';

const StockKeywordSchema = z.object({
    stock_code: z.string().regex(/^[036]\d{5}$/),
    keywords: z.array(z.string().min(1).max(40)).max(8),
}).strict();

const FeishuAiAnalysisSchema = z.object({
    stock_keywords: z.array(StockKeywordSchema).max(50),
}).strict();

export type FeishuAiAnalysis = z.infer<typeof FeishuAiAnalysisSchema>;

interface PendingFeishuMessage {
    id: number;
    message_id: string;
    text: string;
    ocr_text: string;
    stock_codes: string[];
    ai_attempts: number;
}

interface CandidateStock {
    stock_code: string;
    stock_name: string;
}

const SYSTEM_PROMPT = `你是A股机构资讯分析助手。请根据飞书正文、OCR文本和候选股票，
判断真正与资讯投资逻辑相关的股票，并为每只相关股票提炼简短关键词。

规则：
1. 只能返回候选股票列表中提供的股票代码，不得新增或猜测股票代码。
2. 证券公司、研究机构如果只是观点来源，不属于相关个股，不要返回。
3. 正文中只是顺带提及、没有业务或投资逻辑关联的股票，不要返回。
4. 每只股票返回1到6个中文短关键词，可包含涨价原因、机构看好原因、催化和风险，
5. 不得补充原文没有的信息。OCR存在错字时仅结合上下文理解，不要臆造事实。
6. 没有真正相关股票时返回空数组。
7. 只输出合法JSON，不要输出Markdown或解释。

输出格式：
{"stock_keywords":[{"stock_code":"000001","keywords":["关键词1","关键词2"]}]}`;

function modelUrl(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, '');
    return trimmed.endsWith('/chat/completions')
        ? trimmed
        : `${trimmed}/chat/completions`;
}

function stripJsonFence(content: string): string {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1].trim() : trimmed;
}

function truncateInput(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    const headLength = Math.floor(maxChars * 0.35);
    const tailLength = maxChars - headLength;
    return `${value.slice(0, headLength)}\n[中间内容因长度限制省略]\n${value.slice(-tailLength)}`;
}

export function parseQwenAnalysis(
    content: string,
    candidateCodes: readonly string[],
): FeishuAiAnalysis {
    const parsed = FeishuAiAnalysisSchema.parse(JSON.parse(stripJsonFence(content)));
    const allowedCodes = new Set(candidateCodes);
    const merged = new Map<string, string[]>();

    for (const item of parsed.stock_keywords) {
        if (!allowedCodes.has(item.stock_code)) {
            throw new Error(`千问返回了候选列表外的股票代码: ${item.stock_code}`);
        }
        const existing = merged.get(item.stock_code) || [];
        const keywords = [...existing, ...item.keywords]
            .map(keyword => keyword.trim())
            .filter(Boolean);
        merged.set(item.stock_code, [...new Set(keywords)].slice(0, 6));
    }

    return {
        stock_keywords: Array.from(merged.entries())
            .filter(([, keywords]) => keywords.length > 0)
            .map(([stock_code, keywords]) => ({ stock_code, keywords })),
    };
}

export function getAiKeywordsForStock(
    analysis: unknown,
    stockCode: string,
): string[] {
    try {
        const parsed = FeishuAiAnalysisSchema.parse(
            typeof analysis === 'string' ? JSON.parse(analysis) : analysis,
        );
        return parsed.stock_keywords
            .filter(item => item.stock_code === stockCode)
            .flatMap(item => item.keywords)
            .map(keyword => keyword.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

export function isRetryableQwenError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /abort|timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|HTTP (429|5\d\d)/i
        .test(message);
}

export function qwenRetryDelayMs(attempt: number): number {
    const baseDelay = Math.max(1_000, Number(process.env.QWEN_RETRY_BASE_MS || 60_000));
    return Math.min(baseDelay * (2 ** Math.max(0, attempt - 1)), 15 * 60_000);
}

export class FeishuMessageAiService {
    private static batchRunning = false;

    static isConfigured(): boolean {
        return Boolean(
            process.env.QWEN_BASE_URL?.trim()
            && process.env.QWEN_API_KEY?.trim()
            && process.env.QWEN_MODEL?.trim(),
        );
    }

    private static async loadCandidateStocks(
        stockCodes: string[],
    ): Promise<CandidateStock[]> {
        const result = await pool.query(
            'SELECT symbol, name FROM stocks WHERE symbol = ANY($1::text[])',
            [stockCodes],
        );
        const names = new Map<string, string>(
            result.rows.map((row: any) => [String(row.symbol), String(row.name || '')]),
        );
        return stockCodes.map(stock_code => ({
            stock_code,
            stock_name: names.get(stock_code) || stock_code,
        }));
    }

    static async analyzeMessage(input: {
        text: string;
        ocrText: string;
        candidateStocks: CandidateStock[];
    }): Promise<FeishuAiAnalysis> {
        const baseUrl = String(process.env.QWEN_BASE_URL || '').trim();
        const apiKey = String(process.env.QWEN_API_KEY || '').trim();
        const model = String(process.env.QWEN_MODEL || '').trim();
        if (!baseUrl || !apiKey || !model) {
            throw new Error('缺少QWEN_BASE_URL、QWEN_API_KEY或QWEN_MODEL配置');
        }

        const maxInputChars = Math.max(
            1000,
            Number(process.env.QWEN_MAX_INPUT_CHARS || 24000),
        );
        const timeoutMs = Math.max(
            1000,
            Number(process.env.QWEN_TIMEOUT_MS || 120000),
        );
        const userContent = truncateInput(
            JSON.stringify({
                text: input.text,
                ocr_text: input.ocrText,
                candidate_stocks: input.candidateStocks,
            }),
            maxInputChars,
        );
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await sessionFetch(modelUrl(baseUrl), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: userContent },
                    ],
                    temperature: 0.1,
                    max_tokens: 1000,
                    response_format: { type: 'json_object' },
                    extra_body: { enable_thinking: false },
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(
                    `千问接口HTTP ${response.status}: ${errorText.slice(0, 300)}`,
                );
            }
            const body: any = await response.json();
            const content = String(body?.choices?.[0]?.message?.content || '');
            if (!content) throw new Error('千问返回内容为空');
            return parseQwenAnalysis(
                content,
                input.candidateStocks.map(stock => stock.stock_code),
            );
        } finally {
            clearTimeout(timeout);
        }
    }

    private static async analyzeMessageWithOneRetry(input: {
        text: string;
        ocrText: string;
        candidateStocks: CandidateStock[];
    }): Promise<FeishuAiAnalysis> {
        try {
            return await this.analyzeMessage(input);
        } catch (firstError) {
            const reason = firstError instanceof Error ? firstError.message : String(firstError);
            console.warn(`[FeishuAI] 首次调用失败，立即重试一次: ${reason}`);
            return this.analyzeMessage(input);
        }
    }

    private static async claimPending(limit: number): Promise<PendingFeishuMessage[]> {
        const safeLimit = Math.min(Math.max(limit, 1), 20);
        await pool.query(
            `UPDATE feishu_messages
             SET ai_status = 'failed',
                 ai_error = '处理进程中断或超过15分钟',
                 ai_processed_at = NOW()
             WHERE ai_status = 'processing'
               AND ai_processed_at < NOW() - INTERVAL '15 minutes'`,
        );
        const result = await pool.query(
            `WITH pending AS (
                SELECT id
                FROM feishu_messages
                WHERE ai_status = 'pending'
                  AND (ai_next_retry_at IS NULL OR ai_next_retry_at <= NOW())
                ORDER BY received_at ASC
                LIMIT $1
                FOR UPDATE SKIP LOCKED
             )
             UPDATE feishu_messages AS message
             SET ai_status = 'processing',
                 ai_error = NULL,
                 ai_attempts = message.ai_attempts + 1,
                 ai_next_retry_at = NULL,
                 ai_processed_at = NOW()
             FROM pending
             WHERE message.id = pending.id
             RETURNING message.id, message.message_id, message.text,
                       message.ocr_text, message.stock_codes, message.ai_attempts`,
            [safeLimit],
        );
        return result.rows.map((row: any) => ({
            id: Number(row.id),
            message_id: String(row.message_id || ''),
            text: String(row.text || ''),
            ocr_text: String(row.ocr_text || ''),
            stock_codes: Array.isArray(row.stock_codes)
                ? row.stock_codes.map(String)
                : [],
            ai_attempts: Number(row.ai_attempts || 0),
        }));
    }

    static async processPending(limit: number = 3): Promise<{
        claimed: number;
        succeeded: number;
        failed: number;
    }> {
        if (!this.isConfigured() || this.batchRunning) {
            return { claimed: 0, succeeded: 0, failed: 0 };
        }

        this.batchRunning = true;
        try {
            const messages = await this.claimPending(limit);
            let succeeded = 0;
            let failed = 0;

            for (const message of messages) {
                try {
                    const analysisText = [message.text, message.ocr_text]
                        .filter(Boolean)
                        .join('\n')
                        .trim();
                    if (!analysisText || message.stock_codes.length === 0) {
                        await pool.query(
                            `UPDATE feishu_messages
                             SET ai_status = 'skipped', ai_analysis = NULL,
                                 ai_error = NULL, ai_processed_at = NOW()
                             WHERE id = $1`,
                            [message.id],
                        );
                        continue;
                    }
                    const candidateStocks = await this.loadCandidateStocks(
                        message.stock_codes,
                    );
                    const analysis = await this.analyzeMessage({
                        text: message.text,
                        ocrText: message.ocr_text,
                        candidateStocks,
                    });
                    await pool.query(
                        `UPDATE feishu_messages
                         SET ai_status = 'succeeded', ai_analysis = $2::jsonb,
                             ai_error = NULL, ai_processed_at = NOW()
                         WHERE id = $1`,
                        [message.id, JSON.stringify(analysis)],
                    );
                    succeeded++;
                } catch (error) {
                    const messageText = error instanceof Error
                        ? error.message
                        : String(error);
                    const maxAttempts = Math.min(
                        Math.max(1, Number(process.env.QWEN_MAX_ATTEMPTS || 4)),
                        10,
                    );
                    if (isRetryableQwenError(error) && message.ai_attempts < maxAttempts) {
                        const delayMs = qwenRetryDelayMs(message.ai_attempts);
                        const nextRetryAt = new Date(Date.now() + delayMs);
                        await pool.query(
                            `UPDATE feishu_messages
                             SET ai_status = 'pending',
                                 ai_analysis = NULL,
                                 ai_error = $2,
                                 ai_next_retry_at = $3,
                                 ai_processed_at = NOW()
                             WHERE id = $1`,
                            [message.id, messageText.slice(0, 1000), nextRetryAt],
                        );
                        console.warn(
                            `[FeishuAI] message_id=${message.message_id} retry in ` +
                            `${Math.ceil(delayMs / 1000)}s ` +
                            `(attempt ${message.ai_attempts}/${maxAttempts}): ${messageText}`,
                        );
                        continue;
                    }
                    await pool.query(
                        `UPDATE feishu_messages
                         SET ai_status = 'failed',
                             ai_analysis = NULL,
                             ai_error = $2,
                             ai_processed_at = NOW()
                         WHERE id = $1`,
                        [message.id, messageText.slice(0, 1000)],
                    );
                    failed++;
                    console.warn(
                        `[FeishuAI] message_id=${message.message_id}处理失败: ${messageText}`,
                    );
                }
            }

            return { claimed: messages.length, succeeded, failed };
        } finally {
            this.batchRunning = false;
        }
    }
}
