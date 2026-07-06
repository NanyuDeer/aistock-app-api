import { AGENT_TOOL_DEFINITIONS, executeToolCall } from './analysis-agent/tools';
import { AGENT_SYSTEM_PROMPT, buildAgentUserPrompt } from './analysis-agent/prompts';
import type {
  AgentConfig,
  AgentContext,
  AgentToolCall,
  AgentProgressEvent,
  AgentAnalysisResult,
} from './analysis-agent/types';
import { formatToChinaTime } from '../../shared/utils/datetime';
import pool from '../../core/db';
import { setAiIndicatorScores } from '../monitor/TenxScoreService';
import { sessionFetch } from '../../shared/utils/httpAgent';

const DEFAULT_CONFIG: AgentConfig = {
  maxRounds: 5,
  model: '',
  temperature: 0.2,
};

type ProgressHandler = (event: AgentProgressEvent) => void;

export class StockAnalysisAgentService {

  private static emitProgress(handler: ProgressHandler | undefined, event: AgentProgressEvent): void {
    if (!handler) return;
    try { handler(event); } catch {}
  }

  private static buildModelUrl(): string {
    const url = process.env.OPENAI_API_BASE_URL;
    if (!url) throw new Error('缺少 OPENAI_API_BASE_URL 配置');
    return url;
  }

  private static buildAuthHeaders(): Record<string, string> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('缺少 OPENAI_API_KEY 配置');
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` };
  }

  private static getModel(): string {
    const model = process.env.EVA_MODEL;
    if (!model) throw new Error('缺少 EVA_MODEL 配置');
    return model;
  }

  /** 解析 LLM 最终输出的 JSON 结论 */
  private static parseFinalResult(raw: string): AgentAnalysisResult | null {
    const trimmed = raw.trim();
    let text = trimmed;
    if (text.startsWith('```')) {
      text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (!parsed || typeof parsed !== 'object') return null;
      const conclusion = String(parsed['结论'] || '').trim();
      const coreLogic = String(parsed['核心逻辑'] || '').trim();
      const riskWarning = String(parsed['风险提示'] || '').trim();
      const validConclusions = new Set(['重大利好', '利好', '中性', '利空', '重大利空']);
      if (!validConclusions.has(conclusion) || !coreLogic || !riskWarning) return null;

      let tenxScores: Record<string, number> | undefined;
      const rawScores = parsed['十倍股指标打分'];
      if (rawScores && typeof rawScores === 'object' && !Array.isArray(rawScores)) {
        const validKeys = new Set(['policy_trend_score', 'hard_catalyst', 'market_share_trend', 'industry_position', 'industry_penetration', 'profit_forecast_cagr']);
        const filtered: Record<string, number> = {};
        for (const [k, v] of Object.entries(rawScores)) {
          if (validKeys.has(k) && typeof v === 'number') filtered[k] = Math.min(100, Math.max(0, v));
        }
        if (Object.keys(filtered).length > 0) tenxScores = filtered;
      }

