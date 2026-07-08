/**
 * Agent 反向代理测试
 *
 * 用真实本地 HTTP 服务器模拟 Python FastAPI 上游，验证：
 * 1. JSON 转发：路径保留（含 /api/agent 前缀 + query）、X-Internal-Token 注入、
 *    Authorization / X-Request-ID 透传、响应头（X-Request-ID）回传。
 * 2. SSE 流式透传：content-type=text/event-stream，多个 chunk 分别到达（未缓冲）。
 * 3. 502 错误：上游不可达（ECONNREFUSED）→ 502 + JSON。
 *
 * 运行：`npm test`（= `node --import tsx --test <本文件>`）。
 * 不引入 jest/vitest —— 用 Node 内置 node:test + node:assert，零新增依赖（tsx 已是 devDep）。
 * 测试不导入 src/index（会触发 start() 连 DB/Redis），仅用最小 Express app 挂载反代。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import { createAgentProxy } from '../agent.proxy';

const INTERNAL_TOKEN = 'test-internal-token-xyz';

interface UpstreamRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface CallResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  /** 收到 'data' 事件的次数 —— 用于判断 SSE 是否被缓冲（缓冲则=1，流式则>1） */
  dataEvents: number;
}

/** 安全提取单个 string header 值 */
function header(h: http.IncomingHttpHeaders, name: string): string {
  const v = h[name];
  return Array.isArray(v) ? (v[0] ?? '') : v ?? '';
}

// ---------- 上游 mock 服务器 ----------
const trackedServers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(trackedServers.splice(0).map(closeServer));
});

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, captured: UpstreamRequest) => void,
): Promise<{ server: http.Server; url: string; requests: UpstreamRequest[] }> {
  const requests: UpstreamRequest[] = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const captured: UpstreamRequest = {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        requests.push(captured);
        handler(req, res, captured);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      trackedServers.push(server);
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, requests });
    });
  });
}

// ---------- 被测 Express app（仅挂载反代） ----------
function buildApp(target: string): Express {
  const app = express();
  app.use('/api/agent', createAgentProxy({ target, internalToken: INTERNAL_TOKEN }));
  return app;
}

// ---------- 发起请求并收集响应 ----------
function call(
  app: Express,
  opts: { method: string; path: string; headers?: http.OutgoingHttpHeaders; body?: string },
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const req = http.request(
        {
          method: opts.method,
          hostname: '127.0.0.1',
          port: addr.port,
          path: opts.path,
          headers: opts.headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let dataEvents = 0;
          res.on('data', (c: Buffer) => {
            chunks.push(c);
            dataEvents++;
          });
          res.on('end', () => {
            server.close();
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString('utf8'),
              dataEvents,
            });
          });
          res.on('error', (err) => {
            server.close();
            reject(err);
          });
        },
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (opts.body) req.write(opts.body);
      req.end();
    });
    server.on('error', reject);
  });
}

/** 占用一个端口后立即释放，得到一个“几乎必然不可达”的端口用于 502 测试 */
function getUnusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// ==================== 测试用例 ====================

