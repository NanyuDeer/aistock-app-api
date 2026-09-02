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
import test, { after, afterEach, before, mock } from 'node:test'
import express from 'express'

import predictionInternalRouter, { __internalPredictionDependencies } from './internalRouter'
import { PredictionRecordService, type PredictionRecordRow, type PredictionVerificationEntry } from './PredictionRecordService'
import redis from '../../core/redis'
import pool from '../../core/db'

// 与 internalRouter.ts 使用相同的 token 读取逻辑（模块加载期常量）
const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production'

// 上海今日（UTC+8）YYYY-MM-DD，与路由内校验口径一致
function shanghaiToday(): string {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 快照原始注入点 / redis 方法 / fetch，供 afterEach 恢复（node:test 测试间共享模块状态） */
const ORIGINAL_INTERNAL_DEPS = { ...__internalPredictionDependencies }
const ORIG_REDIS_INCR = (redis as unknown as { incr: unknown }).incr
const ORIG_REDIS_EXPIRE = (redis as unknown as { expire: unknown }).expire
const ORIG_FETCH = globalThis.fetch

afterEach(() => {
    __internalPredictionDependencies.create = ORIGINAL_INTERNAL_DEPS.create
    __internalPredictionDependencies.list = ORIGINAL_INTERNAL_DEPS.list
    __internalPredictionDependencies.regenerateTimeoutMs = ORIGINAL_INTERNAL_DEPS.regenerateTimeoutMs
    ;(redis as unknown as { incr: unknown }).incr = ORIG_REDIS_INCR
    ;(redis as unknown as { expire: unknown }).expire = ORIG_REDIS_EXPIRE
    globalThis.fetch = ORIG_FETCH
    mock.restoreAll()  // 还原本文件内 node:test mock.method（appendVerification 透传测试）
})

/** Redis 限流 mock：incr 返回指定计数（默认 1 放行），同时 patch expire——避免测试触达真实 Redis */
function patchRedisIncr(count: number): void {
    ;(redis as unknown as { incr: unknown }).incr = (async () => count) as unknown as typeof redis.incr
    ;(redis as unknown as { expire: unknown }).expire = (async () => 1) as unknown as typeof redis.expire
}

interface MockFetchResponse {
    status: number
    body: string
}

/** 替换 globalThis.fetch（对齐 stockTraceTrigger.spec.ts 模式）；路由只依赖 status/ok/json() */
function patchFetch(handler: (url: string, init: RequestInit) => Promise<MockFetchResponse>): void {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const data = await handler(String(url), init || {})
        return {
            ok: data.status >= 200 && data.status < 300,
            status: data.status,
            json: async () => JSON.parse(data.body),
        } as unknown as Response
    }) as unknown as typeof fetch
}

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
    // lazyConnect 未连接时无副作用；若意外建立连接则断开，避免句柄阻塞进程退出
    redis.disconnect()
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

