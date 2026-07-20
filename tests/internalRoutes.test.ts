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
import { TenxScoreService } from '../src/modules/monitor/TenxScoreService'
import { IndustryKGService } from '../src/modules/monitor/IndustryKGService'
import { HotBurstService } from '../src/modules/monitor/HotBurstService'

// MarketSnapshotService 通过 __marketSnapshotDependencies 注入依赖（Task 1 已建立），
// 路由侧调用 getTodayCloseSnapshot()，单测通过替换 deps 字段实现 mock。
import {
    __marketSnapshotDependencies,
    MarketSnapshotUnavailableError,
    type MarketSnapshotUnavailableReason,
} from '../src/modules/quote/MarketSnapshotService'
import type {
    IndexDailyRow,
    DailyPriceRow,
    CompleteDailyResult,
    LimitListThsRow,
    LimitStepRow,
    MoneyflowCntThsRow,
    MoneyflowThsRow,
} from '../src/modules/quote/TushareService'

// 资源清理：internalRouter 传递依赖了 PG pool / Redis / keepAlive HTTP agents。
// 这些长连接会阻止 Node 进程自然退出，旧实现用 process.exit(1) 强杀绕过，
// 这里改为在测试结束后显式关闭，让进程自然退出（符合 Node 官方推荐做法）。
import pool from '../src/core/db'
import redis from '../src/core/redis'
import { closeAllAgents } from '../src/shared/utils/httpAgent'

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
    tenxScore: { score: 85.2, label: 'S', description: 'test score', dimensions: [] },
    tenxTop: {
        stocks: [{ symbol: '300059', name: '东方财富', score: 85.2, label: 'S' }],
        note: 'stub: batch tenx score not yet implemented',
    },
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
    const T = TenxScoreService as any
    T.getScore = async () => mockData.tenxScore
    T.getTopStocks = async () => mockData.tenxTop

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

// ==================== MarketSnapshotService Mock ====================
//
// getTodayCloseSnapshot 通过 __marketSnapshotDependencies 注入所有 Tushare 调用，
// 因此替换 deps 字段即可让路由侧的 MarketSnapshotService.getTodayCloseSnapshot()
// 返回完整快照或抛出 MarketSnapshotUnavailableError，无需 require.cache hack，
// 也无需在 internal.ts 中新增 __marketSnapshotHandlers 之类的 DI 出口。
//
// 关键：路由侧调用 getTodayCloseSnapshot() 不传 now 参数，内部使用 deps.now()。
// MarketSnapshotService 已加 15:30 时钟门禁：Asia/Shanghai 时间 15:30 前一律拒绝。
// 为让路由测试不依赖真实当前时刻（CI 在盘中运行也会通过），固定 deps.now 返回
// 2026-07-19 15:30 +08:00，TODAY_YYYYMMDD 也基于该固定时刻计算。

/** 固定时刻：2026-07-19 15:30 +08:00（收盘时刻，过 15:30 时钟门禁）。 */
const FIXED_NOW = new Date('2026-07-19T15:30:00+08:00')

/** 计算 Asia/Shanghai 时区的 YYYYMMDD（与 MarketSnapshotService.toShanghaiDateYyyymmdd 同逻辑）。 */
function toShanghaiYyyymmdd(now: Date): string {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    })
    const parts = fmt.formatToParts(now)
    const y = parts.find(p => p.type === 'year')?.value ?? ''
    const m = parts.find(p => p.type === 'month')?.value ?? ''
    const d = parts.find(p => p.type === 'day')?.value ?? ''
    return `${y}${m}${d}`
}

const TODAY_YYYYMMDD = toShanghaiYyyymmdd(FIXED_NOW)
// 前一日（自然日减 1；测试不关心是否为真实交易日，只要求与当日不同）
const PREV_YYYYMMDD = toShanghaiYyyymmdd(new Date(FIXED_NOW.getTime() - 24 * 60 * 60 * 1000))

/** 6 个指数的 index_daily 序列；000001.SH 含 current + previous 两个交易日。 */
const SNAPSHOT_INDEX_ROWS: Record<string, IndexDailyRow[]> = {
    '000001.SH': [
        { ts_code: '000001.SH', trade_date: TODAY_YYYYMMDD, open: 3190, high: 3210, low: 3185, close: 3200, pre_close: 3180, change: 20, pct_chg: 0.6, vol: 1, amount: 1 },
        { ts_code: '000001.SH', trade_date: PREV_YYYYMMDD, open: 3175, high: 3190, low: 3170, close: 3180, pre_close: 3170, change: 10, pct_chg: 0.3, vol: 1, amount: 1 },
    ],
    '399001.SZ': [{ ts_code: '399001.SZ', trade_date: TODAY_YYYYMMDD, open: 10450, high: 10600, low: 10400, close: 10500, pre_close: 10400, change: 100, pct_chg: 0.9, vol: 1, amount: 1 }],
    '399006.SZ': [{ ts_code: '399006.SZ', trade_date: TODAY_YYYYMMDD, open: 2090, high: 2110, low: 2080, close: 2100, pre_close: 2080, change: 20, pct_chg: 0.9, vol: 1, amount: 1 }],
    '000300.SH': [{ ts_code: '000300.SH', trade_date: TODAY_YYYYMMDD, open: 4190, high: 4210, low: 4180, close: 4200, pre_close: 4180, change: 20, pct_chg: 0.5, vol: 1, amount: 1 }],
    '000905.SH': [{ ts_code: '000905.SH', trade_date: TODAY_YYYYMMDD, open: 5480, high: 5520, low: 5470, close: 5500, pre_close: 5470, change: 30, pct_chg: 0.5, vol: 1, amount: 1 }],
    '000852.SH': [{ ts_code: '000852.SH', trade_date: TODAY_YYYYMMDD, open: 6180, high: 6220, low: 6170, close: 6200, pre_close: 6170, change: 30, pct_chg: 0.5, vol: 1, amount: 1 }],
}

