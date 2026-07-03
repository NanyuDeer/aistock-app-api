/**
 * WebSocket 处理器
 * 管理连接生命周期，将消息分发到对应频道
 */
import type { Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import {
  registerClient,
  unregisterClient,
  handleQuoteMessage,
  pushQuoteUpdate as _pushQuoteUpdate
} from './channels/quote-channel'
import { pushAlert as _pushAlert, pushAlertToUser as _pushAlertToUser } from './channels/alert-channel'
import { handleChatMessage } from './channels/chat-channel'

/**
 * 初始化 WebSocket 服务
 */
export function initWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket, req: any) => {
    console.log('[WS] 新连接')

    const url = new URL(req.url, 'http://localhost')
    const token = url.searchParams.get('token')
    const userId = token ? parseUserIdFromToken(token) : undefined

    registerClient(ws, { userId, subscribedSymbols: new Set() })

    ws.on('message', async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())
        await dispatchMessage(ws, msg)
      } catch (e: any) {
        console.error('[WS] message error:', e.message)
        ws.send(JSON.stringify({ type: 'error', message: '消息格式错误' }))
      }
    })

    ws.on('close', () => {
      unregisterClient(ws)
      console.log('[WS] 连接关闭')
    })

    ws.on('error', (err) => {
      console.error('[WS] error:', err)
      unregisterClient(ws)
    })
  })

  console.log('[WS] WebSocket 服务已启动，路径: /ws')
  return wss
}

/** 消息分发到对应频道 */
async function dispatchMessage(ws: WebSocket, msg: any) {
  // 1. 行情订阅频道
  if (handleQuoteMessage(ws, msg)) return

  // 2. 对话频道
  if (msg.type === 'chat') {
    await handleChatMessage(ws, { message: msg.message, session_id: msg.session_id })
    return
  }

  // 未知类型
  ws.send(JSON.stringify({ type: 'error', message: `未知消息类型: ${msg.type}` }))
}

/**
 * 向所有客户端推送行情更新（对外导出，供定时任务调用）
 */
export function pushQuoteUpdate(symbol: string, data: any): void {
  _pushQuoteUpdate(symbol, data)
}

/**
 * 向所有客户端推送异动提醒
 */
export function pushAlert(data: any): void {
  _pushAlert(data)
}

/**
 * 向指定用户推送消息
 */
export function pushToUser(userId: string, data: any): void {
  _pushAlertToUser(userId, data)
}

/**
 * 简单的 token 解析（TODO: 接入正式 JWT）
 */
function parseUserIdFromToken(token: string): string | undefined {
  if (token.startsWith('user_')) return token.slice(5)
  return undefined
}
