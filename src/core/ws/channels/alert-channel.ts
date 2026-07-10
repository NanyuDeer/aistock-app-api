/**
 * 异动提醒频道 - 推送自选股/持仓异动
 */
import type { WebSocket } from 'ws'
import { getAllClients } from './quote-channel'

/** 向所有连接的客户端广播异动提醒 */
export function pushAlert(data: any): void {
  const msg = JSON.stringify({ type: 'alert', data })
  getAllClients().forEach((_client, ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg)
    }
  })
}

/** 向指定用户推送异动提醒 */
export function pushAlertToUser(userId: string, data: any): void {
  const msg = JSON.stringify({ type: 'alert', data })
  getAllClients().forEach((client, ws) => {
    if (client.userId === userId && ws.readyState === ws.OPEN) {
      ws.send(msg)
    }
  })
}