const SNAPSHOT_CURRENT_DAILY: CompleteDailyResult = {
    rows: [
        { ts_code: '000001.SZ', trade_date: TODAY_YYYYMMDD, open: 10, high: 11, low: 9, close: 10, pre_close: 10, change: 0, pct_chg: 1.5, vol: 100, amount: 2000 },
    ],
    complete: true,
    reason: 'complete',
    page_count: 1,
}

const SNAPSHOT_PREVIOUS_DAILY: CompleteDailyResult = {
    rows: [
        { ts_code: '000001.SZ', trade_date: PREV_YYYYMMDD, open: 10, high: 11, low: 9, close: 10, pre_close: 10, change: 0, pct_chg: 0.5, vol: 100, amount: 1000 },
    ],
    complete: true,
    reason: 'complete',
    page_count: 1,
}

/** 安装 MarketSnapshotService 依赖 mock：返回 trade_date=TODAY_YYYYMMDD 的完整快照。 */
function setupMarketSnapshotMocks(): void {
    const deps = __marketSnapshotDependencies
    // 注入固定时刻，让路由侧 getTodayCloseSnapshot() 不传 nowOverride 时使用 FIXED_NOW，
    // 既保证过 15:30 时钟门禁，又保证 TODAY_YYYYMMDD 与 mock 数据一致。
    deps.now = () => FIXED_NOW
    deps.getIndexDaily = (async (code: string) =>
        SNAPSHOT_INDEX_ROWS[code] ?? []) as typeof deps.getIndexDaily
    deps.getCompleteDailyByDate = (async (date: string) =>
        date === TODAY_YYYYMMDD ? SNAPSHOT_CURRENT_DAILY : SNAPSHOT_PREVIOUS_DAILY) as typeof deps.getCompleteDailyByDate
    deps.getLimitListThs = (async () => [] as LimitListThsRow[]) as typeof deps.getLimitListThs
    deps.getLimitStep = (async () => [] as LimitStepRow[]) as typeof deps.getLimitStep
    deps.getMoneyflowCntThs = (async () => [] as MoneyflowCntThsRow[]) as typeof deps.getMoneyflowCntThs
    deps.getMoneyflowThsByDate = (async () => [] as MoneyflowThsRow[]) as typeof deps.getMoneyflowThsByDate
}

/**
 * 让 MarketSnapshotService.getTodayCloseSnapshot 抛出 MarketSnapshotUnavailableError。
 * 通过替换 deps.getIndexDaily 实现，路由侧 try/catch 会识别该错误并返回 409。
 *
 * 注意：此 mock 不自动恢复（brief 的 verbatim 测试未使用回调模式）。
 * 调用方需确保后续不再有依赖 getTodayCloseSnapshot 的测试，或在此之后重新调用 setupMarketSnapshotMocks。
 */