test('PUT /internal/predictions/1/verification passes through extended entry fields (A3 stats)', async () => {
    // A3 统计口径修复回归：Python 验证器写入的扩展字段（methodology_version/baseline_neutral
    // /target_type/approximate 等）必须完整透传到 appendVerification 的 entry——
    // 否则 agent-py _filter_v2 恒 n=0，A3 钳制与存量统计在生产不触发。
    let captured: unknown
    mock.method(
        PredictionRecordService,
        'appendVerification',
        async (id: number, horizon: string, entry: PredictionVerificationEntry) => {
            captured = entry
            return {
                id,
                source_type: 'review',
                source_id: 'review:2026-08-28',
                schema_version: '2.0',
                prediction: { horizons: [{ horizon }] },
                verification: { [horizon]: entry },
                status: 'pending',
                due_dates: { [horizon]: '2026-09-15' },
                created_at: new Date().toISOString(),
            } as PredictionRecordRow
        },
    )

    const res = await makeJsonRequest(
        port,
        'PUT',
        '/internal/predictions/1/verification',
        INTERNAL_TOKEN,
        {
            horizon: 'short',
            result: 'hit',
            methodology_version: '2.0',
            baseline_neutral: true,
            target_type: 'index',
            approximate: false,
        },
    )

    assert.equal(res.status, 200)
    const entry = captured as Record<string, unknown>
    assert.equal(entry.methodology_version, '2.0')
    assert.equal(entry.baseline_neutral, true)
    assert.equal(entry.target_type, 'index')
    assert.equal(entry.approximate, false)
    assert.equal(entry.result, 'hit')
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

// ==================== GET / : source_id 过滤（Python 端"已验证拒覆盖"防御查询） ====================

test('GET /internal/predictions?source_id=review:2026-08-14 -> 200 且 list 收到 source_id', async () => {
    let captured: unknown
    __internalPredictionDependencies.list = (async (params: Parameters<typeof __internalPredictionDependencies.list>[0]) => {
        captured = params
        return {
            rows: [{
                id: 1,
                source_type: 'market_trace',
                source_id: params.source_id,
                schema_version: '1.0',
                prediction: {},
                verification: {},
                status: 'pending',
                due_dates: {},
                created_at: new Date().toISOString(),
            }],
            total: 1,
        }
    }) as unknown as typeof __internalPredictionDependencies.list

    const res = await makeJsonRequest(
        port,
        'GET',
        '/internal/predictions?source_id=review:2026-08-14',
        INTERNAL_TOKEN,
    )

    assert.equal(res.status, 200)
    const body = res.body as { code: number; data: Array<{ source_id?: string }> }
    assert.equal(body.code, 200)
    assert.ok(Array.isArray(body.data))
    assert.equal(body.data[0].source_id, 'review:2026-08-14')
    const params = captured as { source_id?: string; page?: number; pageSize?: number }
    assert.equal(params.source_id, 'review:2026-08-14')
    assert.equal(params.page, 1)
    assert.equal(params.pageSize, 50)
})

test('GET /internal/predictions?source_id= (empty) -> 400', async () => {
    const res = await makeJsonRequest(
        port,
        'GET',
        '/internal/predictions?source_id=',
        INTERNAL_TOKEN,
    )

    assert.equal(res.status, 400)
    const body = res.body as { code: number }
    assert.equal(body.code, 400)
})

// ==================== GET / : pending/verified 游标分页（H8/D3） ====================

test('GET /internal/predictions?status=pending&before_id=100&limit=50 -> 透传游标', async () => {
    let captured: unknown
    const original = PredictionRecordService.listPending
    PredictionRecordService.listPending = (async (limit: number, beforeId?: number) => {
        captured = { limit, beforeId }
        return []
    }) as typeof PredictionRecordService.listPending

    try {
        const res = await makeJsonRequest(
            port,
            'GET',
            '/internal/predictions?status=pending&before_id=100&limit=50',
            INTERNAL_TOKEN,
        )
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: unknown[] }
        assert.equal(body.code, 200)
        assert.ok(Array.isArray(body.data))
        const params = captured as { limit: number; beforeId?: number }
        assert.equal(params.limit, 50)
        assert.equal(params.beforeId, 100)
    } finally {
        PredictionRecordService.listPending = original
    }
})

test('GET /internal/predictions?status=verified&before_id=100&limit=50 -> 走 listByStatus（D3 统计出口）', async () => {
    let captured: unknown
    const original = PredictionRecordService.listByStatus
    PredictionRecordService.listByStatus = (async (status: string, limit: number, beforeId?: number) => {
        captured = { status, limit, beforeId }
        return []
    }) as typeof PredictionRecordService.listByStatus

    try {
        const res = await makeJsonRequest(
            port,
            'GET',
            '/internal/predictions?status=verified&before_id=100&limit=50',
            INTERNAL_TOKEN,
        )
        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: unknown[] }
        assert.equal(body.code, 200)
        const params = captured as { status: string; limit: number; beforeId?: number }
        assert.equal(params.status, 'verified')
        assert.equal(params.limit, 50)
        assert.equal(params.beforeId, 100)
    } finally {
        PredictionRecordService.listByStatus = original
    }
})

test('GET /internal/predictions?status=pending&before_id=abc -> 200 忽略非法游标（默认全量）', async () => {
    let captured: unknown
    const original = PredictionRecordService.listPending
    PredictionRecordService.listPending = (async (limit: number, beforeId?: number) => {
        captured = { limit, beforeId }
        return []
    }) as typeof PredictionRecordService.listPending

    try {
        const res = await makeJsonRequest(
            port,
            'GET',
            '/internal/predictions?status=pending&before_id=abc',
            INTERNAL_TOKEN,
        )
        assert.equal(res.status, 200)
        const params = captured as { limit: number; beforeId?: number }
        assert.equal(params.beforeId, undefined)
    } finally {
        PredictionRecordService.listPending = original
    }
})

// ==================== POST / : status / skip_reason 透传 ====================

