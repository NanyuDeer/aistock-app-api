/**
 * Chat WS 桥接测试（P0 身份鉴权）
 * 用真实 http server + initChatBridge + 上游 ws 回声服务验证：
 * 1. 无 token → 放行，user_id 覆写为 null
 * 2. 合法 token → user_id 覆写为 openid（伪造值失效）
 * 3. 非法 token / 过期 token → 客户端 close(4401)
 * 4. 上游 → 客户端字节原样透传
 * 5. 上游不可达 → 客户端收 {type:'error'} 后关闭
 * 运行：node --import tsx --test src/core/ws/__tests__/chat-bridge.spec.ts
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { initChatBridge } from '../chat-bridge';
import { signJwt } from '../../../shared/utils/jwt';

const JWT_SECRET = 'test-jwt-secret';
const INTERNAL_TOKEN = 'test-internal-token-xyz';

// ---------- 工具 ----------
function futureExp(): number { return Math.floor(Date.now() / 1000) + 3600; }
function signOpenid(openid: string): string {
  return signJwt({ openid, iat: Math.floor(Date.now() / 1000), exp: futureExp() }, JWT_SECRET);
}

const tracked: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((t) => t.close()));
});

/** 启动被测 app-api 侧 http server（挂载 chat 桥接） */
function startBridge(agentPyTarget: string): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    initChatBridge(server, { agentPyTarget, internalToken: INTERNAL_TOKEN, jwtSecret: JWT_SECRET });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      tracked.push({ close: () => new Promise((r) => server.close(() => r())) });
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

/** 启动上游 agent-py 模拟 ws 服务：记录收到的消息 + upgrade 请求头；push() 广播事件给桥接 */
function startUpstreamWs(): Promise<{
  port: number;
  received: Array<{ data: string }>;
  upgradeHeaders: Array<http.IncomingHttpHeaders>;
  push: (payload: unknown) => void;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const received: Array<{ data: string }> = [];
    const upgradeHeaders: Array<http.IncomingHttpHeaders> = [];
    wss.on('connection', (socket, req) => {
      upgradeHeaders.push(req.headers);
      socket.on('message', (data: Buffer) => received.push({ data: data.toString() }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      tracked.push({ close: () => new Promise((r) => { wss.close(() => server.close(() => r())); }) });
      resolve({
        port: (server.address() as AddressInfo).port,
        received,
        upgradeHeaders,
        push: (payload: unknown) => {
          const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
          for (const client of wss.clients) client.send(text);
        },
      });
    });
  });
}

/** 客户端连接 helper */
function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** 等待关闭帧（捕获 code/reason，验证 4401） */
function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

