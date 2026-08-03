/**
 * Task 4: GET /internal/news/telegraph 路由测试
 *
 * 测试策略（适配 Node 原生 test runner，非 jest）：
 * 1. 启动 Express HTTP 服务器（随机端口），挂载 internalRouter 于 /internal 前缀
 * 2. Monkey-patch ClsStockNewsService.fetchTelegraphByDate 静态方法（class 属性可变，
 *    非 module namespace getter；与 internalRoutes.test.ts 同一约定）
 * 3. 测试 200 成功路径 + 鉴权（携带 X-Internal-Token）
 *
 * 资源清理：internalRouter 依赖 PG pool / Redis / keepAlive HTTP agents，
 * 测试结束后显式关闭让进程自然退出。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { after, before } from 'node:test'
import express from 'express'

import internalRouter from '../../src/core/routes/internal'
import { ClsStockNewsService } from '../../src/modules/monitor/ClsStockNewsService'
import pool from '../../src/core/db'
import redis from '../../src/core/redis'
import { closeAllAgents } from '../../src/shared/utils/httpAgent'

// 与 internal.ts 中 verifyInternalToken 使用相同的 token 读取逻辑
const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production'

interface HttpResponse {
    status: number
    body: unknown
}

function makeGetRequest(port: number, path: string, token?: string): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {}
        if (token !== undefined) {
            headers['x-internal-token'] = token
        }
        const req = http.get(
            { hostname: '127.0.0.1', port, path, headers },
            (res) => {
                let data = ''
                res.on('data', (chunk: Buffer) => (data += chunk.toString()))
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode || 0, body: JSON.parse(data) })
                    } catch {
                        resolve({ status: res.statusCode || 0, body: data })
                    }
                })
            },
        )
        req.on('error', reject)
    })
}

let server: http.Server
let port: number

before(async () => {
    const app = express()
    app.use('/internal', internalRouter)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    port = (server.address() as AddressInfo).port
})

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.end()
    redis.disconnect()
    await closeAllAgents()
})

test('GET /internal/news/telegraph 返回指定日期电报', async () => {
    // Monkey-patch fetchTelegraphByDate 返回固定 mock 数据
    const originalFetch = ClsStockNewsService.fetchTelegraphByDate
    const mockResult = {
        date: '2026-08-02',
        items: [
            {
                id: 1,
                title: '电报1',
                content: '内容1',
                time: '2026-08-02 10:00:00',
                timestamp: 1785636000,
            },
        ],
        total: 1,
        degraded: false,
    }
    ;(ClsStockNewsService as unknown as { fetchTelegraphByDate: unknown }).fetchTelegraphByDate =
        async () => mockResult

    try {
        const res = await makeGetRequest(
            port,
            '/internal/news/telegraph?date=2026-08-02&limit=200',
            INTERNAL_TOKEN,
        )

        assert.equal(res.status, 200)
        const body = res.body as Record<string, unknown>
        assert.equal(body.code, 200)
        const data = body.data as Record<string, unknown>
        assert.equal(data.date, '2026-08-02')
        const items = data.items as unknown[]
        assert.equal(items.length, 1)
    } finally {
        ;(ClsStockNewsService as unknown as { fetchTelegraphByDate: unknown }).fetchTelegraphByDate =
            originalFetch
    }
})

test('GET /internal/news/telegraph 拒绝无效日期', async () => {
    const res = await makeGetRequest(
        port,
        '/internal/news/telegraph?date=invalid',
        INTERNAL_TOKEN,
    )

    assert.equal(res.status, 400)
    const body = res.body as Record<string, unknown>
    assert.equal(body.code, 400)
})

test('GET /internal/news/telegraph 拒绝无 token', async () => {
    const res = await makeGetRequest(port, '/internal/news/telegraph?date=2026-08-02')

    assert.equal(res.status, 403)
})
