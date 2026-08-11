/**
 * Agent 反向代理中间件
 *
 * 将 Express 的 `/api/agent/*` 请求转发到 Python FastAPI 服务
 * （默认 `http://localhost:8000`）。
 *
 * 设计要点：
 * - **SSE 流式透传**：上游响应直接 `pipe` 到客户端，不做缓冲（支持 `text/event-stream`）。
 * - **注入 X-Internal-Token**：Python `/api/agent/chat/*` 依赖 `X-Internal-Token` 鉴权
 *   （缺失/不匹配返回 403）。代理覆写该 header，客户端无法伪造。
 * - **路径保留**：转发 `req.originalUrl`（含 `/api/agent` 前缀 + query），
 *   与 Python 路由 `app.include_router(api_router, prefix="/api/agent")` 一致 —— 不做路径重写。
 * - **错误处理**：Python 不可达（ECONNREFUSED 等）→ 502 + JSON 错误信息。
 * - **头透传**：`X-Request-ID` / `Authorization` / `Content-Type` 等通过复制请求头与
 *   响应头自动透传（Task 5 在 Python 侧给响应注入的 `X-Request-ID` 会原样回传给前端）。
 * - **挂载顺序**：必须挂在 `express.json()` **之前**，反代需要原始请求流，
 *   body parser 会消费 `req` 流导致 `pipe` 无数据可传。
 *
 * 实现方式：Node 原生 `http`/`https` + `pipe()`（brief 允许的 "Express 原生 proxy"），
 * 不引入 `http-proxy-middleware`，零新增运行时依赖，且对 SSE 透传与 502 有完全控制。
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { verifyJwt } from '../../shared/utils/jwt';

export interface AgentProxyOptions {
  /** Python FastAPI 基地址，例如 `http://localhost:8000` */
  target: string;
  /** 注入到上游请求的 `X-Internal-Token` 值（Python 侧 `internal_api_token`） */
  internalToken: string;
  /** P0：JWT 验签密钥（chat 路径鉴权；缺省空串时 verifyJwt 仍可运行但等同不鉴权） */
  jwtSecret: string;
  /** 连接/响应错误时的日志回调，默认 `console.error` */
  onError?: (err: NodeJS.ErrnoException, context: { method: string; url: string }) => void;
}

/** P0：chat 三入口（HTTP 降级路径）——加 JWT 校验 + 覆写 body user_id；其余路径行为零变化 */
const CHAT_PATHS = new Set(['/chat/message', '/chat/stream/messages', '/chat/stream/updates']);

/** 不应转发给上游的 hop-by-hop / 代理控制请求头 */
const HOP_BY_HOP_REQUEST = new Set<string>([
  'host', // 由 Node http 按 target 自动设置
  'accept-encoding', // 禁止上游压缩，避免 SSE 被 gzip 缓冲
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
]);

/** 不应回传给客户端的响应头 */
const HOP_BY_HOP_RESPONSE = new Set<string>([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
  // content-length 由 pipe 自动管理；流式响应回传上游 content-length 可能与实际不符
  'content-length',
]);

/**
 * 创建 Agent 反向代理 Router。
 *
 * 用法：`app.use('/api/agent', createAgentProxy({ target, internalToken }))`
 */
