import { TencentQuoteService } from './TencentQuoteService';
import { ThsService } from '../monitor/ThsService';
import { ClsStockNewsService } from '../monitor/ClsStockNewsService';
import { formatToChinaTime } from '../../shared/utils/datetime';
import { setAiIndicatorScores } from '../monitor/TenxScoreService';
import { sessionFetch } from '../../shared/utils/httpAgent';
import pool from '../../core/db';

type AnalysisConclusion = '重大利好' | '利好' | '中性' | '利空' | '重大利空';

interface StockNewsDigest { title: string; time: string; summary: string; link: string; }

interface StockAnalysisResult { '结论': AnalysisConclusion; '核心逻辑': string; '风险提示': string; '十倍股指标打分'?: Record<string, number>; }

export interface StockAnalysisProgressEvent { stage: string; message: string; at: string; meta?: Record<string, unknown>; }
type StockAnalysisProgressHandler = (event: StockAnalysisProgressEvent) => void;
export interface StockAnalysisModelDeltaEvent { attempt: number; content: string; }
type StockAnalysisModelDeltaHandler = (event: StockAnalysisModelDeltaEvent) => void;

interface StockAnalysisRow { symbol: string; stock_name: string | null; analysis_time: string; conclusion: AnalysisConclusion; core_logic: string; risk_warning: string; }
interface StockAnalysisHistoryCountRow { total: number; }

export class StockAnalysisService {
    private static readonly NEWS_LIMIT = 5;
    private static readonly ALLOWED_CONCLUSIONS = new Set<AnalysisConclusion>(['重大利好', '利好', '中性', '利空', '重大利空']);

    private static readonly ANALYSIS_SYSTEM_PROMPT = `你是一名严谨的 A 股投研分析师与风险控制助手。

你必须严格遵守以下规则：
1. 只能输出一个 JSON 对象，不得输出任何解释、前后缀、Markdown 代码块。
2. JSON 允许四个字段：结论、核心逻辑、风险提示、十倍股指标打分；不得新增或删除字段。
3. 不得编造事实、数据、新闻标题或新闻链接；仅可使用输入中提供的信息。
4. 结论必须与证据链一致，若证据不足必须体现审慎倾向。
5. 语言应专业、清晰、克制，避免口号式和空泛表达。
6. 若采用分点分析，必须使用 \\n 在分点之间换行。`;

