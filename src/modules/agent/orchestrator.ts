/**
 * Agent Orchestrator - 智能体调度器
 * 负责：意图识别 → 路由到对应 Agent → 调用 Skills → 生成回复
 */
import type { ChatContext, SkillResult, StreamMessage } from './skills/types'
import { getSkill, getSkillsDescription, initSkills } from './skills/registry'
import { SYSTEM_PROMPT } from './prompts/system'

// 初始化 Skills
let initialized = false

function ensureInit() {
  if (!initialized) {
    initSkills()
    initialized = true
  }
}

/**
 * 简单意图识别（基于关键词，暂不调用 LLM）
 * TODO: 后续接入 LLM 做意图识别
 */
function recognizeIntent(message: string): string {
  if (/早报|晨报|晚报|早点听/.test(message)) return 'morning'
  if (/事件|传导|利好|利空|政策/.test(message)) return 'event'
  if (/持仓|盯盘|风控/.test(message)) return 'portfolio'
  if (/复盘|交易历史/.test(message)) return 'review'

  // 检测是否包含股票代码
  if (/\d{6}/.test(message)) {
    if (/资金|流入|流出/.test(message)) return 'capital_flow'
    if (/估值/.test(message)) return 'valuation'
    return 'stock_quote'
  }

  if (/龙头|板块|概念/.test(message)) return 'leader_stock'

  return 'general'
}

/**
 * 尝试从消息中提取股票代码
 */
function extractSymbol(message: string): string | null {
  const match = message.match(/\b(\d{6})\b/)
  return match ? match[1] : null
}

/**
 * 尝试从消息中提取板块代码
 */
function extractTagCode(message: string): string | null {
  const match = message.match(/BK\d+/i)
  return match ? match[0].toUpperCase() : null
}

/**
 * 处理用户消息（非流式，返回完整结果）
 */
export async function handleMessage(
  message: string,
  context?: ChatContext
): Promise<{ content: string; skillResult?: SkillResult; session_id: string }> {
  ensureInit()

  const intent = recognizeIntent(message)
  const sessionId = context?.sessionId || `session_${Date.now()}`

  console.log(`[Orchestrator] message="${message}", intent=${intent}`)

  // 根据意图调用对应 Skill
  let skillResult: SkillResult | undefined

  switch (intent) {
    case 'stock_quote': {
      const symbol = extractSymbol(message)
      if (symbol) {
        const skill = getSkill('stock_quote')
        if (skill) {
          try {
            skillResult = await skill.execute({ symbol })
          } catch (e: any) {
            console.error('[Orchestrator] stock_quote skill error:', e.message)
          }
        }
      }
      break
    }

    case 'capital_flow': {
      const symbol = extractSymbol(message)
      if (symbol) {
        const skill = getSkill('capital_flow')
        if (skill) {
          try {
            skillResult = await skill.execute({ symbol })
          } catch (e: any) {
            console.error('[Orchestrator] capital_flow skill error:', e.message)
          }
        }
      }
      break
    }

    case 'leader_stock': {
      const tagCode = extractTagCode(message) || 'BK0475' // 默认白酒
      const skill = getSkill('leader_stock')
      if (skill) {
        try {
          skillResult = await skill.execute({ tagCode })
        } catch (e: any) {
          console.error('[Orchestrator] leader_stock skill error:', e.message)
        }
      }
      break
    }

    case 'morning':
    case 'event':
    case 'portfolio':
    case 'review':
      // TODO: 这些 Agent 需要 LLM 支持，暂返回提示
      skillResult = {
        type: 'text',
        data: null,
        narrative: `${intent} 功能正在开发中，敬请期待。当前已支持个股行情、资金流向、龙头股查询。`
      }
      break

    case 'general':
    default:
      // 通用对话，暂不接入 LLM
      break
  }

  const content = skillResult?.narrative || `收到您的消息："${message}"。我目前支持查询个股行情、资金流向和龙头股，您可以试试"查一下 600519 的行情"。`

  return { content, skillResult, session_id: sessionId }
}

/**
 * 流式处理用户消息（通过 WebSocket 推送）
 */
export async function* handleMessageStream(
  message: string,
  context?: ChatContext
): AsyncGenerator<StreamMessage> {
  ensureInit()

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
export function getSystemPrompt(): string {
  ensureInit()
  return SYSTEM_PROMPT.replace('{{SKILLS_DESCRIPTION}}', getSkillsDescription())
}