describe('Agent reverse proxy', () => {
  it('forwards JSON requests, preserves path, injects X-Internal-Token, passes through headers', async () => {
    const upstream = await startUpstream((_req, res, captured) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'rid-from-python',
      });
      res.end(JSON.stringify({ ok: true, receivedPath: captured.url, receivedBody: captured.body }));
    });

    const app = buildApp(upstream.url);
    const res = await call(app, {
      method: 'POST',
      path: '/api/agent/chat/message?session=1',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer user-token',
        'x-request-id': 'rid-from-client',
      },
      body: JSON.stringify({ message: 'hello' }),
    });

    // 响应
    assert.strictEqual(res.status, 200);
    assert.match(header(res.headers, 'content-type'), /application\/json/);
    // 响应头透传（Task 5：Python 注入的 X-Request-ID 回传给前端）
    assert.strictEqual(header(res.headers, 'x-request-id'), 'rid-from-python');
    const body = JSON.parse(res.text) as { ok: boolean; receivedPath: string; receivedBody: string };
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.receivedBody, JSON.stringify({ message: 'hello' }));

    // 上游收到的请求：路径保留 /api/agent 前缀 + query（未做路径重写）
    assert.strictEqual(upstream.requests.length, 1);
    const captured = upstream.requests[0];
    assert.strictEqual(captured.method, 'POST');
    assert.strictEqual(captured.url, '/api/agent/chat/message?session=1');
    // X-Internal-Token 被注入
    assert.strictEqual(header(captured.headers, 'x-internal-token'), INTERNAL_TOKEN);
    // Authorization / X-Request-ID / Content-Type 透传
    assert.strictEqual(header(captured.headers, 'authorization'), 'Bearer user-token');
    assert.strictEqual(header(captured.headers, 'x-request-id'), 'rid-from-client');
    assert.strictEqual(header(captured.headers, 'content-type'), 'application/json');
  });

  it('pipes SSE stream without buffering (multiple data events, text/event-stream)', async () => {
    const frames = ['data: chunk-1\n\n', 'data: chunk-2\n\n', 'data: chunk-3\n\n'];
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-request-id': 'sse-rid-9',
      });
      // 每帧间隔 30ms：若反代缓冲，客户端只会在流结束后收到 1 个 data 事件
      let i = 0;
      const timer = setInterval(() => {
        if (i < frames.length) {
          res.write(frames[i]);
          i++;
        } else {
          clearInterval(timer);
          res.end();
        }
      }, 30);
    });

    const app = buildApp(upstream.url);
    const res = await call(app, { method: 'GET', path: '/api/agent/briefing/morning' });

    assert.strictEqual(res.status, 200);
    assert.match(header(res.headers, 'content-type'), /text\/event-stream/);
    assert.strictEqual(header(res.headers, 'x-request-id'), 'sse-rid-9');
    // 全量内容拼接正确
    assert.strictEqual(res.text, frames.join(''));
    // 关键断言：收到多个 data 事件 → 反代未缓冲（缓冲则全部在 end 后一次性到达 = 1）
    assert.ok(
      res.dataEvents >= 2,
      `expected >=2 data events (unbuffered streaming), got ${res.dataEvents}`,
    );
  });

  it('returns 502 with JSON error when Python service is unreachable (ECONNREFUSED)', async () => {
    const port = await getUnusedPort();
    const app = buildApp(`http://127.0.0.1:${port}`);

    const res = await call(app, {
      method: 'POST',
      path: '/api/agent/chat/message',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });

    assert.strictEqual(res.status, 502);
    const body = JSON.parse(res.text) as { code: number; message: string; error: string };
    assert.strictEqual(body.code, 502);
    assert.strictEqual(body.message, 'Agent service unavailable');
    assert.match(body.error, /ECONNREFUSED|connect|ECONNRESET/);
  });

  it('forwards GET with query string preserved', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url }));
    });

    const app = buildApp(upstream.url);
    const res = await call(app, { method: 'GET', path: '/api/agent/skills?lang=zh' });

    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.text) as { path: string };
    assert.strictEqual(body.path, '/api/agent/skills?lang=zh');
  });

  it('overwrites client-supplied X-Internal-Token (not forgeable)', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const app = buildApp(upstream.url);
    await call(app, {
      method: 'POST',
      path: '/api/agent/chat/message',
      headers: {
        'content-type': 'application/json',
        // 客户端尝试伪造内网 token
        'x-internal-token': 'forged-by-client',
      },
      body: '{}',
    });

    assert.strictEqual(upstream.requests.length, 1);
    // 代理覆写为配置的 token，伪造值不生效
    assert.strictEqual(header(upstream.requests[0].headers, 'x-internal-token'), INTERNAL_TOKEN);
  });

  it('forwards upstream non-200 status (e.g. 403) to the client', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Forbidden' }));
    });

    const app = buildApp(upstream.url);
    const res = await call(app, { method: 'POST', path: '/api/agent/chat/message', body: '{}' });

    assert.strictEqual(res.status, 403);
    assert.ok(res.text.includes('Forbidden'));
  });
});
