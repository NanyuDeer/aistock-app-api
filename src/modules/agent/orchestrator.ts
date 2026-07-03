/**
 * Agent Orchestrator - 智能体调度器
 * 负责：意图识别 → 路由到对应 Agent → 调用 Skills → 生成回复
 */
import type { ChatContext, SkillResult, StreamMessage } from './skills/types'
import type { Agent } from './skills/types'
import { getSkillsDescription, initSkills } from './skills/registry'
import { SYSTEM_PROMPT } from './prompts/system'
import { agentRegistry } from './registry/agent-registry'
import { llmRouter } from './services/llm-router'

// 初始化 Skills
let initialized = false

async function ensureInit() {
  if (!initialized) {
    await initSkills()
    initialized = true
  }
}

/**
 * 尝试从消息中提取股票代码
 */
export function extractSymbol(message: string): string | null {
  const match = message.match(/\b(\d{6})\b/)
  return match ? match[1] : null
}

/**
 * 尝试从消息中提取板块代码
 */
export function extractTagCode(message: string): string | null {
  const match = message.match(/BK\d+/i)
  return match ? match[0].toUpperCase() : null
}

/**
 * 处理用户消息（非流式，返回完整结果）
 */
export async function handleMessage(
  message: string,
  context?: ChatContext
): Promise<{ content: string; skillResult?: SkillResult; session_id: string; agent_id: string }> {
  await ensureInit()

  const sessionId = context?.sessionId || `session_${Date.now()}`

  // Phase 2: LLM 路由选 Agent
  let agent: Agent
  try {
    agent = await agentRegistry.matchIntent(message, llmRouter)
  } catch (err) {
    console.error('[Orchestrator] LLM 路由失败，降级到 general agent:', err)
    agent = agentRegistry.getAgent('general')!
  }
  console.log(`[Orchestrator] 路由到 Agent: ${agent.id} (message: "${message.slice(0, 50)}")`)

  // Agent 执行（流式消费，收集完整内容）
  let content = ''
  let skillResult: SkillResult | undefined

  try {
    for await (const chunk of agent.handle(message, context)) {
      content += chunk
    }
  } catch (err: any) {
    console.error(`[Orchestrator] Agent "${agent.id}" 执行失败:`, err.message)
    content = `抱歉，处理您的请求时出现了错误。请稍后再试。`
  }

  // If the agent returned empty content, provide a fallback
  if (!content) {
    content = `收到您的消息："${message}"。我目前支持查询个股行情、资金流向和龙头股，您可以试试"查一下 600519 的行情"。`
  }

  return { content, skillResult, session_id: sessionId, agent_id: agent.id }
}

/**
 * 流式处理用户消息（通过 WebSocket 推送）
 */
export async function* handleMessageStream(
  message: string,
  context?: ChatContext
): AsyncGenerator<StreamMessage> {
  await ensureInit()

  const result = await handleMessage(message, context)

  if (result.skillResult) {
    yield { type: 'skill_result', result: result.skillResult }
  }

  if (result.content) {
    yield { type: 'text', content: result.content }
  }

  yield { type: 'done' }
}

/**
 * 获取系统提示词（含 Skills 描述）
 */
export async function getSystemPrompt(): Promise<string> {
  await ensureInit()

  // Build agent descriptions from registry (same pattern as LLM router)
  const agents = agentRegistry.getAllAgents()
  const agentDescriptions = agents
    .map(a => `ID: ${a.id}\n名称: ${a.name}\n能力: ${a.routingPrompt}`)
    .join('\n\n---\n\n')

  return SYSTEM_PROMPT
    .replace('{{SKILLS_DESCRIPTION}}', getSkillsDescription())
    .replace('{{AGENTS_DESCRIPTION}}', agentDescriptions)
}
