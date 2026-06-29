/**
 * WebSocket 处理器
 * 管理 WebSocket 连接，处理实时行情推送、异动提醒、对话流式输出
 */
import type { Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { handleMessageStream } from '../agent/orchestrator'
import type { ChatContext } from '../agent/skills/types'

interface ClientInfo {
  userId?: string
  subscribedSymbols: Set<string>
}

const clients = new Map<WebSocket, ClientInfo>()

/**
 * 初始化 WebSocket 服务
 */
export function initWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket, req: any) => {
    console.log('[WS] 新连接')

    // 从 URL query 提取 token（简单鉴权）
    const url = new URL(req.url, 'http://localhost')
    const token = url.searchParams.get('token')
    const userId = token ? parseUserIdFromToken(token) : undefined

    clients.set(ws, { userId, subscribedSymbols: new Set() })

    ws.on('message', async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())
        await handleWsMessage(ws, msg)
      } catch (e: any) {
        console.error('[WS] message error:', e.message)
        ws.send(JSON.stringify({ type: 'error', message: '消息格式错误' }))
      }
    })

    ws.on('close', () => {
      clients.delete(ws)
      console.log('[WS] 连接关闭')
    })

    ws.on('error', (err) => {
      console.error('[WS] error:', err)
      clients.delete(ws)
    })
  })

  console.log('[WS] WebSocket 服务已启动，路径: /ws')
  return wss
}

/**
 * 处理 WebSocket 消息
 */
async function handleWsMessage(ws: WebSocket, msg: any) {
  const { type, ...payload } = msg

  switch (type) {
    case 'subscribe': {
      // 订阅股票行情
      const client = clients.get(ws)
      if (client && payload.symbols) {
        payload.symbols.forEach((s: string) => client.subscribedSymbols.add(s))
        ws.send(JSON.stringify({ type: 'subscribed', symbols: payload.symbols }))
      }
      break
    }

    case 'unsubscribe': {
      // 取消订阅
      const client = clients.get(ws)
      if (client && payload.symbols) {
        payload.symbols.forEach((s: string) => client.subscribedSymbols.delete(s))
      }
      break
    }

    case 'chat': {
      // AI 对话（流式输出）
      const context: ChatContext = {
        sessionId: payload.session_id || `ws_session_${Date.now()}`
      }

      try {
        const stream = handleMessageStream(payload.message, context)
        for await (const chunk of stream) {
          ws.send(JSON.stringify(chunk))
        }
      } catch (e: any) {
        ws.send(JSON.stringify({ type: 'error', message: e.message }))
      }
      break
    }

    default:
      ws.send(JSON.stringify({ type: 'error', message: `未知消息类型: ${type}` }))
  }
}

/**
 * 向所有客户端推送行情更新
 */
export function pushQuoteUpdate(symbol: string, data: any) {
  const msg = JSON.stringify({ type: 'quote_update', data: { symbol, ...data } })
  clients.forEach((client, ws) => {
    if (client.subscribedSymbols.has(symbol) && ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
    }
  })
}

/**
 * 向所有客户端推送异动提醒
 */
export function pushAlert(data: any) {
  const msg = JSON.stringify({ type: 'alert', data })
  clients.forEach((_client, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
    }
  })
}

/**
 * 向指定用户推送消息
 */
export function pushToUser(userId: string, data: any) {
  const msg = JSON.stringify(data)
  clients.forEach((client, ws) => {
    if (client.userId === userId && ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
    }
  })
}

/**
 * 简单的 token 解析（TODO: 接入正式 JWT）
 */
function parseUserIdFromToken(token: string): string | undefined {
  // 临时实现：token 格式为 "user_<id>"
  if (token.startsWith('user_')) return token.slice(5)
  return undefined
}
