/**
 * 通用对话 Agent
 * 处理所有非特定意图的对话（兜底 Agent）
 *
 * 注意：该 Agent 不能 import orchestrator.ts（会产生循环依赖），
 * 需要的 helper 函数在此内联实现。
 */
import type { Agent, ChatContext } from '../skills/types'
import { executeSkill } from '../skills/registry'

// 内联 helper：从消息中提取股票代码（避免循环依赖 orchestrator）
function extractSymbol(message: string): string | null {
  const match = message.match(/\b(\d{6})\b/)
  return match ? match[1] : null
}

// 内联 helper：从消息中提取板块代码（避免循环依赖 orchestrator）
function extractTagCode(message: string): string | null {
  const match = message.match(/BK\d+/i)
  return match ? match[0].toUpperCase() : null
}

export const generalAgent: Agent = {
  id: 'general',
  name: '通用对话',
  description: '兜底 Agent，处理所有未匹配到其他 Agent 的对话',
  routingPrompt: '你是通用对话助手，当其他 Agent 都不适合处理用户的请求时由你接手。你可以处理日常对话、回答通用问题，以及在用户没有明确意图时引导对话。',
  category: 'general',
  systemPrompt: '',  // 当前没有 LLM prompt，后面补
  allowedSkills: ['stock_quote', 'capital_flow', 'leader_stock'],

  async *handle(message: string, context?: ChatContext): AsyncGenerator<string> {
    // 使用关键词匹配（类似旧的 recognizeIntent 逻辑），在 LLM 不可用时保证基础能力
    let narrative: string | undefined

    if (/\d{6}/.test(message)) {
      const symbol = extractSymbol(message)

      if (/资金|流入|流出/.test(message) && symbol) {
        try {
          const result = await executeSkill(generalAgent, 'capital_flow', { symbol })
          narrative = result.narrative
        } catch (e: any) {
          console.error('[GeneralAgent] capital_flow skill error:', e.message)
        }
      } else if (symbol) {
        try {
          const result = await executeSkill(generalAgent, 'stock_quote', { symbol })
          narrative = result.narrative
        } catch (e: any) {
          console.error('[GeneralAgent] stock_quote skill error:', e.message)
        }
      }
    } else if (/龙头|板块|概念/.test(message)) {
      const tagCode = extractTagCode(message) || 'BK0475' // 默认白酒
      try {
        const result = await executeSkill(generalAgent, 'leader_stock', { tagCode })
        narrative = result.narrative
      } catch (e: any) {
        console.error('[GeneralAgent] leader_stock skill error:', e.message)
      }
    }

    if (narrative) {
      yield narrative
    } else {
      yield `收到您的消息："${message}"。我目前支持查询个股行情、资金流向和龙头股，您可以试试"查一下 600519 的行情"。`
    }
  }
}