    private static readonly ANALYSIS_PROMPT_TEMPLATE = `请基于给定信息，评估该个股在 {today} 之后 1-4 周维度的综合影响（情绪、估值与盈利预期）。

【分析目标】
综合新闻、业绩预测和最近交易数据，给出可执行的方向判断。

【结论分类】
只能选择以下五种之一：
- 重大利好
- 利好
- 中性
- 利空
- 重大利空

【判断原则】
1. 优先判断新闻事件的直接冲击（政策、监管、订单、业绩预告、行业供需等）。
2. 用盈利预测验证事件是否具备基本面支撑（预期上修/下修、兑现能力）。
3. 用交易数据判断市场是否已计价及情绪强弱。
4. 若新闻互相冲突，必须说明主次、时效性与权重依据。
5. 若证据不足或已充分计价，应偏向"中性"。

【重大影响标准】
- 重大利好 / 重大利空：可能显著影响未来业绩或估值（>10%利润影响或行业格局改变）。
- 利好 / 利空：短期情绪或边际改善。
- 中性：无明显影响或市场已充分消化。

【分析框架（核心逻辑必须按此顺序组织）】
1. 新闻驱动：指出最关键的 1-2 条信息及方向性影响。
2. 基本面验证：说明盈利预测是否支持上述判断。
3. 交易面验证：判断资金与价格行为是否已反映预期。
4. 综合结论：给出最终方向判断及主要因果链。

【引用规则】
- 若在核心逻辑中引用具体新闻，必须使用 Markdown 超链接格式，并使用\`\`将新闻标题包裹：
  [\`新闻标题\`](新闻链接)
- 仅引用真正用于分析判断的新闻。
- 不允许重复引用。
- 不得虚构新闻链接。

【写作要求】
- 核心逻辑和风险提示均采用"标签::解释"格式，每行一条，行内以英文双冒号"::"分隔。
- 双冒号之前为关键词标签（不超过30字，可为长标签，如"情绪偏强"、"涨停连板"、"政策利好持续兑现"），双冒号之后为该标签的详细解释（50-150字）。
- 核心逻辑必须给出 3-5 条标签，风险提示必须给出 2-3 条标签。
- 每条标签应提炼最关键的核心观点，避免空泛表述，尽量包含明确判断词（如"抬升/压制/改善/恶化/已计价"）。
- 标签之间使用 \\n 换行分隔，不得使用 Markdown 列表符号。
- 若在解释中引用具体新闻，必须使用 Markdown 超链接格式：[\`新闻标题\`](新闻链接)

【标签格式示例】
核心逻辑示例：
政策利好持续兑现::国务院发布新一轮产业政策，明确补贴方向，公司作为细分龙头有望优先受益，订单预期上修。
资金承接偏强::最近交易日主力资金连续净流入，成交放大但股价未脱离基本面，说明资金在主动配置而非短期炒作。
盈利预期上修::盈利预测显示未来两年净利润增速从15%上调至25%，业绩兑现支撑估值抬升。

风险提示示例：
估值已部分计价::当前PE已高于近三年中位数，若后续业绩不及预期，存在估值回撤风险。
行业竞争加剧::新进入者增加可能导致份额稀释，需关注季度毛利率变化。

【输入数据】

相关最新新闻内容：
{news_text}

最新业绩预测数据：
{forecast_data}

最近一个交易日的数据：
{trading_data}

【输出要求】
必须严格以 JSON 格式输出，不得输出任何额外解释文字。
不得添加未定义字段。
所有字段必须填写，不得为空。

JSON 结构如下：
{
  "结论": "",
  "核心逻辑": "",
  "风险提示": "",
  "十倍股指标打分": {}
}

【十倍股指标打分说明】
请根据新闻内容，对以下指标进行0-100分的打分评估。如果新闻中无相关信息，则不包含该指标。
打分依据：新闻内容是否支持该指标向好（高分）或向坏（低分）。

可选指标及打分标准：
- "policy_trend_score": 政策/产业趋势强度（0=压制, 40=平淡, 60=一般, 80=有政策支持, 100=国家战略级）
- "hard_catalyst": 硬催化强度（20=利空, 40=无催化, 60=催化偏弱, 100=明确未兑现硬催化）
- "market_share_trend": 市占率趋势（20=同质化, 40=跟随者, 60=龙二且提升, 80=龙一稳步提升, 100=龙一且快速提升）
- "industry_position": 行业地位不可替代性（20=同质化, 40=跟随者, 80=细分龙头, 100=绝对龙头+卡脖子）
- "industry_penetration": 行业渗透率位置（数值为渗透率百分比估算，如8表示8%渗透率，越低分越高）
- "profit_forecast_cagr": 未来预期净利润增速（数值为百分比，如80表示80%增速）

示例输出：
{
  "结论": "利好",
  "核心逻辑": "政策利好持续兑现::国务院发布新一轮产业政策，明确补贴方向，公司作为细分龙头有望优先受益。\n盈利预期上修::盈利预测显示未来两年净利润增速从15%上调至25%，业绩兑现支撑估值抬升。\n资金承接偏强::最近交易日主力资金连续净流入，成交放大但股价未脱离基本面。",
  "风险提示": "估值已部分计价::当前PE已高于近三年中位数，若后续业绩不及预期，存在估值回撤风险。\n行业竞争加剧::新进入者增加可能导致份额稀释，需关注季度毛利率变化。",
  "十倍股指标打分": {
    "policy_trend_score": 80,
    "hard_catalyst": 100
  }
}

注意："十倍股指标打分"字段中只需包含有新闻依据的指标，无依据的指标不要包含。`;

    private static emitProgress(onProgress: StockAnalysisProgressHandler | undefined, stage: string, message: string, meta?: Record<string, unknown>): void {
        if (!onProgress) return;
        try { onProgress({ stage, message, at: formatToChinaTime(Date.now()), ...(meta ? { meta } : {}) }); } catch {}
    }

    private static getErrorMessage(reason: unknown, fallback: string): string {
        if (reason instanceof Error && reason.message) return reason.message;
        return fallback;
    }

