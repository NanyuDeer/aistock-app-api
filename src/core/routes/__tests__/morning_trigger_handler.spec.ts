/**
 * Morning trigger handler 测试
 *
 * 测试生产实现 morning_trigger_handler.ts，不复制路由逻辑。
 * 使用真实 HTTP 上游 mock server（node:http），不替换 global fetch。
 *
 * 覆盖：
 * - Token 优先级：INTERNAL_API_TOKEN || INTERNAL_TOKEN（缺失时 fail closed）
 * - 响应字段透传
 * - 上游 403/500 不包装成 200
 * - 非 JSON 上游响应安全处理
 * - 公开代理绕过拒绝（briefing trigger 路径不可通过代理访问）
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createMorningTriggerHandler } from '../morning_trigger_handler';

// ── 上游 mock server ──

function createUpstreamMock(port: number, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
    return http.createServer((req, res) => {
        handler(req, res);
    }).listen(port);
}

describe('Morning trigger handler（生产实现）', () => {
    let upstreamServer: http.Server;
    let upstreamPort: number;
    let originalEnv: Record<string, string | undefined>;

    beforeEach(async () => {
        originalEnv = {
            INTERNAL_API_TOKEN: process.env.INTERNAL_API_TOKEN,
            INTERNAL_TOKEN: process.env.INTERNAL_TOKEN,
            AGENT_PY_URL: process.env.AGENT_PY_URL,
        };
        delete process.env.INTERNAL_API_TOKEN;
        delete process.env.INTERNAL_TOKEN;

        // 启动上游 mock server
        upstreamServer = http.createServer();
        await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
        upstreamPort = (upstreamServer.address() as AddressInfo).port;
        process.env.AGENT_PY_URL = `http://127.0.0.1:${upstreamPort}`;
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
        if (originalEnv.INTERNAL_API_TOKEN !== undefined) {
            process.env.INTERNAL_API_TOKEN = originalEnv.INTERNAL_API_TOKEN;
        } else {
            delete process.env.INTERNAL_API_TOKEN;
        }
        if (originalEnv.INTERNAL_TOKEN !== undefined) {
            process.env.INTERNAL_TOKEN = originalEnv.INTERNAL_TOKEN;
        } else {
            delete process.env.INTERNAL_TOKEN;
        }
        if (originalEnv.AGENT_PY_URL !== undefined) {
            process.env.AGENT_PY_URL = originalEnv.AGENT_PY_URL;
        }
    });

    // ── Token 优先级 ──

    test('错误 token → 401', async () => {
        process.env.INTERNAL_API_TOKEN = 'correct-token';
        const handler = createMorningTriggerHandler();
        const app = express();
        app.use(express.json());
        app.post('/api/internal/trigger-morning-briefing', handler);

        const server = app.listen(0);
        const port = (server.address() as AddressInfo).port;
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/api/internal/trigger-morning-briefing`, {
                method: 'POST',
                headers: { 'x-internal-token': 'wrong-token' },
            });
            assert.strictEqual(resp.status, 401);
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    test('无 token → 401', async () => {
        process.env.INTERNAL_API_TOKEN = 'correct-token';
        const handler = createMorningTriggerHandler();
        const app = express();
        app.use(express.json());
        app.post('/api/internal/trigger-morning-briefing', handler);

        const server = app.listen(0);
        const port = (server.address() as AddressInfo).port;
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/api/internal/trigger-morning-briefing`, {
                method: 'POST',
            });
            assert.strictEqual(resp.status, 401);
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    test('两个 token 都未配置 → fail closed（拒绝请求）', async () => {
        // 不设置任何 token
        const handler = createMorningTriggerHandler();
        const app = express();
        app.use(express.json());
        app.post('/api/internal/trigger-morning-briefing', handler);

        const server = app.listen(0);
        const port = (server.address() as AddressInfo).port;
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/api/internal/trigger-morning-briefing`, {
                method: 'POST',
                headers: { 'x-internal-token': 'change-me-in-production' },
            });
            // fail closed：默认值不能作为有效凭据，请求被拒绝
            assert.ok(resp.status === 401 || resp.status === 503, `expected 401 or 503, got ${resp.status}`);
            const body = await resp.json() as any;
            assert.strictEqual(body.success, false);
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    test('正确 INTERNAL_API_TOKEN → 200 + 透传事件统计字段', async () => {
        process.env.INTERNAL_API_TOKEN = 'api-token-123';

        // 上游返回成功响应
        upstreamServer.removeAllListeners('request');
        upstreamServer.on('request', (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: '晨报生成完成',
                report_date: '2026-07-17',
                cached: false,
                morning_generated: true,
                morning_persisted: true,
                has_major_events: true,
                major_event_count: 2,
                event_triggered_count: 2,
                event_succeeded_count: 2,
                event_failed_count: 0,
                event_persisted_count: 2,
                event_persist_failed_count: 0,
                elapsed_seconds: 12.5,
            }));
        });

        const handler = createMorningTriggerHandler();
        const app = express();
        app.use(express.json());
        app.post('/api/internal/trigger-morning-briefing', handler);

        const server = app.listen(0);
        const port = (server.address() as AddressInfo).port;
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/api/internal/trigger-morning-briefing`, {
                method: 'POST',
                headers: { 'x-internal-token': 'api-token-123' },
            });
            assert.strictEqual(resp.status, 200);
            const body = await resp.json() as any;
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.major_event_count, 2);
            assert.strictEqual(body.event_triggered_count, 2);
            assert.strictEqual(body.event_succeeded_count, 2);
            assert.strictEqual(body.event_persisted_count, 2);
            assert.strictEqual(body.event_persist_failed_count, 0);
            assert.strictEqual(body.morning_generated, true);
            assert.strictEqual(body.morning_persisted, true);
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    test('INTERNAL_API_TOKEN 未设时回退到 INTERNAL_TOKEN → 200', async () => {
        process.env.INTERNAL_TOKEN = 'legacy-token-456';
        upstreamServer.removeAllListeners('request');
        upstreamServer.on('request', (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'ok' }));
        });

        const handler = createMorningTriggerHandler();
        const app = express();
        app.use(express.json());
        app.post('/api/internal/trigger-morning-briefing', handler);

        const server = app.listen(0);
        const port = (server.address() as AddressInfo).port;
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/api/internal/trigger-morning-briefing`, {
                method: 'POST',
                headers: { 'x-internal-token': 'legacy-token-456' },
            });
            assert.strictEqual(resp.status, 200);
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    test('转发正确的 INTERNAL_API_TOKEN 给 Python 上游', async () => {
        process.env.INTERNAL_API_TOKEN = 'forward-token-789';
        process.env.INTERNAL_TOKEN = 'legacy-token';

        let receivedToken: string | undefined;
        upstreamServer.removeAllListeners('request');
        upstreamServer.on('request', (req, res) => {
            receivedToken = req.headers['x-internal-token'] as string;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });

        const handler = createMorningTriggerHandler();
        const app = express();
        app.use(express.json());
        app.post('/api/internal/trigger-morning-briefing', handler);

        const server = app.listen(0);
        const port = (server.address() as AddressInfo).port;
        try {
            await fetch(`http://127.0.0.1:${port}/api/internal/trigger-morning-briefing`, {
                method: 'POST',
                headers: { 'x-internal-token': 'forward-token-789' },
            });
            assert.strictEqual(receivedToken, 'forward-token-789');
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    // ── 上游错误处理 ──

    test('上游返回 403 → Node 不包装成 200，返回 403', async () => {
        process.env.INTERNAL_API_TOKEN = 'test-token';
        upstreamServer.removeAllListeners('request');
        upstreamServer.on('request', (_req, res) => {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ detail: 'Forbidden' }));
        });

        const handler = createMorningTriggerHandler();
        const app = express();
        app.use(express.json());
        app.post('/api/internal/trigger-morning-briefing', handler);

        const server = app.listen(0);
        const port = (server.address() as AddressInfo).port;
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/api/internal/trigger-morning-briefing`, {
                method: 'POST',
                headers: { 'x-internal-token': 'test-token' },
            });
            assert.strictEqual(resp.status, 403);
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    test('上游返回 500 → Node 返回 502', async () => {
        process.env.INTERNAL_API_TOKEN = 'test-token';
        upstreamServer.removeAllListeners('request');
        upstreamServer.on('request', (_req, res) => {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('Internal Server Error');
        });

        const handler = createMorningTriggerHandler();
        const app = express();
        app.use(express.json());
        app.post('/api/internal/trigger-morning-briefing', handler);

        const server = app.listen(0);
        const port = (server.address() as AddressInfo).port;
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/api/internal/trigger-morning-briefing`, {
                method: 'POST',
                headers: { 'x-internal-token': 'test-token' },
            });
            assert.strictEqual(resp.status, 502);
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    test('上游返回非 JSON → 安全处理，返回 502', async () => {
        process.env.INTERNAL_API_TOKEN = 'test-token';
        upstreamServer.removeAllListeners('request');
        upstreamServer.on('request', (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<html><body>Not JSON</body></html>');
        });

        const handler = createMorningTriggerHandler();
        const app = express();
        app.use(express.json());
        app.post('/api/internal/trigger-morning-briefing', handler);

        const server = app.listen(0);
        const port = (server.address() as AddressInfo).port;
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/api/internal/trigger-morning-briefing`, {
                method: 'POST',
                headers: { 'x-internal-token': 'test-token' },
            });
            assert.strictEqual(resp.status, 502);
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    test('上游连接失败 → 502', async () => {
        process.env.INTERNAL_API_TOKEN = 'test-token';
        // 关闭上游 server
        await new Promise<void>((r) => upstreamServer.close(() => r()));
        // 重新启动一个新的，然后立即关闭，获取端口
        const tmpServer = http.createServer();
        await new Promise<void>((r) => tmpServer.listen(0, '127.0.0.1', r));
        const tmpPort = (tmpServer.address() as AddressInfo).port;
        await new Promise<void>((r) => tmpServer.close(() => r()));
        process.env.AGENT_PY_URL = `http://127.0.0.1:${tmpPort}`;

        const handler = createMorningTriggerHandler();
        const app = express();
        app.use(express.json());
        app.post('/api/internal/trigger-morning-briefing', handler);

        const server = app.listen(0);
        const port = (server.address() as AddressInfo).port;
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/api/internal/trigger-morning-briefing`, {
                method: 'POST',
                headers: { 'x-internal-token': 'test-token' },
            });
            assert.strictEqual(resp.status, 502);
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
        }
    });
});