      return { '结论': conclusion, '核心逻辑': coreLogic, '风险提示': riskWarning, '十倍股指标打分': tenxScores };
    } catch { return null; }
  }

  /** 单轮 LLM 调用 */
  private static async callModel(
    context: AgentContext,
  ): Promise<{ tool_calls?: AgentToolCall[]; text_content?: string }> {
    const headers = this.buildAuthHeaders();
    const model = this.getModel() || context.config.model;

    const body = {
      model,
      temperature: context.config.temperature,
      messages: context.messages,
      tools: AGENT_TOOL_DEFINITIONS,
      tool_choice: 'auto',
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await sessionFetch(this.buildModelUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`模型请求失败: ${response.status} ${errText.slice(0, 300)}`);
      }

      const data: any = await response.json();
      const choice = data?.choices?.[0];
      if (!choice) throw new Error('模型返回格式异常');

      const message = choice.message;

      // 提取 tool_calls
      const toolCalls: AgentToolCall[] = [];
      if (Array.isArray(message?.tool_calls)) {
        for (const tc of message.tool_calls) {
          if (tc.function?.name) {
            let args: Record<string, any> = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
            toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
          }
        }
      }

      // 提取文本内容
      let textContent: string | undefined;
      if (typeof message?.content === 'string' && message.content.trim()) {
        textContent = message.content.trim();
      }

      return { tool_calls: toolCalls.length > 0 ? toolCalls : undefined, text_content: textContent };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Agent 主循环 */
  static async runAgent(
    symbol: string,
    stockName: string,
    onProgress?: ProgressHandler,
  ): Promise<AgentAnalysisResult> {
    const maxRounds = Number(process.env.AGENT_MAX_ROUNDS) || DEFAULT_CONFIG.maxRounds;
    const config: AgentConfig = { ...DEFAULT_CONFIG, model: this.getModel(), maxRounds };
    const today = formatToChinaTime(Date.now()).slice(0, 10);

    const context: AgentContext = {
      symbol,
      stockName,
      messages: [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        { role: 'user', content: buildAgentUserPrompt(symbol, stockName, today) },
      ],
      round: 0,
      newsCache: new Map(),
      config,
    };

    let finalResult: AgentAnalysisResult | null = null;

    while (context.round < config.maxRounds) {
      context.round++;
      this.emitProgress(onProgress, {
        type: 'agent.thinking',
        round: context.round,
        data: { message: `Agent 第 ${context.round} 轮思考中...` },
      });

      const response = await this.callModel(context);

      // 将 assistant 消息加入上下文
      const assistantMessage: any = { role: 'assistant', content: response.text_content || '' };
      if (response.tool_calls && response.tool_calls.length > 0) {
        assistantMessage.tool_calls = response.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      context.messages.push(assistantMessage);

      // 如果没有工具调用，检查是否有最终结论
      if (!response.tool_calls || response.tool_calls.length === 0) {
        if (response.text_content) {
          finalResult = this.parseFinalResult(response.text_content);
          if (finalResult) {
            this.emitProgress(onProgress, {
              type: 'agent.final',
              round: context.round,
              data: { message: 'Agent 已得出最终结论', conclusion: finalResult['结论'] },
            });
            break;
          }
        }

        // 最后一轮仍无法解析，强制要求输出
        if (context.round >= config.maxRounds) {
          context.messages.push({
            role: 'user',
            content: '你已达到最大检索轮次。请立即输出最终研判结论的JSON，不要再调用任何工具。',
          });
          continue;
        }

        // 非最后一轮但无法解析，提示继续
        context.messages.push({
          role: 'user',
          content: '请继续检索信息或直接输出最终研判结论JSON。',
        });
        continue;
      }

      // 执行工具调用
      for (const call of response.tool_calls) {
        this.emitProgress(onProgress, {
          type: 'agent.tool_call',
          round: context.round,
          data: { tool: call.name, arguments: call.arguments },
        });

        const result = await executeToolCall(call, context);

        this.emitProgress(onProgress, {
          type: 'agent.tool_result',
          round: context.round,
          data: { tool: call.name, result_preview: result.content.slice(0, 200) },
        });

        // 将工具结果加入上下文
        context.messages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: result.tool_call_id,
        } as any);
      }
    }

    // 如果循环结束仍未得到有效结果，做最后一次强制调用
    if (!finalResult) {
      this.emitProgress(onProgress, {
        type: 'agent.thinking',
        round: context.round,
        data: { message: '强制生成最终结论...' },
      });

      context.messages.push({
        role: 'user',
        content: '请立即基于已有信息输出最终研判结论JSON。如果信息不足，结论应为"中性"。',
      });

      const finalResponse = await this.callModel(context);
      if (finalResponse.text_content) {
        finalResult = this.parseFinalResult(finalResponse.text_content);
      }
    }

    if (!finalResult) {
      throw new Error('Agent 未能生成有效的研判结论');
    }

    return finalResult;
  }

  /** 完整的个股分析流程（含DB写入） */
  static async createStockAnalysis(
    symbol: string,
    onProgress?: ProgressHandler,
  ): Promise<Record<string, any>> {
    // 获取股票名称
    const result = await pool.query('SELECT name FROM stocks WHERE symbol = $1 LIMIT 1', [symbol]);
    const row = result.rows[0] as { name: string } | undefined;
    const stockName = (row?.name || '').trim();
    if (!stockName) throw new Error(`股票代码不存在: ${symbol}`);

    // 运行 Agent
    const agentResult = await this.runAgent(symbol, stockName, onProgress);

    // 写入数据库
    const analysisTime = formatToChinaTime(Date.now()) + '.' + String(Date.now() % 1000).padStart(3, '0');
    await pool.query(
      `INSERT INTO stock_analysis (symbol, analysis_time, conclusion, core_logic, risk_warning, ai_indicator_scores) VALUES ($1, $2, $3, $4, $5, $6)`,
      [symbol, analysisTime, agentResult['结论'], agentResult['核心逻辑'], agentResult['风险提示'], agentResult['十倍股指标打分'] ? JSON.stringify(agentResult['十倍股指标打分']) : null],
    );

    // 注入十倍股评分
    if (agentResult['十倍股指标打分']) {
      try { setAiIndicatorScores(symbol, agentResult['十倍股指标打分']); } catch {}
    }

    return {
      '来源': 'AI Agent 股票评价',
      '模型': process.env.EVA_MODEL,
      '股票代码': symbol,
      '股票简称': stockName,
      '分析时间': analysisTime,
      '结论': agentResult['结论'],
      '核心逻辑': agentResult['核心逻辑'],
      '风险提示': agentResult['风险提示'],
      '十倍股指标打分': agentResult['十倍股指标打分'] || null,
    };
  }
}
