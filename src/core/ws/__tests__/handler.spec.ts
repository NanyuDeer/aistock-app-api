/**
 * WS 处理器鉴权测试（Important C：user_<openid> 本地联调后门收紧）
 * 用真实 http server + initWebSocket 验证：
 * 1. NODE_ENV=test：user_<openid> 放行，连接注册为该 openid
 * 2. NODE_ENV=development：user_<openid> 不再放行，连接以匿名身份注册（userId undefined）
 * 运行：node --import tsx --test src/core/ws/__tests__/handler.spec.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { initWebSocket } from '../handler';
import { getClientsByUser, getClient } from '../channels/quote-channel';

const servers: http.Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

function startWsServer(): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    initWebSocket(server);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve({ port: (server.address() as AddressInfo).port });
    });
  });
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** 轮询等待某 openid 注册（注册在服务端 connection 事件同步完成，轮询仅兜底时序） */
async function waitForUserRegistration(openid: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getClientsByUser(openid)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test('NODE_ENV=test：user_<openid> 本地联调 token 放行并注册为该 openid', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  let ws: WebSocket | undefined;
  try {
    const { port } = await startWsServer();
    ws = await connectWs(`ws://127.0.0.1:${port}/ws?token=user_o_local`);
    assert.ok(await waitForUserRegistration('o_local', 1000), 'test 环境 user_ 前缀应放行');
    const sockets = getClientsByUser('o_local')!;
    const serverSocket = sockets.values().next().value as WebSocket;
    assert.strictEqual(getClient(serverSocket)?.userId, 'o_local');
  } finally {
    ws?.close();
    process.env.NODE_ENV = prev;
  }
});

test('NODE_ENV=development：user_<openid> 后门不再放行，连接以匿名身份注册', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  let ws: WebSocket | undefined;
  try {
    const { port } = await startWsServer();
    ws = await connectWs(`ws://127.0.0.1:${port}/ws?token=user_o_dev`);
    // 收紧前：development 下 user_ 前缀放行 → 会被注册为 o_dev（用例失败）；
    // 收紧后：仅 NODE_ENV=test 放行 → 始终匿名，且连接本身仍被接受（未被 reject）。
    assert.strictEqual(await waitForUserRegistration('o_dev', 300), false, 'development 下 user_ 前缀不应放行');
    assert.strictEqual(ws.readyState, WebSocket.OPEN, '连接不应因 token 非正式 JWT 被拒绝');
  } finally {
    ws?.close();
    process.env.NODE_ENV = prev;
  }
});
