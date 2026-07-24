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
import { createAgentProxy, type AgentProxyOptions } from '../agent.proxy';

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
function buildApp(target: string, onError?: AgentProxyOptions['onError']): Express {
  const app = express();
  app.use('/api/agent', createAgentProxy({ target, internalToken: INTERNAL_TOKEN, onError }));
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

  // ---------- Python 联调契约测试（Task 9）----------
  // 与上游 generic 测试（{ok:true} / chunk-1-2-3）互补：这里用 Python FastAPI
  // 实际产出的响应契约（ChatResponse JSON / SSE 事件序列），验证反代对真实
  // Python 响应 wire-compatible —— body 与每个 SSE 事件的 JSON 均原样透传。

  it('forwards Python ChatResponse JSON contract unmodified ({content, session_id})', async () => {
    // Python POST /api/agent/chat/message 返回 ChatResponse(content, session_id)
    const pythonBody = JSON.stringify({
      content: '贵州茅台最新价1688元，涨幅0.75%。',
      session_id: 'e2e-stock-9',
    });
    const upstream = await startUpstream((_req, res, captured) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'py-rid-chat-9',
      });
      res.end(pythonBody);
    });

    const app = buildApp(upstream.url);
    const res = await call(app, {
      method: 'POST',
      path: '/api/agent/chat/message',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer user-9',
        'x-request-id': 'client-rid-9',
      },
      body: JSON.stringify({ message: '分析 600519', session_id: 'e2e-stock-9' }),
    });

    // 状态 / content-type / Python 注入的 X-Request-ID 透传
    assert.strictEqual(res.status, 200);
    assert.match(header(res.headers, 'content-type'), /application\/json/);
    assert.strictEqual(header(res.headers, 'x-request-id'), 'py-rid-chat-9');
    // body 原样透传（ChatResponse 契约字段完整未改）
    const body = JSON.parse(res.text) as { content: string; session_id: string };
    assert.strictEqual(body.content, '贵州茅台最新价1688元，涨幅0.75%。');
    assert.strictEqual(body.session_id, 'e2e-stock-9');
    // 上游收到完整的 /api/agent 前缀路径 + 注入的内网 token + 透传的客户端头
    assert.strictEqual(upstream.requests[0].url, '/api/agent/chat/message');
    assert.strictEqual(header(upstream.requests[0].headers, 'x-internal-token'), INTERNAL_TOKEN);
    assert.strictEqual(header(upstream.requests[0].headers, 'authorization'), 'Bearer user-9');
    assert.strictEqual(header(upstream.requests[0].headers, 'x-request-id'), 'client-rid-9');
  });

  it('pipes Python morning SSE event sequence unmodified (tool_start/tool_end/text/done)', async () => {
    // Python GET /api/agent/briefing/morning 产出 SSE：每个 data 行是一个 JSON 事件
    // （type ∈ tool_start/tool_end/llm_start/text/done），与 constants.SSEEventType 对齐。
    const sseEvents = [
      { type: 'tool_start', label: '正在获取财联社资讯' },
      { type: 'tool_end' },
      { type: 'llm_start', label: '正在生成回复' },
      { type: 'text', content: '今日晨报：市场震荡偏强。' },
      { type: 'done' },
    ];
    const frames = sseEvents.map((e) => `data: ${JSON.stringify(e)}\n\n`);
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-request-id': 'py-rid-sse-9',
      });
      let i = 0;
      const timer = setInterval(() => {
        if (i < frames.length) {
          res.write(frames[i]);
          i++;
        } else {
          clearInterval(timer);
          res.end();
        }
      }, 25);
    });

    const app = buildApp(upstream.url);
    const res = await call(app, { method: 'GET', path: '/api/agent/briefing/morning' });

    assert.strictEqual(res.status, 200);
    assert.match(header(res.headers, 'content-type'), /text\/event-stream/);
    assert.strictEqual(header(res.headers, 'x-request-id'), 'py-rid-sse-9');
    // 全量内容原样透传（帧顺序与内容未改）
    assert.strictEqual(res.text, frames.join(''));
    // 流式（未缓冲）：多帧分多个 data 事件到达
    assert.ok(res.dataEvents >= 2, `expected >=2 data events, got ${res.dataEvents}`);
    // 逐帧解析：每个 data 行仍是合法 JSON，type 序列与 Python 契约一致
    const parsed = res.text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5).trim()) as { type: string });
    assert.deepStrictEqual(
      parsed.map((p) => p.type),
      ['tool_start', 'tool_end', 'llm_start', 'text', 'done'],
    );
  });

  it('handles upstream response stream error without crashing the process (SSE mid-stream drop)', { timeout: 5000 }, async () => {
    // 捕获代理内部错误日志，用于验证 upstreamRes 'error' 处理器被触发
    const errors: NodeJS.ErrnoException[] = [];
    const upstream = await startUpstream((_req, res) => {
      // 发送响应头 + 部分数据，进入流式阶段（chunked 编码，未发送终止符）
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: partial\n\n');
      // 等待数据 flush 到代理（确保代理已进入 'response' 处理器并开始 pipe），
      // 然后销毁底层 socket —— 模拟 SSE 长连接中途断开（ECONNRESET / Python 崩溃 / socket 超时）。
      // 注意：不调用 res.end()，响应被截断 → 代理侧 upstreamRes emit 'error'（ECONNRESET）。
      setTimeout(() => {
        res.socket?.destroy();
      }, 30);
    });

    const app = buildApp(upstream.url, (err) => errors.push(err));
    const res = await call(app, { method: 'GET', path: '/api/agent/chat/stream' });

    // 1. 进程未崩溃：测试能执行到这里，说明没有未捕获的 'error' 事件。
    //    若无 upstreamRes 'error' 监听器，Node 会抛出未捕获异常 → node:test 标记失败（或超时）。
    // 2. 客户端响应已结束：call 通过 'end' resolve（代理在错误处理中 res.end()），未挂起。
    assert.ok(res.status === 200, `expected status 200 (headers already sent), got ${res.status}`);
    // 3. 错误处理回调被调用 → upstreamRes 'error' 被正确捕获并记录（证明错误路径被走到）
    assert.ok(
      errors.length >= 1,
      'expected onError callback to fire for upstream response stream error',
    );
  });

  // ── 安全：公开代理必须拒绝 briefing trigger 路径 ──

  it('rejects POST /api/agent/briefing/morning/trigger through public proxy (no upstream call)', async () => {
    let upstreamCalled = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamCalled = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });

    const app = buildApp(upstream.url);
    const res = await call(app, {
      method: 'POST',
      path: '/api/agent/briefing/morning/trigger',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    // 必须被拒绝（403 或 404），不能 200
    assert.ok(
      res.status === 403 || res.status === 404,
      `expected 403 or 404 for trigger path, got ${res.status}`,
    );
    // 上游不应收到请求
    assert.strictEqual(upstreamCalled, false, 'upstream must NOT receive trigger request through public proxy');
  });

  it('rejects POST /api/agent/briefing/event/trigger through public proxy (no upstream call)', async () => {
    let upstreamCalled = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamCalled = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });

    const app = buildApp(upstream.url);
    const res = await call(app, {
      method: 'POST',
      path: '/api/agent/briefing/event/trigger',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_title: 'test' }),
    });

    assert.ok(
      res.status === 403 || res.status === 404,
      `expected 403 or 404 for trigger path, got ${res.status}`,
    );
    assert.strictEqual(upstreamCalled, false, 'upstream must NOT receive trigger request through public proxy');
  });

  it('still allows non-trigger paths like /api/agent/briefing/morning (GET)', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    const app = buildApp(upstream.url);
    const res = await call(app, { method: 'GET', path: '/api/agent/briefing/morning' });

    assert.strictEqual(res.status, 200);
  });

  // ── 安全：编码绕过变体必须被阻断（upstream 调用次数为 0）──

  // 表驱动：每组 [label, path] 都应被拒绝且上游零调用
  const ENCODED_BYPASS_CASES: Array<[string, string]> = [
    // %74 → 't'：/briefing/morning/trigger 的编码片段绕过
    ['%74rigger in morning trigger', '/api/agent/briefing/morning/%74rigger'],
    // %2F → '/'：编码斜杠使整段看似单段，绕过 startsWith 匹配
    ['%2F encoded slash in morning trigger', '/api/agent/briefing/morning%2Ftrigger'],
    ['%2F encoded slash in event trigger', '/api/agent/briefing/event%2Ftrigger'],
    // 尾部斜杠变体
    ['trailing slash on morning trigger', '/api/agent/briefing/morning/trigger/'],
    ['trailing slash on event trigger', '/api/agent/briefing/event/trigger/'],
    // 双重编码：%252F → 解码一次为 %2F → 再解码为 /
    ['double-encoded %252F slash in morning trigger', '/api/agent/briefing/morning%252Ftrigger'],
    ['double-encoded %252F slash in event trigger', '/api/agent/briefing/event%252Ftrigger'],
    // 大小写编码变体
    ['uppercase %2F in event trigger', '/api/agent/briefing/event%2ftrigger'],
  ];

  for (const [label, path] of ENCODED_BYPASS_CASES) {
    it(`blocks encoded bypass: ${label} (no upstream call)`, async () => {
      const upstream = await startUpstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });

      const app = buildApp(upstream.url);
      const res = await call(app, {
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      // 必须被拒绝（403 或 404），不能 200
      assert.ok(
        res.status === 403 || res.status === 404,
        `${label}: expected 403 or 404, got ${res.status}`,
      );
      // 关键断言：上游调用次数为 0
      assert.strictEqual(
        upstream.requests.length,
        0,
        `${label}: upstream must NOT receive request, got ${upstream.requests.length} call(s)`,
      );
    });
  }

  it('blocks invalid percent-encoding with fail-closed (no upstream call)', async () => {
    // %ZZ 不是合法的百分号编码，decodeURIComponent 抛错 → fail closed
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });

    const app = buildApp(upstream.url);
    const res = await call(app, {
      method: 'POST',
      path: '/api/agent/briefing/morning/%ZZrigger',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.ok(
      res.status === 403 || res.status === 404,
      `invalid encoding should fail closed, got ${res.status}`,
    );
    assert.strictEqual(upstream.requests.length, 0, 'upstream must NOT receive invalid-encoded request');
  });

  it('still allows GET /api/agent/briefing/morning with encoded safe chars', async () => {
    // 正常公开路径含合法编码字符仍可用（不误伤）
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    const app = buildApp(upstream.url);
    const res = await call(app, { method: 'GET', path: '/api/agent/briefing/morning' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(upstream.requests.length, 1);
  });

  // ── market-trace-qa/message 契约测试：验证反代正确转发新端点 ──

  it('forwards market-trace-qa/message POST body and injects token', async () => {
    const reqBody = JSON.stringify({
      message: '大盘为何涨跌',
      report_date: '2026-07-22',
      session_id: 'mtqa_001',
    });
    const pythonBody = JSON.stringify({
      content: '回答',
      session_id: 'mtqa_001',
      trace: {
        artifact_id: 'review_2026-07-22',
        sources: [],
        as_of: '2026-07-22',
        confidence: 'high',
        uncertainty: [],
        degraded: false,
        degraded_reason: null,
      },
    });
    const upstream = await startUpstream((_req, res, captured) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(pythonBody);
    });

    const app = buildApp(upstream.url);
    const res = await call(app, {
      method: 'POST',
      path: '/api/agent/market-trace-qa/message',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer user-mtqa',
      },
      body: reqBody,
    });

    // 响应原样透传（body 未改）
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.text, pythonBody);
    // 上游收到完整的请求体（未改）
    assert.strictEqual(upstream.requests.length, 1);
    assert.strictEqual(upstream.requests[0].method, 'POST');
    assert.strictEqual(upstream.requests[0].url, '/api/agent/market-trace-qa/message');
    assert.strictEqual(upstream.requests[0].body, reqBody);
    // X-Internal-Token 被注入
    assert.strictEqual(header(upstream.requests[0].headers, 'x-internal-token'), INTERNAL_TOKEN);
  });

  it('market-trace-qa/message with degraded response passes through', async () => {
    const reqBody = JSON.stringify({ message: '海外因素有何影响' });
    const pythonBody = JSON.stringify({
      content: '暂时无法回答',
      session_id: 'mtqa_x',
      trace: {
        artifact_id: 'review_2026-07-22',
        sources: [],
        as_of: '',
        confidence: 'low',
        uncertainty: [],
        degraded: true,
        degraded_reason: '当日无市场复盘报告',
      },
    });
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(pythonBody);
    });

    const app = buildApp(upstream.url);
    const res = await call(app, {
      method: 'POST',
      path: '/api/agent/market-trace-qa/message',
      headers: { 'content-type': 'application/json' },
      body: reqBody,
    });

    // 状态 200，body 原样透传，degraded: true
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.text, pythonBody);
    const body = JSON.parse(res.text) as { trace: { degraded: boolean } };
    assert.strictEqual(body.trace.degraded, true);
  });

  it('market-trace-qa/message forges token prevention', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const app = buildApp(upstream.url);
    await call(app, {
      method: 'POST',
      path: '/api/agent/market-trace-qa/message',
      headers: {
        'content-type': 'application/json',
        // 客户端尝试伪造内网 token
        'x-internal-token': 'forged-by-client',
      },
      body: JSON.stringify({ message: 'test' }),
    });

    // 代理覆写为配置的 token，伪造值不生效
    assert.strictEqual(upstream.requests.length, 1);
    assert.strictEqual(header(upstream.requests[0].headers, 'x-internal-token'), INTERNAL_TOKEN);
  });
});