export function createAgentProxy(options: AgentProxyOptions): Router {
  if (!options || !options.target) {
    throw new Error('createAgentProxy: options.target is required');
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(options.target);
  } catch {
    throw new Error(`createAgentProxy: invalid target URL "${options.target}"`);
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw new Error(`createAgentProxy: target must be http(s), got "${targetUrl.protocol}"`);
  }

  const transport = targetUrl.protocol === 'https:' ? https : http;
  const internalToken = options.internalToken;
  const logError =
    options.onError ??
    ((err, ctx) => {
      console.error(
        `[AgentProxy] ${ctx.method} ${ctx.url} → ${err.code || err.name}: ${err.message}`,
      );
    });

  const router = Router();

  /**
   * 安全解码并规范化路径。
   *
   * 修复编码绕过：之前直接用未解码的 `req.path` 检查黑名单，
   * 攻击者可用 `%74rigger`（=trigger）、`%2F`（=/）等编码字符绕过黑名单，
   * 让请求携带内部 Token 到达 Python trigger 路由。
   *
   * 策略：
   * 1. 循环 `decodeURIComponent` 直至稳定（防御双重编码 `%252F` → `%2F` → `/`）。
   * 2. 解码失败（如 `%ZZ`）→ 返回 null，调用方 fail closed（403）。
   * 3. 折叠多余斜杠、去除尾部斜杠，统一比较基线。
   *
   * 注意：`req.path` 是 Express 基于挂载点剥离前缀后的路径，本身已不含 `/api/agent`。
   * Starlette（FastAPI 底层）会对路径做百分号解码（含 `%2F` → `/`），
   * 因此若不在代理层先行解码阻断，编码斜杠将在 Python 侧匹配到 trigger 路由。
   */
  const normalizePath = (rawPath: string): string | null => {
    let decoded = rawPath;
    // 循环解码：防御 %252F → %2F → / 的多重编码
    for (let i = 0; i < 3; i += 1) {
      let next: string;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        return null; // 非法百分号编码 → fail closed
      }
      if (next === decoded) break; // 已稳定，无更多编码
      decoded = next;
    }
    // 折叠重复斜杠并去除尾部斜杠（保留根路径）
    let normalized = decoded.replace(/\/+/g, '/').replace(/\/$/, '');
    if (normalized === '') normalized = '/';
    return normalized;
  };

  // 匹配 /briefing/<任意单段>/trigger 及其子路径。
  // 覆盖 morning/trigger、event/trigger 及未来新增的 trigger，避免逐条枚举遗漏。
  const TRIGGER_PATTERN = /^\/briefing\/[^/]+\/trigger(\/.*)?$/;
  // QA 编排只能由隔离环境内的回环调用，公开代理不得代为注入内部 Token。
  const QA_PATTERN = /^\/qa(?:\/.*)?$/;

  // 安全：禁止通过公开代理访问 briefing trigger 路径
  // 这些路径只能通过 Node 内部路由 /api/internal/trigger-morning-briefing 访问
  // （该路由校验 INTERNAL_API_TOKEN || INTERNAL_TOKEN 并转发给 Python）
  router.use((req: Request, res: Response, next: NextFunction) => {
    // 先安全解码并规范化，再判断：防止 %74rigger / %2F 等编码绕过
    const normalized = normalizePath(req.path);
    if (normalized === null) {
      // 解码失败：fail closed，禁止转发以避免绕过
      res.status(403).json({
        error: 'forbidden',
        message: 'malformed request path',
      });
      return;
    }
    if (TRIGGER_PATTERN.test(normalized) || QA_PATTERN.test(normalized)) {
      res.status(403).json({
        error: 'forbidden',
        message: 'internal-only paths are not accessible through public proxy',
      });
      return;
    }
    next();
  });

  /**
   * 创建上游请求并统一处理响应/错误/关闭（chat 路径与 pipe 路径共用，DRY）。
   * 返回 upstreamReq 供调用方决定 body 发送方式（end(buffer) 或 pipe）。
   */
  const createUpstreamRequest = (
    req: Request,
    res: Response,
    headers: http.OutgoingHttpHeaders,
    upstreamUrl: string,
  ): http.ClientRequest => {
    const upstreamReq = transport.request(upstreamUrl, { method: req.method, headers });

    upstreamReq.on('response', (upstreamRes: http.IncomingMessage) => {
      const status = upstreamRes.statusCode ?? 502;
      // 复制上游响应头，剔除 hop-by-hop；X-Request-ID 等业务头透传
      const respHeaders: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (HOP_BY_HOP_RESPONSE.has(key.toLowerCase())) continue;
        respHeaders[key] = value;
      }
      res.writeHead(status, respHeaders);
      // 直接 pipe：不缓冲，SSE chunk 实时透传
      upstreamRes.pipe(res);

      // 响应流中途断开（ECONNRESET / Python 崩溃 / socket 超时）：结束客户端响应，销毁上游
      upstreamRes.on('error', (err: NodeJS.ErrnoException) => {
        logError(err, { method: req.method, url: req.originalUrl });
        if (!res.writableEnded) res.end();
        if (!upstreamReq.destroyed) upstreamReq.destroy();
      });
    });

    const failWith502 = (err: NodeJS.ErrnoException): void => {
      logError(err, { method: req.method, url: req.originalUrl });
      if (res.headersSent) {
        // 响应已开始（流式中途出错）：无法改状态码，直接结束
        res.end();
        return;
      }
      res.status(502).json({
        code: 502,
        message: 'Agent service unavailable',
        error: err.code || err.message,
      });
    };

    upstreamReq.on('error', failWith502);

    // 客户端中途断开 → 中止上游请求，避免泄漏 socket。
    // 注意：必须监听 res 'close' 而非 req 'close'。req 'close' 在请求体读取完成时就会触发
    // （属于正常流程，并非断开信号），若据此 destroy upstreamReq 会把每个正常请求都中断 → ECONNRESET。
    // res 'close' 在响应流关闭时触发：此时若 writableEnded 仍为 false，才说明客户端提前断开。
    res.on('close', () => {
      if (!res.writableEnded && !upstreamReq.destroyed) upstreamReq.destroy();
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      logError(err, { method: req.method, url: req.originalUrl });
      if (!upstreamReq.destroyed) upstreamReq.destroy();
    });

    return upstreamReq;
  };

  /**
   * 读取请求体到 Buffer（chat 路径需要改写 body，不能直接 pipe）。
   * 大小上限 10MB，与 index.ts `express.json({ limit: '10mb' })` 对齐；超限返回 413（防内存耗尽 + 防客户端挂起）。
   */
  const collectRequestBody = (req: Request, res: Response, cb: (body: Buffer) => void): void => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > 10 * 1024 * 1024) {
        res.status(413).json({ code: 413, message: 'request body too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => cb(Buffer.concat(chunks)));
  };

  router.use((req: Request, res: Response) => {
    // P0：chat 路径鉴权。无 token 放行（user_id=None，保持"登录非必须"）；
    // 有 token 必须验签通过，否则 401（绝不透传非法 token 到上游）。
    const normalized = normalizePath(req.path);
    const isChatPath = normalized !== null && CHAT_PATHS.has(normalized);
    const authHeader = req.headers.authorization ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    let openid: string | null = null;
    if (isChatPath && bearer) {
      const payload = verifyJwt(bearer, options.jwtSecret);
      if (!payload) {
        res.status(401).json({ code: 401, message: 'unauthorized' });
        return;
      }
      openid = payload.openid;
    }

    // 复制客户端请求头，剔除 hop-by-hop，并注入 X-Internal-Token（覆写，防伪造）
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP_REQUEST.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers['x-internal-token'] = internalToken;

    // 转发原始路径（含 /api/agent 前缀 + query），与 Python 路由前缀一致 —— 不做路径重写
    const upstreamUrl = targetUrl.origin + req.originalUrl;

    if (isChatPath) {
      // P0：读 body → 覆写 user_id（openid 或 null，擦除客户端自报值）→ 转发。
      // content-length 需在创建请求前确定（Node http 创建后改 headers 不生效）。
      collectRequestBody(req, res, (body) => {
        let finalBody = body;
        const text = body.toString('utf8');
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            (parsed as Record<string, unknown>).user_id = openid;
            finalBody = Buffer.from(JSON.stringify(parsed), 'utf8');
          }
        } catch {
          // 非 JSON 体：原样转发（不破坏既有行为）
        }
        const finalHeaders: http.OutgoingHttpHeaders = { ...headers };
        finalHeaders['content-length'] = String(finalBody.length);
        const upstreamReq = createUpstreamRequest(req, res, finalHeaders, upstreamUrl);
        upstreamReq.end(finalBody);
      });
    } else {
      // 非 chat 路径：保持既有 pipe 原样转发（行为零变化）
      const upstreamReq = createUpstreamRequest(req, res, headers, upstreamUrl);
      req.pipe(upstreamReq);
    }
  });

  return router;
}

export default createAgentProxy;
