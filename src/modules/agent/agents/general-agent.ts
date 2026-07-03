/**
 * 通用对话 Agent
 * 处理所有非特定意图的对话（兜底 Agent）
 */
import type { Agent, ChatContext } from '../skills/types'

export const generalAgent: Agent = {
  id: 'general',
  name: '通用对话',
  description: '兜底 Agent，处理所有未匹配到其他 Agent 的对话',
  routingPrompt: '你是通用对话助手，当其他 Agent 都不适合处理用户的请求时由你接手。你可以处理日常对话、回答通用问题，以及在用户没有明确意图时引导对话。',
  category: 'general',
  systemPrompt: '',  // 当前没有 LLM prompt，后面补
  allowedSkills: ['stock_quote', 'capital_flow', 'leader_stock'],

  async *handle(message: string, context?: ChatContext): AsyncGenerator<string> {
    const { handleMessageStream } = await import('../orchestrator')
    const stream = handleMessageStream(message, context)
    for await (const chunk of stream) {
      if (chunk.type === 'text') {
        yield chunk.content
      }
    }
  }
}
