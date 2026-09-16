import { MID_LONG_AGENT_TOOL_DEFINITIONS, executeMidLongToolCall } from './analysis-agent/tools';
import {
  MID_AGENT_SYSTEM_PROMPT,
  LONG_AGENT_SYSTEM_PROMPT,
  buildMidAgentUserPrompt,
  buildLongAgentUserPrompt,
} from './analysis-agent/prompts';
import type {
  AgentConfig,
  AgentContext,
  AgentToolCall,
  AgentProgressEvent,
  AgentAnalysisResult,
} from './analysis-agent/types';
import { shanghaiDateStr, shanghaiDateTimeMsStr } from '../../shared/utils/shanghaiTime';
import pool from '../../core/db';
import { sessionFetch } from '../../shared/utils/httpAgent';

type Timeframe = 'mid' | 'long';

const DEFAULT_CONFIG: AgentConfig = {
  maxRounds: 5,
  model: '',
  temperature: 0.2,
};

type ProgressHandler = (event: AgentProgressEvent) => void;

export class StockMidLongAnalysisService {

  private static emitProgress(handler: ProgressHandler | undefined, event: AgentProgressEvent): void {
    if (!handler) return;
    try { handler(event); } catch {}
  }

  private static buildModelUrl(): string {
    const url = process.env.QWEN_BASE_URL;
    if (!url) throw new Error('缺少 QWEN_BASE_URL 配置');
    const trimmed = url.replace(/\/+$/, '');
    return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
  }

  private static buildAuthHeaders(): Record<string, string> {
    const key = process.env.QWEN_API_KEY;
    if (!key) throw new Error('缺少 QWEN_API_KEY 配置');
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` };
  }

  private static getModel(): string {
    const model = process.env.QWEN_MODEL;
    if (!model) throw new Error('缺少 QWEN_MODEL 配置');
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
      const advice = String(parsed['投资建议'] || '').trim();
      if (!conclusion || !coreLogic || !riskWarning) return null;
      return { '结论': conclusion, '核心逻辑': coreLogic, '风险提示': riskWarning, '投资建议': advice };
    } catch { return null; }
  }

  private static async callModel(
    context: AgentContext,
  ): Promise<{ tool_calls?: AgentToolCall[]; text_content?: string }> {
    const headers = this.buildAuthHeaders();
    const model = this.getModel() || context.config.model;

    const body = {
      model,
      temperature: context.config.temperature,
      messages: context.messages,
      tools: MID_LONG_AGENT_TOOL_DEFINITIONS,
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

      let textContent: string | undefined;
      if (typeof message?.content === 'string' && message.content.trim()) {
        textContent = message.content.trim();
      }

      return { tool_calls: toolCalls.length > 0 ? toolCalls : undefined, text_content: textContent };
    } finally {
      clearTimeout(timeout);
    }
  }

  static async runAgent(
    symbol: string,
    stockName: string,
    timeframe: Timeframe,
    onProgress?: ProgressHandler,
  ): Promise<AgentAnalysisResult> {
    const maxRounds = Number(process.env.AGENT_MAX_ROUNDS) || DEFAULT_CONFIG.maxRounds;
    const config: AgentConfig = { ...DEFAULT_CONFIG, model: this.getModel(), maxRounds };
    const today = shanghaiDateStr();

    const systemPrompt = timeframe === 'mid' ? MID_AGENT_SYSTEM_PROMPT : LONG_AGENT_SYSTEM_PROMPT;
    const userPrompt = timeframe === 'mid'
      ? buildMidAgentUserPrompt(symbol, stockName, today)
      : buildLongAgentUserPrompt(symbol, stockName, today);

    const context: AgentContext = {
      symbol,
      stockName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
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

      const assistantMessage: any = { role: 'assistant', content: response.text_content || '' };
      if (response.tool_calls && response.tool_calls.length > 0) {
        assistantMessage.tool_calls = response.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      context.messages.push(assistantMessage);

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

        if (context.round >= config.maxRounds) {
          context.messages.push({
            role: 'user',
            content: '你已达到最大检索轮次。请立即输出最终研判结论的JSON，不要再调用任何工具。',
          });
          continue;
        }

        context.messages.push({
          role: 'user',
          content: '请继续检索信息或直接输出最终研判结论JSON。',
        });
        continue;
      }

      for (const call of response.tool_calls) {
        this.emitProgress(onProgress, {
          type: 'agent.tool_call',
          round: context.round,
          data: { tool: call.name, arguments: call.arguments },
        });

        const result = await executeMidLongToolCall(call, context);

        this.emitProgress(onProgress, {
          type: 'agent.tool_result',
          round: context.round,
          data: { tool: call.name, result_preview: result.content.slice(0, 200) },
        });

        context.messages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: result.tool_call_id,
        } as any);
      }
    }

    if (!finalResult) {
      this.emitProgress(onProgress, {
        type: 'agent.thinking',
        round: context.round,
        data: { message: '强制生成最终结论...' },
      });

      context.messages.push({
        role: 'user',
        content: '请立即基于已有信息输出最终研判结论JSON。',
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

  static async createAnalysis(
    symbol: string,
    timeframe: Timeframe,
    onProgress?: ProgressHandler,
  ): Promise<Record<string, any>> {
    const result = await pool.query('SELECT name FROM stocks WHERE symbol = $1 LIMIT 1', [symbol]);
    const row = result.rows[0] as { name: string } | undefined;
    const stockName = (row?.name || '').trim();
    if (!stockName) throw new Error(`股票代码不存在: ${symbol}`);

    const agentResult = await this.runAgent(symbol, stockName, timeframe, onProgress);
    const analysisTime = shanghaiDateTimeMsStr(Date.now());

    await pool.query(
      `INSERT INTO stock_mid_long_analysis (symbol, timeframe, analysis_time, conclusion, core_logic, risk_warning, advice)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [symbol, timeframe, analysisTime, agentResult['结论'], agentResult['核心逻辑'], agentResult['风险提示'], agentResult['投资建议']],
    );

    return {
      股票代码: symbol,
      股票简称: stockName,
      分析时间: analysisTime,
      周期: timeframe === 'mid' ? '中线' : '长线',
      结论: agentResult['结论'],
      核心逻辑: agentResult['核心逻辑'],
      风险提示: agentResult['风险提示'],
      投资建议: agentResult['投资建议'],
    };
  }

  static async getLatestAnalysis(symbol: string, timeframe: Timeframe): Promise<Record<string, any> | null> {
    const result = await pool.query(
      `SELECT a.symbol, s.name AS stock_name, a.timeframe, a.analysis_time, a.conclusion, a.core_logic, a.risk_warning, a.advice
       FROM stock_mid_long_analysis a
       LEFT JOIN stocks s ON s.symbol = a.symbol
       WHERE a.symbol = $1 AND a.timeframe = $2
       ORDER BY a.analysis_time DESC LIMIT 1`,
      [symbol, timeframe],
    );
    const row = result.rows[0] as any;
    if (!row) return null;

    return {
      股票代码: row.symbol,
      股票简称: row.stock_name || '',
      分析时间: row.analysis_time,
      周期: row.timeframe === 'mid' ? '中线' : '长线',
      结论: row.conclusion,
      核心逻辑: row.core_logic,
      风险提示: row.risk_warning,
      投资建议: row.advice || '',
    };
  }
}