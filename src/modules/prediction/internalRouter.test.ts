/**
 * Task 4: /internal/predictions 路由测试（适配 Node 原生 test runner）
 *
 * 测试策略（对齐 src/core/routes/internal.index-quotes.test.ts 组装方式）：
 * 1. 启动 Express HTTP 服务器（随机端口），挂载 predictionInternalRouter 于 /internal/predictions
 * 2. 直接验证路由层输入校验与 403 鉴权（Service 层 DB 逻辑由人工 + 服务器部署验证兜底）
 * 3. 不设置 process.env.INTERNAL_API_TOKEN；token 与路由模块同表达式解析
 *    （process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production'）
 * 4. 覆盖 403（无 token）/ 400（缺必填字段）/ 400（非法 verification result）/ 400（不支持的 status 过滤）
 *
 * 资源清理：internalRouter 依赖 PG pool（PredictionRecordService → ../../core/db），
 * 测试结束后显式关闭 server 与 pool 让进程自然退出。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { after, before } from 'node:test'
import express from 'express'

import predictionInternalRouter from './internalRouter'
import pool from '../../core/db'

// 与 internalRouter.ts 使用相同的 token 读取逻辑（模块加载期常量）
const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production'

interface HttpResponse {
    status: number
    body: unknown
}

/** 统一 JSON 请求助手：method/body 均可变；不传 token 则不带 x-internal-token 头 */
function makeJsonRequest(
    port: number,
    method: string,
    path: string,
    token: string | undefined,
    body?: unknown,
): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body)
        const headers: Record<string, string> = {}
        if (token !== undefined) {
            headers['x-internal-token'] = token
        }
        if (payload !== undefined) {
            headers['content-type'] = 'application/json'
        }
        const req = http.request(
            { hostname: '127.0.0.1', port, path, method, headers },
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
        if (payload !== undefined) {
            req.write(payload)
        }
        req.end()
    })
}

let server: http.Server
let port: number

before(async () => {
    const app = express()
    app.use(express.json())
    app.use('/internal/predictions', predictionInternalRouter)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    port = (server.address() as AddressInfo).port
})

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.end()
})

test('POST /internal/predictions without internal token -> 403', async () => {
    const res = await makeJsonRequest(port, 'POST', '/internal/predictions', undefined, {})

    assert.equal(res.status, 403)
    const body = res.body as { code: number }
    assert.equal(body.code, 403)
})

test('POST /internal/predictions missing required fields -> 400', async () => {
    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions',
        INTERNAL_TOKEN,
        { source_type: 'market_trace' },
    )

    assert.equal(res.status, 400)
    const body = res.body as { code: number }
    assert.equal(body.code, 400)
})

test('PUT /internal/predictions/1/verification invalid result -> 400', async () => {
    const res = await makeJsonRequest(
        port,
        'PUT',
        '/internal/predictions/1/verification',
        INTERNAL_TOKEN,
        { horizon: 'mid', result: 'maybe' },
    )

    assert.equal(res.status, 400)
    const body = res.body as { code: number }
    assert.equal(body.code, 400)
})

test('GET /internal/predictions?status=all -> 400 (unsupported status filter)', async () => {
    const res = await makeJsonRequest(
        port,
        'GET',
        '/internal/predictions?status=all',
        INTERNAL_TOKEN,
    )

    assert.equal(res.status, 400)
    const body = res.body as { code: number }
    assert.equal(body.code, 400)
})
