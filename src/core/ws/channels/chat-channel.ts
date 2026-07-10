/**
 * 对话频道 - 处理 AI 对话流式输出
 */
import type { WebSocket } from 'ws'
import { handleMessageStream } from '../../../modules/agent/orchestrator'
import type { ChatContext } from '../../../modules/agent/skills/types'

/** 处理对话消息，流式推送结果 */
export async function handleChatMessage(
  ws: WebSocket,
  payload: { message?: string; session_id?: string }
): Promise<boolean> {
  if (!payload.message || typeof payload.message !== 'string') return false

  const context: ChatContext = {
    sessionId: payload.session_id || `ws_session_${Date.now()}`
  }

  try {
    const stream = handleMessageStream(payload.message, context)
    for await (const chunk of stream) {
      if (ws.readyState !== ws.OPEN) break
      ws.send(JSON.stringify(chunk))
    }
    return true
  } catch (e: any) {
    ws.send(JSON.stringify({ type: 'error', message: e.message || '对话处理失败' }))
    return false
  }
}