function mockSnapshotUnavailable(reason: MarketSnapshotUnavailableReason): void {
    const deps = __marketSnapshotDependencies
    deps.getIndexDaily = (async () => {
        throw new MarketSnapshotUnavailableError(reason)
    }) as typeof deps.getIndexDaily
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
    { name: 'tenx/score/:symbol', path: '/tenx/score/300059' },
    { name: 'tenx/top', path: '/tenx/top' },
    { name: 'graph/concepts', path: '/graph/concepts' },
    { name: 'graph/:concept', path: '/graph/885641.TI' },
    { name: 'institution-research', path: '/institution-research' },
    { name: 'institution-research/history', path: '/institution-research/history' },
    { name: 'market/close-snapshot', path: '/market/close-snapshot' },
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
    // 为 MarketSnapshotService 路由测试准备 deps mock（返回 trade_date=20260719 的完整快照）
    setupMarketSnapshotMocks()

    // 4. 运行测试
    // 用 try/finally 包裹全部测试：任何用例失败时，finally 块也会关闭 server / pool / redis / agents，
    // 让进程能自然退出（配合 process.exitCode 而非 process.exit）。
    try {
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

    await runAsyncTest('GET /internal/tenx/score/:symbol returns 200 + score', async () => {
        const res = await makeGetRequest(port, '/tenx/score/300059', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: typeof mockData.tenxScore }
        assert.equal(body.code, 200)
        assert.equal(body.data.score, 85.2)
        assert.equal(body.data.label, 'S')
    })

    await runAsyncTest('GET /internal/tenx/top returns 200 + top stocks', async () => {
        const res = await makeGetRequest(port, '/tenx/top', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: typeof mockData.tenxTop }
        assert.equal(body.code, 200)
        assert.ok(Array.isArray(body.data.stocks))
        assert.equal(body.data.note, 'stub: batch tenx score not yet implemented')
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

    await runAsyncTest('GET /internal/tenx/score/:symbol returns 502 on service failure', async () => {
        await withThrowingMock(TenxScoreService, 'getScore', async () => {
            const res = await makeGetRequest(port, '/tenx/score/300059', INTERNAL_TOKEN)
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

    await runAsyncTest('GET /internal/tenx/top returns 502 on service failure', async () => {
        await withThrowingMock(TenxScoreService, 'getTopStocks', async () => {
            const res = await makeGetRequest(port, '/tenx/top', INTERNAL_TOKEN)
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

    // --- 查询参数测试 ---
    await runAsyncTest('GET /internal/tenx/top respects limit param (mock returns fixed)', async () => {
        const res = await makeGetRequest(port, '/tenx/top?limit=3', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: { stocks: unknown[]; note: string } }
        assert.equal(body.code, 200)
    })

    // --- /internal/market/close-snapshot 测试（Task 2）---
    // 顺序：成功(200) → 服务异常(502) → 未收盘(409)。
    // 409 用例使用 mockSnapshotUnavailable 且不自动恢复，放在最后以避免影响其它测试。
    await runAsyncTest('GET /internal/market/close-snapshot returns complete facts', async () => {
        const res = await makeGetRequest(port, '/market/close-snapshot', INTERNAL_TOKEN)
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: { status: string; trade_date: string } }
        assert.equal(body.code, 200)
        assert.equal(body.data.status, 'complete')
        assert.equal(body.data.trade_date, TODAY_YYYYMMDD)
    })

    await runAsyncTest('GET /internal/market/close-snapshot returns 502 on service failure', async () => {
        await withThrowingMock(__marketSnapshotDependencies, 'getCompleteDailyByDate', async () => {
            const res = await makeGetRequest(port, '/market/close-snapshot', INTERNAL_TOKEN)
            assert.equal(res.status, 502)
            const body = res.body as { code: number; message: string }
            assert.equal(body.code, 502)
            assert.ok(body.message.includes('Service unavailable'))
        })
    })

    await runAsyncTest('GET /internal/market/close-snapshot returns 409 before close (market_not_closed)', async () => {
        mockSnapshotUnavailable('market_not_closed')
        const res = await makeGetRequest(port, '/market/close-snapshot', INTERNAL_TOKEN)
        assert.equal(res.status, 409)
        assert.deepEqual(res.body, {
            code: 409,
            data: { status: 'not_ready', reason: 'market_not_closed' },
        })
    })

    // 重置 deps：上一个 409 用例把 deps.getIndexDaily 改成抛错版本且不自动恢复，
    // 这里重新安装正常 mock，让下一个 409 用例从干净状态开始。
    setupMarketSnapshotMocks()

    await runAsyncTest('GET /internal/market/close-snapshot returns 409 with incomplete status (incomplete_daily_coverage)', async () => {
        mockSnapshotUnavailable('incomplete_daily_coverage')
        const res = await makeGetRequest(port, '/market/close-snapshot', INTERNAL_TOKEN)
        assert.equal(res.status, 409)
        assert.deepEqual(res.body, {
            code: 409,
            data: { status: 'incomplete', reason: 'incomplete_daily_coverage' },
        })
    })

    // 5. 关闭服务器 + 释放长连接资源，让进程自然退出
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        console.log('[test] Server closed')

        // 关闭 PG 连接池（internalRouter 传递依赖 src/core/db.ts 的 pool）
        await pool.end()
        // 关闭 Redis 连接（lazyConnect 未真正连上时 disconnect 也是 no-op，安全）
        redis.disconnect()
        // 关闭 keepAlive HTTP agents（sessionFetch 创建的连接池）
        closeAllAgents()
        console.log('[test] Resources released (pool / redis / http agents)')
    }
}

// ==================== 入口 ====================
//
// 注意：禁止使用 process.exit() 强杀进程。
// - process.exit() 会跳过未完成的 I/O 清理（如 server.close() 的优雅退出、
//   pending Promise 的 finally 块、缓存写盘），导致测试进程在 CI 中留下僵尸句柄。
// - 这里改用 process.exitCode = 1：设置退出码但让 Node 自然退出，让事件循环
//   清空 pending 任务后再退出。这也是 Node 官方推荐的"非强制失败"做法。
main().catch((err) => {
    console.error(err)
    process.exitCode = 1
})
