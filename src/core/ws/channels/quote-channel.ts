/**
 * 行情频道 - 处理股票行情订阅与推送，并作为客户端注册中心
 */
import type { WebSocket } from 'ws'

export interface ClientInfo {
  userId?: string
  tokenExpiresAt?: number
  subscribedSymbols: Set<string>
}

const clients = new Map<WebSocket, ClientInfo>()
/** userId → 连接集合，供定向推送直接命中，避免每次遍历全部连接 */
const clientsByUser = new Map<string, Set<WebSocket>>()

/** 注册客户端 */
export function registerClient(ws: WebSocket, info: ClientInfo): void {
  clients.set(ws, info)
  if (!info.userId) return
  let sockets = clientsByUser.get(info.userId)
  if (!sockets) {
    sockets = new Set()
    clientsByUser.set(info.userId, sockets)
  }
  sockets.add(ws)
}

/** 注销客户端 */
export function unregisterClient(ws: WebSocket): void {
  const userId = clients.get(ws)?.userId
  if (userId) {
    const sockets = clientsByUser.get(userId)
    sockets?.delete(ws)
    if (sockets && sockets.size === 0) clientsByUser.delete(userId)
  }
  clients.delete(ws)
}

/** 获取指定用户的全部连接（未登录用户无索引，返回 undefined） */
export function getClientsByUser(userId: string): Set<WebSocket> | undefined {
  return clientsByUser.get(userId)
}

/** 获取客户端信息 */
export function getClient(ws: WebSocket): ClientInfo | undefined {
  return clients.get(ws)
}

/** 获取所有客户端（供其他频道使用） */
export function getAllClients(): Map<WebSocket, ClientInfo> {
  return clients
}

/** 处理行情订阅/取消订阅消息，返回是否被本频道处理 */
export function handleQuoteMessage(ws: WebSocket, msg: any): boolean {
  const client = clients.get(ws)
  if (!client) return false

  if (msg.type === 'subscribe' && Array.isArray(msg.symbols)) {
    msg.symbols.forEach((s: string) => client.subscribedSymbols.add(s))
    ws.send(JSON.stringify({ type: 'subscribed', symbols: msg.symbols }))
    return true
  }

  if (msg.type === 'unsubscribe' && Array.isArray(msg.symbols)) {
    msg.symbols.forEach((s: string) => client.subscribedSymbols.delete(s))
    return true
  }

  return false
}

/** 向订阅了指定股票的客户端推送行情更新 */
export function pushQuoteUpdate(symbol: string, data: any): void {
  const msg = JSON.stringify({ type: 'quote_update', data: { symbol, ...data } })
  clients.forEach((client, ws) => {
    if (client.subscribedSymbols.has(symbol) && ws.readyState === ws.OPEN) {
      ws.send(msg)
    }
  })
}
