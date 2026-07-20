/**
 * Task 6: /internal/* 新增接口测试
 *
 * 测试策略：
 * 1. 启动 Express HTTP 服务器（随机端口），挂载 internalRouter
 * 2. Monkey-patch 5 个 Service 的方法，返回固定 mock 数据
 * 3. 对 9 个新接口分别测试：成功(200) + 鉴权失败(403) + Service失败(502)
 * 4. 额外测试路由注册顺序（/monitor/alerts 不被 /:symbol 拦截）
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import internalRouter from '../src/core/routes/internal'

// 导入 Service 类用于 mock
import { WindLeaderService } from '../src/modules/monitor/WindLeaderService'
import { StockMonitorService } from '../src/modules/monitor/service'
import { IndustryKGService } from '../src/modules/monitor/IndustryKGService'
import { HotBurstService } from '../src/modules/monitor/HotBurstService'

// 与 internal.ts 中 verifyInternalToken 使用相同的 token 读取逻辑
const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production'

// ==================== 测试工具函数 ====================

function runAsyncTest(name: string, fn: () => Promise<void>): Promise<void> {
    return fn().then(
        () => console.log(`PASS  ${name}`),
        (err) => {
            console.error(`FAIL  ${name}`)
            throw err
        },
    )
}

// ==================== HTTP 请求辅助 ====================

interface HttpResponse {
    status: number
    body: unknown
}

function makeGetRequest(
    port: number,
    path: string,
    token?: string,
): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {}
        if (token !== undefined) {
            headers['x-internal-token'] = token
        }
        const req = http.get(
            {
                hostname: '127.0.0.1',
                port,
                path: `/internal${path}`,
                headers,
            },
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

// ==================== Mock 数据 ====================

const mockData = {
    windLeaders: {
        update_time: '2026-01-01T00:00:00Z',
        hot_sectors: [{ name: '半导体', score: 90, leader: '中芯国际' }],
    },
    monitorData: [{ event_id: 'test:1', symbol: '300059', stock_name: '东方财富' }],
    alertHistory: { total: 1, events: [{ event_id: 'test:1', symbol: '300059' }] },
    concepts: [{ id: '885641.TI', name: '人工智能', industryCount: 3 }],
    graph: {
        centerIndustries: [],
        upstreamIndustries: [],
        downstreamIndustries: [],
        edges: [],
        conceptEdges: [],
    },
    hotBurst: {
        update_time: '2026-01-01T00:00:00Z',
        total_stocks_checked: 100,
        resonance_count: 5,
        ths_hot_sectors: [],
        outbreaks: [],
        hot_concepts: [],
    },
    hotBurstHistory: { total: 0, records: [] },
}

// ==================== 设置 Mock ====================

function setupMocks(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const W = WindLeaderService as any
    W.getWindLeaders = async () => mockData.windLeaders

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const S = StockMonitorService as any
    S.getMonitorData = async () => mockData.monitorData
    S.getAlertHistory = async () => mockData.alertHistory

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const I = IndustryKGService as any
    I.getConcepts = async () => mockData.concepts
    I.getGraphByConcept = async () => mockData.graph

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const H = HotBurstService as any
    H.getHotBurst = async () => mockData.hotBurst
    H.getHotBurstHistory = async () => mockData.hotBurstHistory
}

/** 临时替换某个 Service 方法为抛出异常的版本，测试完后恢复 */
function withThrowingMock(
    service: unknown,
    methodName: string,
    fn: () => Promise<void>,
): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = service as any
    const original = s[methodName]
    s[methodName] = async () => {
        throw new Error('Service unavailable (mock)')
    }
    return fn().finally(() => {
        s[methodName] = original
    })
}

// ==================== 测试用例定义 ====================

interface EndpointCase {
    name: string
    path: string
    expectedDataKey?: string
}

const endpoints: EndpointCase[] = [
    { name: 'wind-leaders', path: '/wind-leaders' },
    { name: 'monitor/alerts', path: '/monitor/alerts' },
    { name: 'monitor/:symbol', path: '/monitor/300059' },
    { name: 'graph/concepts', path: '/graph/concepts' },
    { name: 'graph/:concept', path: '/graph/885641.TI' },
    { name: 'institution-research', path: '/institution-research' },
    { name: 'institution-research/history', path: '/institution-research/history' },
]

