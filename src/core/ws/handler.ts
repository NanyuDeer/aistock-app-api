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
import { pushNotificationToUser as _pushNotificationToUser } from './channels/notification-channel'
import { verifyJwt } from '../../shared/utils/jwt'

/**
 * 初始化 WebSocket 服务
 */
export function initWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket, req: any) => {
    console.log('[WS] 新连接')

    const url = new URL(req.url, 'http://localhost')
    const token = url.searchParams.get('token')
    const auth = token ? parseUserFromToken(token) : undefined

    registerClient(ws, { userId: auth?.openid, tokenExpiresAt: auth?.exp, subscribedSymbols: new Set() })

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

/** 向已认证的 App 用户定向推送通知中心消息。 */
export function pushNotificationToUser(userId: string, notification: any): void {
  _pushNotificationToUser(userId, notification)
}

/**
 * 生产环境校验正式 JWT；user_<openid> 仅保留给本地开发联调。
 */
function parseUserFromToken(token: string): { openid: string; exp?: number } | undefined {
  // user_<openid> 仅供本地开发使用；生产环境使用已签名的 JWT。
  if (process.env.NODE_ENV !== 'production' && token.startsWith('user_')) {
    return { openid: token.slice(5) }
  }
  if (!process.env.JWT_SECRET) return undefined
  const payload = verifyJwt(token, process.env.JWT_SECRET)
  return payload ? { openid: payload.openid, exp: payload.exp } : undefined
}
