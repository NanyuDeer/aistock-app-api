/**
 * Task 5 (P5 D41): GET /internal/quote/:symbol/kline 路由测试
 *
 * 测试策略（适配 Node 原生 test runner，对齐 tests/routes/internal.telegraph.test.ts）：
 * 1. 启动 Express HTTP 服务器（随机端口），挂载 internalRouter 于 /internal 前缀
 * 2. Monkey-patch TushareKlineService.getKLine 静态方法（class 属性可变，
 *    与 internal.telegraph.test.ts 同一约定）
 * 3. 覆盖 200 成功形状 + 400 校验（symbol / days / klt）+ 502 服务异常
 *
 * 资源清理：internalRouter 依赖 PG pool / Redis / keepAlive HTTP agents，
 * 测试结束后显式关闭让进程自然退出。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { after, before } from 'node:test'
import express from 'express'

import internalRouter from './internal'
import { TushareKlineService } from '../../modules/quote/TushareKlineService'
import pool from '../db'
import redis from '../redis'
import { closeAllAgents } from '../../shared/utils/httpAgent'

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

/** 临时替换 TushareKlineService.getKLine 静态方法（与既有 internal 测试同款 patch 风格） */
function patchGetKLine(impl: (() => Promise<unknown>) | null): void {
    ;(TushareKlineService as unknown as { getKLine: unknown }).getKLine = impl
        ? async () => impl()
        : undefined
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

test('GET /internal/quote/600519/kline?days=30 -> 200 rows', async () => {
    const originalGetKLine = (TushareKlineService as unknown as { getKLine: unknown }).getKLine
    patchGetKLine(async () => [
        { trade_date: '2026-08-01', open: 1, high: 2, low: 0.5, close: 1.5, pct_chg: 1.2 },
    ])

    try {
        const res = await makeGetRequest(
            port,
            '/internal/quote/600519/kline?days=30',
            INTERNAL_TOKEN,
        )

        assert.equal(res.status, 200)
        const body = res.body as Record<string, unknown>
        assert.equal(body.code, 200)
        const data = body.data as Record<string, unknown>
        assert.equal(data.symbol, '600519')
        assert.equal(data.klt, 101)
        assert.equal(data.days, 1)
        const rows = data.rows as Array<Record<string, unknown>>
        assert.equal(rows.length, 1)
        assert.deepEqual(rows[0], {
            trade_date: '2026-08-01',
            open: 1,
            high: 2,
            low: 0.5,
            close: 1.5,
            pct_chg: 1.2,
        })
    } finally {
        ;(TushareKlineService as unknown as { getKLine: unknown }).getKLine = originalGetKLine
    }
})

test('GET /internal/quote/abc/kline -> 400', async () => {
    const res = await makeGetRequest(port, '/internal/quote/abc/kline', INTERNAL_TOKEN)

    assert.equal(res.status, 400)
    const body = res.body as Record<string, unknown>
    assert.equal(body.code, 400)
})

test('GET /internal/quote/600519/kline?days=999 -> 400', async () => {
    const res = await makeGetRequest(port, '/internal/quote/600519/kline?days=999', INTERNAL_TOKEN)

    assert.equal(res.status, 400)
    const body = res.body as Record<string, unknown>
    assert.equal(body.code, 400)
})

test('GET /internal/quote/600519/kline?klt=5 -> 400', async () => {
    const res = await makeGetRequest(port, '/internal/quote/600519/kline?klt=5', INTERNAL_TOKEN)

    assert.equal(res.status, 400)
    const body = res.body as Record<string, unknown>
    assert.equal(body.code, 400)
})

test('GET /internal/quote/600519/kline -> 502 when service throws', async () => {
    const originalGetKLine = (TushareKlineService as unknown as { getKLine: unknown }).getKLine
    patchGetKLine(async () => {
        throw new Error('tushare down')
    })

    try {
        const res = await makeGetRequest(port, '/internal/quote/600519/kline', INTERNAL_TOKEN)

        assert.equal(res.status, 502)
        const body = res.body as Record<string, unknown>
        assert.equal(body.code, 502)
        assert.equal(body.message, 'tushare down')
    } finally {
        ;(TushareKlineService as unknown as { getKLine: unknown }).getKLine = originalGetKLine
    }
})