test('POST /internal/predictions with status=skipped + skip_reason -> create 收到 status 且 skip_reason 透传', async () => {
    let captured: unknown
    __internalPredictionDependencies.create = (async (input: Parameters<typeof __internalPredictionDependencies.create>[0]) => {
        captured = input
        return {
            id: 1,
            source_type: input.source_type,
            source_id: input.source_id,
            schema_version: input.schema_version,
            prediction: { ...input.prediction, skip_reason: input.skip_reason },
            verification: {},
            status: input.status ?? 'pending',
            due_dates: input.due_dates,
            created_at: new Date().toISOString(),
        }
    }) as typeof __internalPredictionDependencies.create

    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions',
        INTERNAL_TOKEN,
        {
            source_type: 'market_trace',
            source_id: 'review:2026-08-07',
            prediction: { attribution_summary: 'x' },
            due_dates: { short: '2026-08-17' },
            status: 'skipped',
            skip_reason: 'insufficient data',
        },
    )

    assert.equal(res.status, 200)
    const input = captured as {
        status?: string
        skip_reason?: string
        prediction: Record<string, unknown>
    }
    assert.equal(input.status, 'skipped')
    assert.equal(input.skip_reason, 'insufficient data')
    // skip_reason 由 service 合并进 prediction（mock 按 service 语义模拟；路由职责=透传字段）
    assert.equal((input.prediction as Record<string, unknown>).attribution_summary, 'x')
    const created = (res.body as { data: { prediction: Record<string, unknown> } }).data
    assert.equal(created.prediction.skip_reason, 'insufficient data')
})

test('POST /internal/predictions invalid status -> 400', async () => {
    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions',
        INTERNAL_TOKEN,
        {
            source_type: 'market_trace',
            source_id: 'review:2026-08-07',
            prediction: {},
            due_dates: {},
            status: 'bogus',
        },
    )

    assert.equal(res.status, 400)
    const body = res.body as { code: number }
    assert.equal(body.code, 400)
})

test('POST /internal/predictions non-string skip_reason -> 400', async () => {
    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions',
        INTERNAL_TOKEN,
        {
            source_type: 'market_trace',
            source_id: 'review:2026-08-07',
            prediction: {},
            due_dates: {},
            skip_reason: 123,
        },
    )

    assert.equal(res.status, 400)
    const body = res.body as { code: number }
    assert.equal(body.code, 400)
})

test('POST /internal/predictions with due_dates_approximate -> create 收到且透传（P2 越年近似标记）', async () => {
    let captured: unknown
    __internalPredictionDependencies.create = (async (input: Parameters<typeof __internalPredictionDependencies.create>[0]) => {
        captured = input
        return {
            id: 2,
            source_type: input.source_type,
            source_id: input.source_id,
            schema_version: input.schema_version,
            // service 语义：due_dates_approximate 合并进 prediction jsonb（mock 模拟）
            prediction: {
                ...input.prediction,
                ...(input.due_dates_approximate !== undefined
                    ? { due_dates_approximate: input.due_dates_approximate }
                    : {}),
            },
            verification: {},
            status: input.status ?? 'pending',
            due_dates: input.due_dates,
            created_at: new Date().toISOString(),
        }
    }) as typeof __internalPredictionDependencies.create

    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions',
        INTERNAL_TOKEN,
        {
            source_type: 'market_trace',
            source_id: 'review:2026-08-13',
            prediction: { attribution_summary: 'x' },
            due_dates: { short: '2026-08-20', long: '2027-02-05' },
            due_dates_approximate: ['long'],
        },
    )

    assert.equal(res.status, 200)
    const input = captured as { due_dates_approximate?: string[] }
    assert.deepEqual(input.due_dates_approximate, ['long'])
    const created = (res.body as { data: { prediction: Record<string, unknown> } }).data
    assert.deepEqual(created.prediction.due_dates_approximate, ['long'])
})

test('POST /internal/predictions non-array due_dates_approximate -> 400', async () => {
    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions',
        INTERNAL_TOKEN,
        {
            source_type: 'market_trace',
            source_id: 'review:2026-08-07',
            prediction: {},
            due_dates: {},
            due_dates_approximate: 'long',
        },
    )

    assert.equal(res.status, 400)
    const body = res.body as { code: number }
    assert.equal(body.code, 400)
})

test('POST /internal/predictions due_dates_approximate with non-string element -> 400', async () => {
    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions',
        INTERNAL_TOKEN,
        {
            source_type: 'market_trace',
            source_id: 'review:2026-08-07',
            prediction: {},
            due_dates: {},
            due_dates_approximate: [123],
        },
    )

    assert.equal(res.status, 400)
    const body = res.body as { code: number }
    assert.equal(body.code, 400)
})

