import type { WebSocket } from 'ws';
import { getClient, getClientsByUser } from './quote-channel';

export interface NotificationSocketPayload {
    id: string;
    category: string;
    symbol: string | null;
    stockName: string | null;
    title: string;
    summary: string;
    targetPath: string;
    payload: Record<string, unknown>;
    createdAt: string;
    readAt: string | null;
}

export function pushNotificationToUser(userId: string, notification: NotificationSocketPayload): void {
    const sockets = getClientsByUser(userId);
    if (!sockets || sockets.size === 0) return;

    const message = JSON.stringify({ type: 'notification', data: { type: 'notification.created', notification } });
    const nowSeconds = Math.floor(Date.now() / 1000);
    sockets.forEach((ws: WebSocket) => {
        const client = getClient(ws);
        if (!client || ws.readyState !== ws.OPEN) return;
        if (client.tokenExpiresAt && client.tokenExpiresAt <= nowSeconds) return;
        ws.send(message);
    });
}