    private static normalizeText(value: unknown): string {
        if (typeof value !== 'string') return '';
        return value.trim().replace(/\s+/g, ' ');
    }

    private static normalizeMultilineText(value: unknown): string {
        if (typeof value !== 'string') return '';
        return value.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim().replace(/[ \t\u00A0]+/g, ' ')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    private static clipText(text: string, max: number): string {
        if (!text) return '';
        const chars = Array.from(text);
        if (chars.length <= max) return text;
        return chars.slice(0, max).join('') + '...';
    }

    private static getTodayInChina(): string { return formatToChinaTime(Date.now()).slice(0, 10); }

    private static formatToChinaTimeWithMs(timestamp: number): string {
        const date = new Date(timestamp);
        const utc8Time = date.getTime() + (date.getTimezoneOffset() * 60000) + (8 * 3600000);
        const d = new Date(utc8Time);
        const pad2 = (n: number) => n.toString().padStart(2, '0');
        const pad3 = (n: number) => n.toString().padStart(3, '0');
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
    }

    private static sanitizeModelJsonText(raw: string): string {
        const trimmed = raw.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('```')) { const codeBlock = trimmed.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, ''); return codeBlock.trim(); }
        const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
        if (start >= 0 && end > start) return trimmed.slice(start, end + 1).trim();
        return trimmed;
    }

    private static parseModelResult(raw: string): StockAnalysisResult | null {
        try {
            const jsonText = this.sanitizeModelJsonText(raw);
            const parsed = JSON.parse(jsonText);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            const keys = Object.keys(parsed);
            const required = ['结论', '核心逻辑', '风险提示'];
            if (!required.every(key => keys.includes(key))) return null;
            // 允许3或4个字段（兼容旧版3字段和新版4字段）
            if (keys.length < 3 || keys.length > 4) return null;
            const conclusion = this.normalizeText((parsed as any)['结论']) as AnalysisConclusion;
            const coreLogic = this.normalizeMultilineText((parsed as any)['核心逻辑']);
            const riskWarning = this.normalizeMultilineText((parsed as any)['风险提示']);
            if (!this.ALLOWED_CONCLUSIONS.has(conclusion)) return null;
            if (!coreLogic || !riskWarning) return null;

            // 解析十倍股指标打分（可选字段）
            let tenxIndicatorScores: Record<string, number> | undefined = undefined;
            const rawScores = (parsed as any)['十倍股指标打分'];
            if (rawScores && typeof rawScores === 'object' && !Array.isArray(rawScores)) {
                const validKeys = new Set(['policy_trend_score', 'hard_catalyst', 'market_share_trend', 'industry_position', 'industry_penetration', 'profit_forecast_cagr']);
                const filtered: Record<string, number> = {};
                for (const [k, v] of Object.entries(rawScores)) {
                    if (validKeys.has(k) && typeof v === 'number') {
                        filtered[k] = Math.min(100, Math.max(0, v));
                    }
                }
                if (Object.keys(filtered).length > 0) {
                    tenxIndicatorScores = filtered;
                }
            }

            return { '结论': conclusion, '核心逻辑': coreLogic, '风险提示': riskWarning, '十倍股指标打分': tenxIndicatorScores };
        } catch { return null; }
    }

    private static validateModelResult(data: StockAnalysisResult): string | null {
        const linkRegex = /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g;
        const links: string[] = [];
        let match: RegExpExecArray | null = null;
        while ((match = linkRegex.exec(data['核心逻辑'])) !== null) links.push(match[1]);
        const uniqueLinks = new Set(links);
        if (links.length !== uniqueLinks.size) return '核心逻辑中的新闻链接存在重复引用';
        return null;
    }

    private static async fetchStockNewsDigest(symbol: string): Promise<StockNewsDigest[]> {
        const newsResult = await ClsStockNewsService.getStockNews(symbol, { limit: this.NEWS_LIMIT, lastTime: 0 });
        const digestList: StockNewsDigest[] = [], seen = new Set<string>();
        for (const item of newsResult.items) {
            const title = this.normalizeText(item.title), summary = this.clipText(this.normalizeText(item.content), 120);
            const time = this.normalizeText(item.time), link = this.normalizeText(item.link);
            if (!title || !time || !summary || !link) continue;
            const dedupeKey = `${title}@@${link}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            digestList.push({ title, time, summary, link });
        }
        return digestList;
    }

    private static buildNewsText(newsList: StockNewsDigest[]): string {
        if (newsList.length === 0) return '暂无相关新闻';
        return newsList.map((item, index) => `${index + 1}. 标题: ${item.title}\n时间: ${item.time}\n摘要: ${item.summary}\n链接: ${item.link}`).join('\n\n');
    }

    private static buildPrompt(newsText: string, forecastData: string, tradingData: string, today: string): string {
        return this.ANALYSIS_PROMPT_TEMPLATE.replace('{today}', today).replace('{news_text}', newsText).replace('{forecast_data}', forecastData).replace('{trading_data}', tradingData);
    }

    private static extractTextFromModelField(value: unknown): string {
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) return value.map((item: any) => { if (typeof item === 'string') return item; if (item && typeof item === 'object' && typeof item.text === 'string') return item.text; return ''; }).join('');
        return '';
    }

    private static extractModelFinalContent(data: any): string {
        if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
        if (Array.isArray(data?.output)) {
            const responseText = data.output.map((item: any) => { const content = Array.isArray(item?.content) ? item.content : []; return content.map((part: any) => { if (typeof part?.text === 'string') return part.text; if (typeof part?.output_text === 'string') return part.output_text; return ''; }).join(''); }).join('');
            if (responseText) return responseText;
        }
        const choice = data?.choices?.[0];
        if (!choice) return '';
        const messageContent = this.extractTextFromModelField(choice?.message?.content);
        if (messageContent) return messageContent;
        const textContent = this.extractTextFromModelField(choice?.text);
        if (textContent) return textContent;
        return '';
    }

    private static extractModelStreamDelta(data: any): string {
        if (data?.type === 'response.output_text.delta') { const delta = this.extractTextFromModelField(data?.delta); if (delta) return delta; }
        if (typeof data?.delta === 'string') return data.delta;
        if (typeof data?.output_text === 'string') return data.output_text;
        const choice = data?.choices?.[0];
        if (!choice) return '';
        const deltaContent = this.extractTextFromModelField(choice?.delta?.content);
        if (deltaContent) return deltaContent;
        const messageContent = this.extractTextFromModelField(choice?.message?.content);
        if (messageContent) return messageContent;
        const textContent = this.extractTextFromModelField(choice?.text);
        if (textContent) return textContent;
        return '';
    }

    private static buildModelRequestBody(prompt: string, stream: boolean): Record<string, unknown> {
        return {
            model: process.env.EVA_MODEL,
            temperature: 0.2,
            ...(stream ? { stream: true } : {}),
            messages: [{ role: 'system', content: this.ANALYSIS_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
        };
    }

    private static async requestModel(prompt: string): Promise<string> {
        const apiBaseUrl = process.env.OPENAI_API_BASE_URL;
        const apiKey = process.env.OPENAI_API_KEY;
        const evaModel = process.env.EVA_MODEL;
        if (!apiBaseUrl) throw new Error('缺少 OPENAI_API_BASE_URL 配置');
        if (!apiKey) throw new Error('缺少 OPENAI_API_KEY 配置');
        if (!evaModel) throw new Error('缺少 EVA_MODEL 配置');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45_000);
        try {
            const response = await sessionFetch(apiBaseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify(this.buildModelRequestBody(prompt, false)),
                signal: controller.signal,
            });
            if (!response.ok) { const errText = await response.text(); throw new Error(`大模型接口请求失败: ${response.status} ${errText.slice(0, 300)}`); }
            const data: any = await response.json();
            const content = this.extractModelFinalContent(data).trim();
            if (!content) throw new Error('大模型返回内容为空');
            return content;
        } finally { clearTimeout(timeout); }
    }

    private static async requestModelStream(prompt: string, attempt: number, onModelDelta: StockAnalysisModelDeltaHandler): Promise<string> {
        const apiBaseUrl = process.env.OPENAI_API_BASE_URL;
        const apiKey = process.env.OPENAI_API_KEY;
        const evaModel = process.env.EVA_MODEL;
        if (!apiBaseUrl) throw new Error('缺少 OPENAI_API_BASE_URL 配置');
        if (!apiKey) throw new Error('缺少 OPENAI_API_KEY 配置');
        if (!evaModel) throw new Error('缺少 EVA_MODEL 配置');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45_000);
        try {
            const response = await sessionFetch(apiBaseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify(this.buildModelRequestBody(prompt, true)),
                signal: controller.signal,
            });
            if (!response.ok) { const errText = await response.text(); throw new Error(`大模型接口请求失败: ${response.status} ${errText.slice(0, 300)}`); }

            const contentType = (response.headers.get('content-type') || '').toLowerCase();
            if (contentType.includes('application/json')) {
                const data: any = await response.json();
                const content = this.extractModelFinalContent(data).trim();
                if (!content) throw new Error('大模型流式返回内容为空');
                try { onModelDelta({ attempt, content }); } catch {}
                return content;
            }

            if (!response.body) throw new Error('大模型流式响应体为空');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '', fullContent = '', doneReceived = false;
            let currentEventDataLines: string[] = [];

            const emitDelta = (delta: string) => {
                if (!delta) return;
                fullContent += delta;
                try { onModelDelta({ attempt, content: delta }); } catch {}
            };

            const consumePayload = (payload: string) => {
                if (!payload) return;
                if (payload === '[DONE]') { doneReceived = true; return; }
                try { const parsed = JSON.parse(payload); const delta = this.extractModelStreamDelta(parsed); if (delta) emitDelta(delta); }
                catch { const trimmed = payload.trim(); if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[')) emitDelta(trimmed); }
            };

            const flushEventData = () => {
                if (currentEventDataLines.length === 0) return;
                const payload = currentEventDataLines.join('\n').trim();
                currentEventDataLines = [];
                if (!payload) return;
                consumePayload(payload);
            };

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let newlineIndex = buffer.indexOf('\n');
                while (newlineIndex >= 0) {
                    const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
                    buffer = buffer.slice(newlineIndex + 1);
                    if (rawLine === '') flushEventData();
                    else if (rawLine.startsWith(':')) {}
                    else if (rawLine.startsWith('data:')) currentEventDataLines.push(rawLine.slice(5).trimStart());
                    else if (rawLine.startsWith('event:') || rawLine.startsWith('id:') || rawLine.startsWith('retry:')) {}
                    else currentEventDataLines.push(rawLine.trim());
                    if (doneReceived) break;
                    newlineIndex = buffer.indexOf('\n');
                }
                if (doneReceived) break;
            }
            flushEventData();
            const tail = buffer.trim();
            if (!doneReceived && tail) { if (tail.startsWith('data:')) consumePayload(tail.slice(5).trim()); else consumePayload(tail); }

            const finalContent = fullContent.trim();
            if (!finalContent) throw new Error('大模型流式返回内容为空');
            return finalContent;
        } finally { clearTimeout(timeout); }
    }

    private static async generateStockAnalysis(
        newsText: string, forecastData: string, tradingData: string,
        onProgress?: StockAnalysisProgressHandler, onModelDelta?: StockAnalysisModelDeltaHandler,
    ): Promise<StockAnalysisResult> {
        let lastError = '模型返回格式异常';
        const today = this.getTodayInChina();
        for (let attempt = 1; attempt <= 2; attempt++) {
            this.emitProgress(onProgress, 'model.requesting', `调用模型生成评价（第 ${attempt} 次）`, { attempt });
            const correction = attempt === 1 ? '' : `\n\n【上次输出问题】\n${lastError}\n请严格修正并仅输出 JSON。`;
            const prompt = this.buildPrompt(newsText, forecastData, tradingData, today) + correction;
            let raw: string;
            if (onModelDelta) {
                try { raw = await this.requestModelStream(prompt, attempt, onModelDelta); }
                catch (streamError: unknown) {
                    const reason = this.getErrorMessage(streamError, '模型流式请求失败');
                    this.emitProgress(onProgress, 'model.stream_fallback', '模型流式转发失败，已自动降级为非流式请求', { attempt, reason });
                    raw = await this.requestModel(prompt);
                    try { onModelDelta({ attempt, content: raw }); } catch {}
                }
            } else { raw = await this.requestModel(prompt); }
            this.emitProgress(onProgress, 'model.responded', `模型返回完成（第 ${attempt} 次）`, { attempt, contentLength: raw.length });
            const parsed = this.parseModelResult(raw);
            if (!parsed) {
                lastError = 'JSON 结构不符合要求';
                if (attempt < 2) this.emitProgress(onProgress, 'model.retrying', `模型输出解析失败，将重试（第 ${attempt + 1} 次）`, { attempt, reason: lastError });
                else this.emitProgress(onProgress, 'model.failed', '模型输出解析失败，无法生成有效结果', { attempt, reason: lastError });
                continue;
            }
            const validationError = this.validateModelResult(parsed);
            if (!validationError) return parsed;
            lastError = validationError;
            if (attempt < 2) this.emitProgress(onProgress, 'model.retrying', `模型输出校验失败，将重试（第 ${attempt + 1} 次）`, { attempt, reason: lastError });
            else this.emitProgress(onProgress, 'model.failed', '模型输出校验失败，无法生成有效结果', { attempt, reason: lastError });
        }
        throw new Error(`大模型输出不符合约束: ${lastError}`);
    }

    private static async getStockName(symbol: string): Promise<string> {
        const result = await pool.query('SELECT name FROM stocks WHERE symbol = $1 LIMIT 1', [symbol]);
        const row = result.rows[0] as { name: string } | undefined;
        return this.normalizeText(row?.name || '');
    }

    private static mapAnalysisRow(row: StockAnalysisRow): Record<string, any> {
        return { '股票代码': row.symbol, '股票简称': row.stock_name || '', '分析时间': row.analysis_time, '结论': row.conclusion, '核心逻辑': row.core_logic, '风险提示': row.risk_warning };
    }

    static async createStockAnalysis(
        symbol: string,
        onProgress?: StockAnalysisProgressHandler,
        onModelDelta?: StockAnalysisModelDeltaHandler,
    ): Promise<Record<string, any>> {
        this.emitProgress(onProgress, 'start', '开始生成个股评价', { symbol });
        const stockName = await this.getStockName(symbol);
        if (!stockName) { this.emitProgress(onProgress, 'stock.not_found', '股票代码不存在', { symbol }); throw new Error(`股票代码不存在: ${symbol}`); }
        this.emitProgress(onProgress, 'stock.validated', '股票代码校验通过', { symbol, stockName });
        this.emitProgress(onProgress, 'inputs.fetching', '开始抓取输入数据（新闻/盈利预测/交易）');

        const [newsResult, forecastResult, tradingResult] = await Promise.allSettled([
            this.fetchStockNewsDigest(symbol),
            ThsService.getProfitForecast(symbol),
            TencentQuoteService.getQuote(symbol, 'activity'),
        ]);

        const newsList = newsResult.status === 'fulfilled' ? newsResult.value : [];
        const forecastSummary = forecastResult.status === 'fulfilled' ? this.normalizeText(forecastResult.value?.['摘要'] || '') : '';
        const tradingData = tradingResult.status === 'fulfilled' ? tradingResult.value : { '错误': this.getErrorMessage(tradingResult.reason, '交易数据获取失败') };

        if (newsResult.status === 'fulfilled') this.emitProgress(onProgress, 'inputs.news.ready', '个股新闻抓取完成', { count: newsList.length });
        else this.emitProgress(onProgress, 'inputs.news.failed', '个股新闻抓取失败，已降级继续分析', { reason: this.getErrorMessage(newsResult.reason, '新闻抓取失败') });
        if (forecastResult.status === 'fulfilled') this.emitProgress(onProgress, 'inputs.forecast.ready', '盈利预测抓取完成', { hasSummary: Boolean(forecastSummary) });
        else this.emitProgress(onProgress, 'inputs.forecast.failed', '盈利预测抓取失败，已降级继续分析', { reason: this.getErrorMessage(forecastResult.reason, '盈利预测抓取失败') });
        if (tradingResult.status === 'fulfilled') this.emitProgress(onProgress, 'inputs.trading.ready', '交易数据抓取完成');
        else this.emitProgress(onProgress, 'inputs.trading.failed', '交易数据抓取失败，已降级继续分析', { reason: this.getErrorMessage(tradingResult.reason, '交易数据获取失败') });

        const newsText = this.buildNewsText(newsList);
        const forecastData = forecastSummary || '暂无业绩预测摘要';
        const tradingText = JSON.stringify(tradingData, null, 2);
        this.emitProgress(onProgress, 'analysis.prepared', '分析输入数据准备完成', { newsCount: newsList.length, hasForecastSummary: Boolean(forecastSummary) });

        const modelResult = await this.generateStockAnalysis(newsText, forecastData, tradingText, onProgress, onModelDelta);
        const analysisTime = this.formatToChinaTimeWithMs(Date.now());
        this.emitProgress(onProgress, 'db.writing', '开始写入数据库');

        await pool.query(
            `INSERT INTO stock_analysis (symbol, analysis_time, conclusion, core_logic, risk_warning, ai_indicator_scores) VALUES ($1, $2, $3, $4, $5, $6)`,
            [symbol, analysisTime, modelResult['结论'], modelResult['核心逻辑'], modelResult['风险提示'], modelResult['十倍股指标打分'] ? JSON.stringify(modelResult['十倍股指标打分']) : null],
        );

        this.emitProgress(onProgress, 'completed', '个股评价生成完成', { symbol, analysisTime, conclusion: modelResult['结论'] });

        // 将AI指标打分注入到十倍股评分系统
        if (modelResult['十倍股指标打分']) {
            try {
                setAiIndicatorScores(symbol, modelResult['十倍股指标打分']);
                console.log(`[StockAnalysis] ${symbol} AI指标打分已注入:`, JSON.stringify(modelResult['十倍股指标打分']));
            } catch (e) {
                console.warn(`[StockAnalysis] ${symbol} AI指标打分注入失败:`, e);
            }
        }

        return {
            '来源': 'AI 股票评价', '模型': process.env.EVA_MODEL,
            '股票代码': symbol, '股票简称': stockName, '分析时间': analysisTime,
            '结论': modelResult['结论'], '核心逻辑': modelResult['核心逻辑'], '风险提示': modelResult['风险提示'],
            '十倍股指标打分': modelResult['十倍股指标打分'] || null,
            '输入摘要': { '新闻数量': newsList.length, '业绩预测摘要': forecastData, '交易数据': tradingData },
        };
    }

    static async getLatestStockAnalysis(symbol: string): Promise<Record<string, any> | null> {
        const result = await pool.query(
            `SELECT a.symbol, s.name AS stock_name, a.analysis_time, a.conclusion, a.core_logic, a.risk_warning
             FROM stock_analysis a LEFT JOIN stocks s ON s.symbol = a.symbol
             WHERE a.symbol = $1 ORDER BY a.analysis_time DESC LIMIT 1`,
            [symbol],
        );
        const row = result.rows[0] as StockAnalysisRow | undefined;
        if (!row) return null;
        return { '来源': '历史分析', ...this.mapAnalysisRow(row) };
    }

    static async getStockAnalysisHistory(symbol: string, page: number, pageSize: number): Promise<Record<string, any>> {
        const offset = (page - 1) * pageSize;
        const stockName = await this.getStockName(symbol);

        const countResult = await pool.query('SELECT COUNT(*) AS total FROM stock_analysis WHERE symbol = $1', [symbol]);
        const total = (countResult.rows[0] as StockAnalysisHistoryCountRow)?.total || 0;

        const rowsResult = await pool.query(
            `SELECT a.symbol, s.name AS stock_name, a.analysis_time, a.conclusion, a.core_logic, a.risk_warning
             FROM stock_analysis a LEFT JOIN stocks s ON s.symbol = a.symbol
             WHERE a.symbol = $1 ORDER BY a.analysis_time DESC LIMIT $2 OFFSET $3`,
            [symbol, pageSize, offset],
        );
        const rows = rowsResult.rows as StockAnalysisRow[];

        return {
            '来源': '历史分析', '股票代码': symbol, '股票简称': stockName || rows[0]?.stock_name || '',
            '当前页': page, '每页数量': pageSize, '总数量': total, '总页数': Math.ceil(total / pageSize),
            '历史评价': rows.map(row => this.mapAnalysisRow(row)),
        };
    }
}
