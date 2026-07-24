/**
 * market_trace_qa 报告读取契约测试
 *
 * 验证 GET /internal/analysis-reports/:type/:date 的 404/500/200/400/403 契约。
 * Python Agent（market_trace_qa）通过此端点读取 review 报告：
 *   - 404 Report not found → Python 据此生成 degraded trace（degraded=true）
 *   - 500 DB error        → Python 错误处理
 *   - 200 + 报告数据      → Python 正常生成回答
 *
 * 现有 tests/internalRoutes.test.ts 未覆盖此端点的 404/500 分支
 * （它只覆盖 POST /internal/analysis-reports 与 9 个 Service 类接口），
 * 故新建本独立文件补齐 report-read 契约门禁。
 *
 * 测试策略：启动 Express 服务器挂载 internalRouter，monkey-patch pool.query
 * 模拟 0 行（404）/ 抛异常（500）/ 命中行（200），不依赖真实 PostgreSQL。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import internalRouter from '../src/core/routes/internal'
import pool from '../src/core/db'
import redis from '../src/core/redis'
import { closeAllAgents } from '../src/shared/utils/httpAgent'

// 与 internal.ts 中 verifyInternalToken 使用相同的 token 读取逻辑，
// 确保测试发出的 X-Internal-Token 与路由侧校验值一致。
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
            { hostname: '127.0.0.1', port, path: `/internal${path}`, headers },
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

type QueryResult = { rows: Record<string, unknown>[] }

/**
 * 临时替换 pool.query（pg.Pool 的方法定义在原型上，实例赋值会形成自有属性遮蔽原型方法）。
 * 用完务必调用 restorePoolQuery 恢复，避免影响进程内后续测试。
 */
function setPoolQuery(fn: (...args: unknown[]) => Promise<QueryResult>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(pool as any).query = fn
}

describe('market_trace_qa report-read contract: GET /internal/analysis-reports/:type/:date', () => {
    let server: http.Server
    let port: number
    // 保存原始 pool.query 以便恢复（pool.query 来自原型，直接赋值会遮蔽）。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalQuery: (...args: unknown[]) => Promise<QueryResult> = (pool as any).query.bind(pool)

    before(async () => {
        const app = express()
        app.use(express.json())
        app.use('/internal', internalRouter)
        server = http.createServer(app)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        port = (server.address() as AddressInfo).port
    })

    after(async () => {
        // 恢复 pool.query，关闭 server / pool / redis / http agents，
        // 让本测试进程自然退出（不依赖 process.exit 强杀）。
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(pool as any).query = originalQuery
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await pool.end()
        redis.disconnect()
        closeAllAgents()
    })

    it('returns 404 when review report is not found (DB returns 0 rows)', async () => {
        setPoolQuery(async () => ({ rows: [] }))
        const res = await makeGetRequest(port, '/analysis-reports/review/2026-07-22', INTERNAL_TOKEN)
        assert.equal(res.status, 404)
        const body = res.body as { code: number; message: string }
        assert.equal(body.code, 404)
        assert.equal(body.message, 'Report not found')
    })

    it('returns 500 when DB query throws', async () => {
        setPoolQuery(async () => {
            throw new Error('DB connection lost')
        })
        const res = await makeGetRequest(port, '/analysis-reports/review/2026-07-22', INTERNAL_TOKEN)
        assert.equal(res.status, 500)
        const body = res.body as { code: number; message: string }
        assert.equal(body.code, 500)
        assert.ok(body.message.includes('DB connection lost'))
    })

    it('returns 200 with report data when review report exists', async () => {
        const row: Record<string, unknown> = {
            id: 1,
            report_type: 'review',
            report_date: '2026-07-22',
            content: { summary: '大盘震荡' },
            data_source: 'tushare',
            status: 'completed',
            generation_time_ms: 1234,
            model_version: 'v1',
            created_at: '2026-07-22T10:00:00Z',
        }
        setPoolQuery(async () => ({ rows: [row] }))
        const res = await makeGetRequest(port, '/analysis-reports/review/2026-07-22', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: { report_type: string; report_date: string } }
        assert.equal(body.code, 200)
        assert.equal(body.data.report_type, 'review')
        assert.equal(body.data.report_date, '2026-07-22')
    })

    it('returns 400 for invalid report_type', async () => {
        setPoolQuery(async () => ({ rows: [] }))
        const res = await makeGetRequest(
            port,
            '/analysis-reports/invalid_type/2026-07-22',
            INTERNAL_TOKEN,
        )
        assert.equal(res.status, 400)
    })

    it('returns 400 for invalid report_date format', async () => {
        setPoolQuery(async () => ({ rows: [] }))
        const res = await makeGetRequest(port, '/analysis-reports/review/invalid-date', INTERNAL_TOKEN)
        assert.equal(res.status, 400)
    })

    it('returns 403 without X-Internal-Token', async () => {
        setPoolQuery(async () => ({ rows: [] }))
        const res = await makeGetRequest(port, '/analysis-reports/review/2026-07-22')
        assert.equal(res.status, 403)
    })
})