// ==================== 主测试流程 ====================

async function main(): Promise<void> {
    // 1. 创建 Express 应用
    const app = express()
    app.use(express.json())
    app.use('/internal', internalRouter)

    // 2. 启动 HTTP 服务器（随机端口）
    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    console.log(`[test] Server listening on 127.0.0.1:${port}`)

    // 3. 设置 Service Mock
    setupMocks()

    // 4. 运行测试

    // --- /internal/health（无需 token，Task 3 已有）---
    await runAsyncTest('GET /internal/health returns 200 without token', async () => {
        const res = await makeGetRequest(port, '/health')
        assert.equal(res.status, 200)
        assert.deepEqual(res.body, { status: 'ok' })
    })

    // --- 鉴权失败测试：9 个新接口在无 token 时均返回 403 ---
    for (const ep of endpoints) {
        await runAsyncTest(`GET /internal/${ep.name} returns 403 without token`, async () => {
            const res = await makeGetRequest(port, ep.path)
            assert.equal(res.status, 403)
            const body = res.body as { code: number; message: string }
            assert.equal(body.code, 403)
        })
    }

    // --- 鉴权失败测试：错误 token 也返回 403 ---
    await runAsyncTest('GET /internal/wind-leaders returns 403 with wrong token', async () => {
        const res = await makeGetRequest(port, '/wind-leaders', 'wrong-token')
        assert.equal(res.status, 403)
    })

    // --- 成功测试：9 个新接口在带正确 token 时返回 200 + data ---
    await runAsyncTest('GET /internal/wind-leaders returns 200 + wind leader data', async () => {
        const res = await makeGetRequest(port, '/wind-leaders', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: typeof mockData.windLeaders }
        assert.equal(body.code, 200)
        assert.equal(body.data.update_time, mockData.windLeaders.update_time)
        assert.ok(Array.isArray(body.data.hot_sectors))
    })

    await runAsyncTest('GET /internal/monitor/alerts returns 200 + alert history', async () => {
        const res = await makeGetRequest(port, '/monitor/alerts', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: typeof mockData.alertHistory }
        assert.equal(body.code, 200)
        assert.equal(body.data.total, 1)
        assert.ok(Array.isArray(body.data.events))
    })

    await runAsyncTest('GET /internal/monitor/:symbol returns 200 + monitor data', async () => {
        const res = await makeGetRequest(port, '/monitor/300059', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: typeof mockData.monitorData }
        assert.equal(body.code, 200)
        assert.ok(Array.isArray(body.data))
        assert.equal(body.data[0].symbol, '300059')
    })

    await runAsyncTest('GET /internal/monitor/:symbol returns 400 for invalid symbol', async () => {
        const res = await makeGetRequest(port, '/monitor/abc123', INTERNAL_TOKEN)
        assert.equal(res.status, 400)
    })

    await runAsyncTest('GET /internal/graph/concepts returns 200 + concept list', async () => {
        const res = await makeGetRequest(port, '/graph/concepts', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: typeof mockData.concepts }
        assert.equal(body.code, 200)
        assert.ok(Array.isArray(body.data))
        assert.equal(body.data[0].id, '885641.TI')
    })

    await runAsyncTest('GET /internal/graph/:concept returns 200 + subgraph', async () => {
        const res = await makeGetRequest(port, '/graph/885641.TI', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: typeof mockData.graph }
        assert.equal(body.code, 200)
        assert.ok(Array.isArray(body.data.centerIndustries))
    })

    await runAsyncTest('GET /internal/institution-research returns 200 + hot burst data', async () => {
        const res = await makeGetRequest(port, '/institution-research', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: typeof mockData.hotBurst }
        assert.equal(body.code, 200)
        assert.equal(body.data.resonance_count, 5)
    })

    await runAsyncTest('GET /internal/institution-research/history returns 200 + history', async () => {
        const res = await makeGetRequest(port, '/institution-research/history', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: typeof mockData.hotBurstHistory }
        assert.equal(body.code, 200)
        assert.equal(body.data.total, 0)
        assert.ok(Array.isArray(body.data.records))
    })

    // --- 路由顺序测试：/monitor/alerts 不被 /:symbol 拦截 ---
    await runAsyncTest('Route ordering: /monitor/alerts hits alerts handler, not :symbol', async () => {
        // alerts 返回 { total, events } 结构；如果被 :symbol 匹配，会返回数组
        const res = await makeGetRequest(port, '/monitor/alerts', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: unknown }
        assert.equal(body.code, 200)
        // data 应该是 { total, events } 对象，不是数组
        assert.ok(!Array.isArray(body.data), 'data should be an object (alert history), not an array')
        assert.ok(typeof body.data === 'object' && body.data !== null)
    })

    await runAsyncTest('Route ordering: /graph/concepts hits concepts handler, not :concept', async () => {
        // concepts 返回数组；如果被 :concept 匹配，会返回 graph 对象
        const res = await makeGetRequest(port, '/graph/concepts', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: unknown }
        assert.equal(body.code, 200)
        // data 应该是数组（concept 列表），不是 graph 对象
        assert.ok(Array.isArray(body.data), 'data should be an array (concept list), not a graph object')
    })

    // --- 502 错误测试：Service 抛异常时返回 502 ---
    await runAsyncTest('GET /internal/wind-leaders returns 502 on service failure', async () => {
        await withThrowingMock(WindLeaderService, 'getWindLeaders', async () => {
            const res = await makeGetRequest(port, '/wind-leaders', INTERNAL_TOKEN)
            assert.equal(res.status, 502)
            const body = res.body as { code: number; message: string }
            assert.equal(body.code, 502)
            assert.ok(body.message.includes('Service unavailable'))
        })
    })

    await runAsyncTest('GET /internal/monitor/:symbol returns 502 on service failure', async () => {
        await withThrowingMock(StockMonitorService, 'getMonitorData', async () => {
            const res = await makeGetRequest(port, '/monitor/300059', INTERNAL_TOKEN)
            assert.equal(res.status, 502)
        })
    })

    await runAsyncTest('GET /internal/graph/:concept returns 502 on service failure', async () => {
        await withThrowingMock(IndustryKGService, 'getGraphByConcept', async () => {
            const res = await makeGetRequest(port, '/graph/885641.TI', INTERNAL_TOKEN)
            assert.equal(res.status, 502)
        })
    })

    await runAsyncTest('GET /internal/institution-research returns 502 on service failure', async () => {
        await withThrowingMock(HotBurstService, 'getHotBurst', async () => {
            const res = await makeGetRequest(port, '/institution-research', INTERNAL_TOKEN)
            assert.equal(res.status, 502)
        })
    })

    await runAsyncTest('GET /internal/institution-research/history returns 502 on service failure', async () => {
        await withThrowingMock(HotBurstService, 'getHotBurstHistory', async () => {
            const res = await makeGetRequest(port, '/institution-research/history', INTERNAL_TOKEN)
            assert.equal(res.status, 502)
        })
    })

    await runAsyncTest('GET /internal/monitor/alerts returns 502 on service failure', async () => {
        await withThrowingMock(StockMonitorService, 'getAlertHistory', async () => {
            const res = await makeGetRequest(port, '/monitor/alerts', INTERNAL_TOKEN)
            assert.equal(res.status, 502)
            const body = res.body as { code: number; message: string }
            assert.equal(body.code, 502)
            assert.ok(body.message.includes('Service unavailable'))
        })
    })

    await runAsyncTest('GET /internal/graph/concepts returns 502 on service failure', async () => {
        await withThrowingMock(IndustryKGService, 'getConcepts', async () => {
            const res = await makeGetRequest(port, '/graph/concepts', INTERNAL_TOKEN)
            assert.equal(res.status, 502)
            const body = res.body as { code: number; message: string }
            assert.equal(body.code, 502)
            assert.ok(body.message.includes('Service unavailable'))
        })
    })

    // 5. 关闭服务器
    await new Promise<void>((resolve) => server.close(() => resolve()))
    console.log('[test] Server closed')
}

// ==================== 入口 ====================

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
