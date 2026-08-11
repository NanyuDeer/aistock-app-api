/**
 * Chat WS 反代桥接（P0 身份鉴权）
 *
 * 接管 `/api/agent/ws/chat` 的 upgrade 请求：
 * 1. 解析 query `token`（uni-app 小程序端 WS 不能自定义 header，走 query——handler.ts 已有先例）。
 * 2. 无 token → 放行，身份 = null（未登录，user_id=None）。
 * 3. 有 token → verifyJwt 验签：合法得 openid；非法/过期 → ws.close(4401)（写侧显式告知，绝无声失效）。
 * 4. 作为 WS 客户端连 agent-py `/api/agent/ws/chat`（带 X-Internal-Token header，沿 agent.proxy.ts 先例）。
 * 5. 双向转发：前端 → 上游覆写消息体 user_id 为服务端 openid（或 null）；上游 → 前端字节原样透传。
 *
 * 与既有 `/ws` 行情频道并存：两个 WebSocketServer 共用同一 HTTP server 的
 * upgrade 事件，各自按 path 精确分发、对非自身路径忽略（不 abort）——
 * ws 库 path 模式（{ server, path }）对不匹配路径会 abortHandshake(400)，
 * 会把另一方的 upgrade 请求全部打成 400（P0 联调定位到的根因，故用 noServer）。
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { verifyJwt } from '../../shared/utils/jwt';

export interface ChatBridgeOptions {
  /** 上游 agent-py HTTP 基地址，如 http://localhost:8080 */
  agentPyTarget: string;
  /** 注入上游请求的 X-Internal-Token */
  internalToken: string;
  /** JWT 验签密钥（与 auth 模块 signJwt/verifyJwt 一致） */
  jwtSecret: string;
}

/** 上游拒绝/异常时向前端发送的 error 事件（useChatStream 收到 error 自动降级 HTTP 非流式） */
const UPSTREAM_ERROR_EVENT = JSON.stringify({ type: 'error', content: 'agent service unavailable' });

/** agent-py HTTP 基地址 → 上游 WS 地址；路径固定 /api/agent/ws/chat，不携带前端 token query */
function buildUpstreamWsUrl(agentPyTarget: string): string {
  const u = new URL(agentPyTarget);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/api/agent/ws/chat';
  u.search = '';
  return u.toString();
}

/** 解析 JSON 消息并覆写 user_id（openid 或 null）；非 JSON 帧/数组原样返回（防御性） */
function rewriteUserId(text: string, openid: string | null): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      (parsed as Record<string, unknown>).user_id = openid;
      return JSON.stringify(parsed);
    }
  } catch {
    // 非 JSON 帧：不覆写，原样转发
  }
  return text;
}

/**
 * 挂载 Chat WS 桥接（在 start() 中与 initWebSocket(server) 并行调用）。
 * 返回 wss 便于测试/关闭。
 */
export function initChatBridge(server: Server, options: ChatBridgeOptions): WebSocketServer {
  // 与既有行情频道（/ws）共用同一 HTTP server 的 upgrade 事件：
  // 按 path 精确分发，仅处理 /api/agent/ws/chat，其余路径忽略（不 abort）——
  // ws 库 path 模式（{ server, path }）对不匹配路径会 abortHandshake(400)，
  // 会把 /ws 行情频道打成 400。noServer 模式 + 手动 handleUpgrade 精确分流。
  const CHAT_PATH = '/api/agent/ws/chat';
  // rewriteUserId 需整帧缓冲（JSON.parse + 重新 stringify），ws 默认 maxPayload=100MB，
  // 恶意客户端可推近 100MB 帧被整体缓存在内存 → 显式对齐 HTTP 面 10MB 限制，超限自动 close(1009)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    if (pathname !== CHAT_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (clientWs: WebSocket, req: IncomingMessage) => {
    // 1. 解析 query token
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token');

    let openid: string | null = null;
    if (token) {
      const payload = verifyJwt(token, options.jwtSecret);
      if (!payload) {
        // token 非法/过期 → 显式拒绝（写侧告知，绝无声失效——沿用 token-revocation 硬约束）
        clientWs.close(4401, 'unauthorized');
        return;
      }
      openid = payload.openid;
    }

    // 2. 作为 WS 客户端连上游 agent-py（X-Internal-Token header，沿 agent.proxy.ts 先例）
    const upstream = new WebSocket(buildUpstreamWsUrl(options.agentPyTarget), {
      headers: { 'X-Internal-Token': options.internalToken },
    });

    // 3. 前端 → 上游：覆写 user_id。上游可能尚未连上（前端 onOpen 即发消息），
    //    CONNECTING 期间先缓存到 pending，open 后按序 flush——否则首条消息被丢。
    const pending: string[] = [];
    clientWs.on('message', (data: Buffer) => {
      const text = rewriteUserId(data.toString(), openid);
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(text);
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        pending.push(text);
      }
      // CLOSING/CLOSED（上游已挂）：丢弃，客户端将由 error/close 分支关闭
    });
    upstream.on('open', () => {
      while (pending.length > 0 && upstream.readyState === WebSocket.OPEN) {
        upstream.send(pending.shift()!);
      }
    });

    // 4. 上游 → 前端：字节流原样透传（intermediate/tool_start/text/done/reasoning/cards 一字不改）
    upstream.on('message', (data: Buffer) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data);
      }
    });

    // 5. 断连语义：前端断开 → 关闭上游；上游断开 → 关闭前端；上游异常 → 前端 error + 关闭
    const closeUpstream = (): void => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    };
    clientWs.on('close', closeUpstream);
    clientWs.on('error', closeUpstream);

    upstream.on('close', () => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close();
      }
    });
    upstream.on('error', (err: Error) => {
      // 上游不可用（连接失败/中断）：向前端发 error（前端自动降级 HTTP 非流式），再关闭
      console.error('[ChatBridge] upstream error:', err.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.send(UPSTREAM_ERROR_EVENT);
        } catch {
          // 发送失败（客户端已断开）忽略
        }
        clientWs.close();
      }
    });
  });

  console.log(`[WS] Chat 桥接已启动，路径: /api/agent/ws/chat → ${options.agentPyTarget}`);
  return wss;
}