/** 等待上游收到 N 条消息（桥接异步连上游，需轮询等待） */
async function waitForUpstreamMessages(received: Array<{ data: string }>, n: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (received.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(received.length >= n, `expected >=${n} upstream messages, got ${received.length}`);
}

// ---------- 用例 ----------
describe('chat bridge', () => {
  it('无 token：放行，客户端自报 user_id 被覆写为 null，其余字段原样透传', async () => {
    const upstream = await startUpstreamWs();
    const bridge = await startBridge(`http://127.0.0.1:${upstream.port}`);
    const client = await connectWs(`ws://127.0.0.1:${bridge.port}/api/agent/ws/chat`);
    const closed = waitForClose(client);

    client.send(JSON.stringify({ message: '你好', session_id: 's1', user_id: 'forged_user' }));
    await waitForUpstreamMessages(upstream.received, 1);

    const parsed = JSON.parse(upstream.received[0].data) as Record<string, unknown>;
    assert.strictEqual(parsed.message, '你好');
    assert.strictEqual(parsed.session_id, 's1');
    assert.strictEqual(parsed.user_id, null); // 伪造值被擦除为 null

    client.close();
    await closed;
  });

  it('合法 token：user_id 覆写为 openid（伪造值失效），上游收到 X-Internal-Token', async () => {
    const upstream = await startUpstreamWs();
    const bridge = await startBridge(`http://127.0.0.1:${upstream.port}`);
    const token = signOpenid('o_p0_test');
    const client = await connectWs(`ws://127.0.0.1:${bridge.port}/api/agent/ws/chat?token=${token}`);
    const closed = waitForClose(client);

    client.send(JSON.stringify({ message: '600519 今天怎么样', user_id: 'forged_other' }));
    await waitForUpstreamMessages(upstream.received, 1);

    const parsed = JSON.parse(upstream.received[0].data) as Record<string, unknown>;
    assert.strictEqual(parsed.user_id, 'o_p0_test');

    // 桥接以 X-Internal-Token 连上游（沿 agent.proxy.ts 先例，agent-py 侧可信）
    assert.strictEqual(upstream.upgradeHeaders.length, 1);
    assert.strictEqual(upstream.upgradeHeaders[0]['x-internal-token'], INTERNAL_TOKEN);

    client.close();
    await closed;
  });

  it('非法 token：连接被拒，close code 4401', async () => {
    const upstream = await startUpstreamWs();
    const bridge = await startBridge(`http://127.0.0.1:${upstream.port}`);
    const client = await connectWs(`ws://127.0.0.1:${bridge.port}/api/agent/ws/chat?token=garbage-token`);
    const { code } = await waitForClose(client);
    assert.strictEqual(code, 4401);
  });

  it('过期 token：连接被拒，close code 4401', async () => {
    const upstream = await startUpstreamWs();
    const bridge = await startBridge(`http://127.0.0.1:${upstream.port}`);
    const expired = signJwt(
      { openid: 'o_expired', iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 },
      JWT_SECRET,
    );
    const client = await connectWs(`ws://127.0.0.1:${bridge.port}/api/agent/ws/chat?token=${expired}`);
    const { code } = await waitForClose(client);
    assert.strictEqual(code, 4401);
  });

  it('上游 → 前端：事件字节原样透传', async () => {
    const upstream = await startUpstreamWs();
    const bridge = await startBridge(`http://127.0.0.1:${upstream.port}`);
    const client = await connectWs(`ws://127.0.0.1:${bridge.port}/api/agent/ws/chat`);
    const closed = waitForClose(client);

    const frame = JSON.stringify({ type: 'text', content: '逐字流' });
    const received = new Promise<string>((resolve) => {
      client.on('message', (data: Buffer) => resolve(data.toString()));
    });
    // 竞态修正（相对简报原测试）：push 前先等桥接完成与上游的 WS 握手（upgradeHeaders 记录上游 connection 事件）。
    // 否则 client open 时桥接的上游连接仍处于 CONNECTING，不在上游 wss.clients 中，push 的帧被丢弃，
    // received promise 永不 resolve（原测试无超时保护，用例会挂起）。
    const deadline = Date.now() + 3000;
    while (upstream.upgradeHeaders.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(upstream.upgradeHeaders.length >= 1, 'bridge did not establish upstream connection');
    upstream.push(frame);
    const got = await received;
    assert.strictEqual(got, frame); // 一字不改

    client.close();
    await closed;
  });

  it('上游不可达：客户端收到 error 事件后关闭', async () => {
    // 占用端口后立即释放 → “几乎必然不可达”
    const port = await new Promise<number>((resolve) => {
      const s = http.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const bridge = await startBridge(`http://127.0.0.1:${port}`);

    // 先注册监听再 await open，避免桥接的 error+close 早于监听器注册（竞态）
    const events: Array<{ kind: 'message' | 'close'; data?: string }> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/api/agent/ws/chat`);
    ws.on('message', (data: Buffer) => events.push({ kind: 'message', data: data.toString() }));
    ws.on('close', () => events.push({ kind: 'close' }));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    const deadline = Date.now() + 3000;
    while (!events.some((e) => e.kind === 'close') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const errorMsg = events.find((e) => e.kind === 'message');
    assert.ok(errorMsg, 'expected {type:"error"} from bridge before close');
    const parsed = JSON.parse(errorMsg.data as string) as { type?: string };
    assert.strictEqual(parsed.type, 'error');
    assert.ok(events.some((e) => e.kind === 'close'), 'expected client close after upstream error');
  });
});
