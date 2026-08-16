/**
 * P0 预测验证 v2: GET /internal/index/:code/kline 路由测试
 *
 * 组装方式对齐 internal.kline.test.ts：随机端口监听 + x-internal-token，
 * monkey-patch TushareKlineService.getIndexKLine 静态方法。
 * 覆盖 200 成功形状 + 400 校验（非法 code / days）+ 502 服务异常。
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

test('GET /internal/index/000001/kline?days=130 -> 200 rows', async () => {
    const original = (TushareKlineService as unknown as { getIndexKLine: unknown }).getIndexKLine
    ;(TushareKlineService as unknown as { getIndexKLine: unknown }).getIndexKLine = async () => [
        { '时间': '2026-08-11', '收盘价': 3600, '涨跌幅': 1.2 },
        { '时间': '2026-08-12', '收盘价': 3620, '涨跌幅': 0.56 },
    ]
    try {
        const res = await makeGetRequest(port, '/internal/index/000001/kline?days=130', INTERNAL_TOKEN)
        const body = res.body as Record<string, unknown>
        assert.equal(res.status, 200)
        assert.equal(body.code, 200)
        const data = body.data as Record<string, unknown>
        assert.equal(data.code, '000001')
        const rows = data.rows as Array<Record<string, unknown>>
        assert.equal(rows.length, 2)
        assert.equal(rows[0].trade_date, '2026-08-11')
        assert.equal(rows[1].pct_chg, 0.56)
    } finally {
        ;(TushareKlineService as unknown as { getIndexKLine: unknown }).getIndexKLine = original
    }
})

test('GET /internal/index/999999/kline -> 400', async () => {
    const res = await makeGetRequest(port, '/internal/index/999999/kline', INTERNAL_TOKEN)
    assert.equal(res.status, 400)
    assert.equal((res.body as Record<string, unknown>).code, 400)
})

test('GET /internal/index/000001/kline?days=0 -> 400', async () => {
    const res = await makeGetRequest(port, '/internal/index/000001/kline?days=0', INTERNAL_TOKEN)
    assert.equal(res.status, 400)
    assert.equal((res.body as Record<string, unknown>).code, 400)
})

test('GET /internal/index/000001/kline -> 502 when service throws', async () => {
    const original = (TushareKlineService as unknown as { getIndexKLine: unknown }).getIndexKLine
    ;(TushareKlineService as unknown as { getIndexKLine: unknown }).getIndexKLine = async () => {
        throw new Error('tushare down')
    }
    try {
        const res = await makeGetRequest(port, '/internal/index/000001/kline', INTERNAL_TOKEN)
        const body = res.body as Record<string, unknown>
        assert.equal(res.status, 502)
        assert.equal(body.code, 502)
        assert.equal(body.message, 'tushare down')
    } finally {
        ;(TushareKlineService as unknown as { getIndexKLine: unknown }).getIndexKLine = original
    }
})

test('GET /internal/index/000001/kline?start_date=20260101&end_date=20260131 -> 按区间过滤', async () => {
    // 复用该文件既有 TushareKlineService.getIndexKLine patch 模式：
    // patch 返回 3 行日期 20251201/20260110/20260120，期望 rows 只含后两行
    const original = (TushareKlineService as unknown as { getIndexKLine: unknown }).getIndexKLine
    ;(TushareKlineService as unknown as { getIndexKLine: unknown }).getIndexKLine = async () => [
        { '时间': '20251201' },
        { '时间': '20260110' },
        { '时间': '20260120' },
    ]
    try {
        const res = await makeGetRequest(
            port,
            '/internal/index/000001/kline?start_date=20260101&end_date=20260131',
            INTERNAL_TOKEN,
        )
        assert.equal(res.status, 200)
        const body = res.body as { data: { rows: Array<{ trade_date: string }> } }
        assert.deepEqual(body.data.rows.map((r) => r.trade_date), ['20260110', '20260120'])
    } finally {
        ;(TushareKlineService as unknown as { getIndexKLine: unknown }).getIndexKLine = original
    }
})

test('GET /internal/index/000001/kline?start_date=bad -> 400', async () => {
    const res = await makeGetRequest(port, '/internal/index/000001/kline?start_date=bad', INTERNAL_TOKEN)
    assert.equal(res.status, 400)
    assert.equal((res.body as Record<string, unknown>).code, 400)
})
