import OpenAI from 'openai'
import type { Agent } from '../skills/types'

const ROUTER_SYSTEM_PROMPT = `你是一个智能路由选择器。你的任务是从下面的 Agent 列表中选择一个最合适的 Agent 来处理用户的请求。

每个 Agent 都有一段"路由提示词"描述其能力。阅读用户消息，选择能力最匹配的 Agent，返回其 ID。

规则：
- 只返回 Agent ID，不要其他文字
- 如果不确定，选择最接近的
- 如果完全无匹配，返回 null

Agent 列表：
{{AGENTS_DESCRIPTION}}`

/**
 * LLM 路由：从所有 Agent 中选择最匹配的一个
 * @param message 用户消息
 * @param agents 可选 Agent 列表（除 general 外）
 * @returns Agent ID 或 null
 */
export async function llmRouter(
  message: string,
  agents: Agent[]
): Promise<string | null> {
  // Build agent descriptions from their routingPrompt
  const agentDescriptions = agents
    .map(a => `ID: ${a.id}\n能力: ${a.routingPrompt}`)
    .join('\n\n---\n\n')

  const systemPrompt = ROUTER_SYSTEM_PROMPT.replace('{{AGENTS_DESCRIPTION}}', agentDescriptions)

  // Use OpenAI SDK — read config from env vars, matching existing project patterns
  const apiKey = process.env.OPENAI_API_KEY || ''
  const apiBase = process.env.OPENAI_API_BASE_URL || process.env.OPENAI_API_BASE || 'https://api.openai.com/v1'
  const model = process.env.AI_MODEL || 'gpt-4o-mini'

  const client = new OpenAI({ apiKey, baseURL: apiBase })

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ],
    temperature: 0,
    max_tokens: 50,
  })

  const agentId = response.choices[0]?.message?.content?.trim() || null

  // Validate: return null if LLM returned an unknown ID
  if (agentId && !agents.some(a => a.id === agentId)) {
    return null
  }

  return agentId
}
