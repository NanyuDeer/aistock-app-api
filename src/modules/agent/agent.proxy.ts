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

export interface AgentProxyOptions {
  /** Python FastAPI 基地址，例如 `http://localhost:8000` */
  target: string;
  /** 注入到上游请求的 `X-Internal-Token` 值（Python 侧 `internal_api_token`） */
  internalToken: string;
  /** 连接/响应错误时的日志回调，默认 `console.error` */
  onError?: (err: NodeJS.ErrnoException, context: { method: string; url: string }) => void;
}

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

  router.use((req: Request, res: Response, _next: NextFunction) => {
    // 复制客户端请求头，剔除 hop-by-hop，并注入 X-Internal-Token（覆写，防伪造）
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP_REQUEST.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers['x-internal-token'] = internalToken;

    // 转发原始路径（含 /api/agent 前缀 + query），与 Python 路由前缀一致 —— 不做路径重写
    const upstreamUrl = targetUrl.origin + req.originalUrl;

    const upstreamReq = transport.request(upstreamUrl, {
      method: req.method,
      headers,
    });

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

      // 响应流错误处理：Node 的 pipe() 不会把源流的 'error' 转发到目标流，
      // 也不会在源流出错时结束目标流。若上游连接在流式中途断开
      // （ECONNRESET / socket 超时 / Python 在长 SSE 连接中崩溃），upstreamRes 会 emit 'error'。
      // 若无监听器，Node 视为未捕获异常并抛出 → 整个 API 进程崩溃。
      // 注意：upstreamReq.on('error', failWith502) 只覆盖连接/请求阶段错误；
      // 进入响应阶段后 socket 错误由 upstreamRes 而非 upstreamReq emit（已通过调试脚本验证）。
      upstreamRes.on('error', (err: NodeJS.ErrnoException) => {
        logError(err, { method: req.method, url: req.originalUrl });
        // 结束客户端响应，避免前端连接挂起（此时 writeHead 已发送，无法再改状态码）
        if (!res.writableEnded) {
          res.end();
        }
        // 销毁上游请求，释放 socket
        if (!upstreamReq.destroyed) {
          upstreamReq.destroy();
        }
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
      if (!res.writableEnded && !upstreamReq.destroyed) {
        upstreamReq.destroy();
      }
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      logError(err, { method: req.method, url: req.originalUrl });
      if (!upstreamReq.destroyed) upstreamReq.destroy();
    });

    // 原始请求体直接 pipe 到上游（未经 express.json 消费）
    req.pipe(upstreamReq);
  });

  return router;
}

export default createAgentProxy;