// ==================== POST /regenerate : 鉴权 / 日期校验 / 限流 / 409 / 转发 ====================

test('POST /internal/predictions/regenerate without internal token -> 403', async () => {
    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions/regenerate',
        undefined,
        { trade_date: shanghaiToday() },
    )

    assert.equal(res.status, 403)
    const body = res.body as { code: number }
    assert.equal(body.code, 403)
})

test('POST /internal/predictions/regenerate invalid date format -> 400', async () => {
    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions/regenerate',
        INTERNAL_TOKEN,
        { trade_date: '2026/08/07' },
    )

    assert.equal(res.status, 400)
    const body = res.body as { code: number }
    assert.equal(body.code, 400)
})

test('POST /internal/predictions/regenerate non-today trade_date -> 400', async () => {
    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions/regenerate',
        INTERNAL_TOKEN,
        { trade_date: '2000-01-01' },
    )

    assert.equal(res.status, 400)
    const body = res.body as { code: number; detail?: string }
    assert.equal(body.code, 400)
    assert.ok(String(body.detail).includes('only today'))
})

test('POST /internal/predictions/regenerate verified record -> 409', async () => {
    patchRedisIncr(1)
    __internalPredictionDependencies.list = (async () => ({
        rows: [{ verification: { short: { horizon: 'short', result: 'hit' } } }],
        total: 1,
    })) as unknown as typeof __internalPredictionDependencies.list

    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions/regenerate',
        INTERNAL_TOKEN,
        { trade_date: shanghaiToday() },
    )

    assert.equal(res.status, 409)
    const body = res.body as { code: number; detail?: string }
    assert.equal(body.code, 409)
    assert.ok(String(body.detail).includes('已验证预测拒绝覆盖'))
})

test('POST /internal/predictions/regenerate rate limit exceeded -> 429', async () => {
    patchRedisIncr(4) // 每小时窗口 >3 → 429

    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions/regenerate',
        INTERNAL_TOKEN,
        { trade_date: shanghaiToday() },
    )

    assert.equal(res.status, 429)
    const body = res.body as { code: number }
    assert.equal(body.code, 429)
})

test('POST /internal/predictions/regenerate success -> 200 透传上游 data', async () => {
    patchRedisIncr(1)
    __internalPredictionDependencies.list = (async () => ({ rows: [], total: 0 })) as typeof __internalPredictionDependencies.list
    let capturedUrl = ''
    let capturedInit: RequestInit = {}
    patchFetch(async (url, init) => {
        capturedUrl = url
        capturedInit = init
        return { status: 200, body: JSON.stringify({ ok: true, trade_date: shanghaiToday() }) }
    })

    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions/regenerate',
        INTERNAL_TOKEN,
        { trade_date: shanghaiToday() },
    )

    assert.equal(res.status, 200)
    assert.ok(capturedUrl.endsWith('/api/agent/internal/predictions/from-trace'))
    const headers = capturedInit.headers as Record<string, string>
    assert.equal(headers?.['x-internal-token'] || headers?.['X-Internal-Token'], INTERNAL_TOKEN)
    const body = res.body as { code: number; data: { ok: boolean } }
    assert.equal(body.code, 200)
    assert.equal(body.data.ok, true)
})

test('POST /internal/predictions/regenerate upstream 409 -> 409 透传', async () => {
    patchRedisIncr(1)
    __internalPredictionDependencies.list = (async () => ({ rows: [], total: 0 })) as typeof __internalPredictionDependencies.list
    patchFetch(async () => ({ status: 409, body: JSON.stringify({ message: 'conflict' }) }))

    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions/regenerate',
        INTERNAL_TOKEN,
        { trade_date: shanghaiToday() },
    )

    assert.equal(res.status, 409)
    const body = res.body as { code: number }
    assert.equal(body.code, 409)
})

test('POST /internal/predictions/regenerate upstream timeout -> 504', async () => {
    patchRedisIncr(1)
    __internalPredictionDependencies.list = (async () => ({ rows: [], total: 0 })) as typeof __internalPredictionDependencies.list
    __internalPredictionDependencies.regenerateTimeoutMs = 100
    // fetch 永不 resolve，仅响应 AbortController 的 abort
    patchFetch((_url, init) =>
        new Promise<MockFetchResponse>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )

    const res = await makeJsonRequest(
        port,
        'POST',
        '/internal/predictions/regenerate',
        INTERNAL_TOKEN,
        { trade_date: shanghaiToday() },
    )

    assert.equal(res.status, 504)
    const body = res.body as { code: number }
    assert.equal(body.code, 504)
})
