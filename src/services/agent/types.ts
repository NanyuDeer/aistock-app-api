/** Agent 工具调用请求 */
export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/** Agent 工具执行结果 */
export interface AgentToolResult {
  tool_call_id: string;
  name: string;
  content: string;
}

/** Agent 单轮执行结果 */
export interface AgentStep {
  round: number;
  role: 'assistant';
  tool_calls?: AgentToolCall[];
  text_content?: string;
}

/** Agent 进度事件（SSE 推送） */
export interface AgentProgressEvent {
  type: 'agent.thinking' | 'agent.tool_call' | 'agent.tool_result' | 'agent.final';
  round: number;
  data: Record<string, any>;
}

/** Agent 配置 */
export interface AgentConfig {
  maxRounds: number;
  model: string;
  temperature: number;
}

/** Agent 执行上下文 */
export interface AgentContext {
  symbol: string;
  stockName: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string | Array<any>; tool_call_id?: string }>;
  round: number;
  newsCache: Map<string, any>;
  config: AgentConfig;
}

/** 研判结论（与现有 StockAnalysisResult 兼容） */
export interface AgentAnalysisResult {
  '结论': string;
  '核心逻辑': string;
  '风险提示': string;
  '十倍股指标打分'?: Record<string, number>;
}
