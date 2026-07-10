/**
 * 通用对话 Agent
 * 处理所有非特定意图的对话
 */
import type { Agent, ChatContext } from '../skills/types'
import { handleMessageStream } from '../orchestrator'
import { getSystemPrompt } from '../orchestrator'

export const generalAgent: Agent = {
  id: 'general',
  name: '通用对话',
  systemPrompt: getSystemPrompt(),
  availableSkills: ['stock_quote', 'capital_flow', 'leader_stock'],

  async *handle(message: string, context?: ChatContext): AsyncGenerator<string> {
    const stream = handleMessageStream(message, context)
    for await (const chunk of stream) {
      if (chunk.type === 'text') {
        yield chunk.content
      }
    }
  }
}
