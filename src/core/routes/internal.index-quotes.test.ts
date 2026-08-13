/**
 * Task 8 (P5 工作线 B): GET /internal/index/quotes 路由测试
 *
 * 测试策略（适配 Node 原生 test runner，对齐 internal.kline.test.ts 组装方式）：
 * 1. 启动 Express HTTP 服务器（随机端口），挂载 internalRouter 于 /internal 前缀
 * 2. 通过 __indexQuoteDependencies 注入点替换 fetchTencentIndexQuotes
 *    （tsx 使用 ESM live binding，named import 不可 monkey-patch；
 *     与 ClsStockNewsService.__clsNewsDependencies / MarketSnapshotService.__marketSnapshotDependencies 同一约定）
 * 3. CacheService.get/set 静态方法可 patch（class 属性可变，与 kline 测试同一约定）
 * 4. 覆盖 200 驼峰形状 / 400（缺失、前缀、超 MAX_SYMBOLS）/ 502 服务异常 / 降级语义
 *
 * 降级语义说明：真实实现中 fetchTencentIndexQuotes 内部 try/catch 吞掉腾讯源错误并返回空 Map，
 * 因此"腾讯源失败"表现为 200 + 各指数 price/changePercent=null 保留 name（降级），而非 502；
 * 502 仅用于未预期异常（本测试通过注入点 mock 直接 throw 模拟）。
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
import { IndexQuoteController, __indexQuoteDependencies } from '../../modules/quote/indexController'
import { CacheService } from '../../shared/utils/CacheService'
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

/** 临时替换 CacheService.get 静态方法（与 kline 测试同款 patch 风格） */
function patchCacheGet(impl: (() => Promise<unknown>) | null): void {
    ;(CacheService as unknown as { get: unknown }).get = impl
        ? async () => impl()
        : undefined
}

/** 临时替换 CacheService.set 静态方法（记录调用，便于断言缓存写回） */
function patchCacheSet(impl: ((...args: unknown[]) => Promise<unknown>) | null): void {
    ;(CacheService as unknown as { set: unknown }).set = impl ?? undefined
}

type TencentIndexEntry = { value: number; change: number; changeAmount: number }

/** 替换 __indexQuoteDependencies.fetchTencentIndexQuotes 返回指定指数行情 */
function mockTencentFetch(entries: Record<string, TencentIndexEntry>): string[] {
    const capturedCodes: string[] = []
    __indexQuoteDependencies.fetchTencentIndexQuotes = async (codes: string[]) => {
        capturedCodes.push(...codes)
        const map = new Map<string, TencentIndexEntry & { code: string }>()
        for (const [code, entry] of Object.entries(entries)) {
            map.set(code, { code, ...entry })
        }
        return map
    }
    return capturedCodes
}

/** 快照并恢复全部测试桩，保证测试之间互不污染 */
function snapshotTestDoubles(): () => void {
    const deps = { ...__indexQuoteDependencies }
    const get = (CacheService as unknown as { get: unknown }).get
    const set = (CacheService as unknown as { set: unknown }).set
    const globalFetch = globalThis.fetch
    return () => {
        __indexQuoteDependencies.fetchTencentIndexQuotes = deps.fetchTencentIndexQuotes
        ;(CacheService as unknown as { get: unknown }).get = get
        ;(CacheService as unknown as { set: unknown }).set = set
        globalThis.fetch = globalFetch
    }
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

test('GET /internal/index/quotes?symbols=000001,399001,399006 -> 200 camelCase', async () => {
    const restore = snapshotTestDoubles()
    const setCalls: unknown[][] = []
    // 强制缓存未命中，走腾讯源拉取路径
    patchCacheGet(async () => null)
    patchCacheSet(async (...args: unknown[]) => { setCalls.push(args) })
    // 避免 writeCachedQuote 的真实 TTL 计算访问节假日 API（timor.tech）
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ code: 0, holiday: null }),
    })) as unknown as typeof fetch
    const capturedCodes = mockTencentFetch({
        '000001': { value: 3456.78, change: -0.36, changeAmount: -12.34 },
        '399001': { value: 10890.12, change: 0.85, changeAmount: 91.2 },
        '399006': { value: 2150.5, change: 1.23, changeAmount: 26.1 },
    })

    try {
        const res = await makeGetRequest(
            port,
            '/internal/index/quotes?symbols=000001,399001,399006',
            INTERNAL_TOKEN,
        )

        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: { indices: Array<Record<string, unknown>> } }
        assert.equal(body.code, 200)
        const indices = body.data.indices
        assert.equal(indices.length, 3)
        assert.deepEqual(indices[0], {
            index: '000001',
            name: '上证指数',
            price: 3456.78,
            changePercent: -0.36,
            changeAmount: -12.34,
        })
        assert.equal(indices[1].name, '深证成指')
        assert.equal(indices[2].name, '创业板指')
        // 腾讯码前缀组装正确：sh/sz + 6 位代码
        assert.deepEqual(capturedCodes, ['sh000001', 'sz399001', 'sz399006'])
        // 缓存写回：每个指数写入一次（中文键）
        assert.equal(setCalls.length, 3)
        const written = setCalls[0][1] as { data: Record<string, unknown> }
        assert.equal(written.data['指数简称'], '上证指数')
    } finally {
        restore()
    }
})

test('GET /internal/index/quotes (missing symbols) -> 400', async () => {
    const res = await makeGetRequest(port, '/internal/index/quotes', INTERNAL_TOKEN)

    assert.equal(res.status, 400)
    const body = res.body as { code: number }
    assert.equal(body.code, 400)
})

test('GET /internal/index/quotes?symbols=sh000001 -> 400 (带前缀只接受6位纯数字)', async () => {
    const res = await makeGetRequest(port, '/internal/index/quotes?symbols=sh000001', INTERNAL_TOKEN)

    assert.equal(res.status, 400)
    const body = res.body as { code: number }
    assert.equal(body.code, 400)
})

test('GET /internal/index/quotes -> 502 when fetch throws (未预期服务异常)', async () => {
    const restore = snapshotTestDoubles()
    patchCacheGet(async () => null)
    __indexQuoteDependencies.fetchTencentIndexQuotes = async () => {
        throw new Error('tencent down')
    }

    try {
        const res = await makeGetRequest(port, '/internal/index/quotes?symbols=000001', INTERNAL_TOKEN)

        assert.equal(res.status, 502)
        const body = res.body as { code: number; message: string }
        assert.equal(body.code, 502)
        assert.equal(body.message, 'tencent down')
    } finally {
        restore()
    }
})

test('GET /internal/index/quotes -> 200 with nulls when Tencent source degraded (降级语义)', async () => {
    const restore = snapshotTestDoubles()
    patchCacheGet(async () => null)
    // 腾讯源返回空 Map（解析失败/无数据）：逐指数降级为 null，保留 name，不整体 500/502
    __indexQuoteDependencies.fetchTencentIndexQuotes = async () => new Map()

    try {
        const res = await makeGetRequest(port, '/internal/index/quotes?symbols=000001,399006', INTERNAL_TOKEN)

        assert.equal(res.status, 200)
        const body = res.body as { code: number; data: { indices: Array<Record<string, unknown>> } }
        assert.equal(body.code, 200)
        assert.equal(body.data.indices.length, 2)
        assert.deepEqual(body.data.indices[0], {
            index: '000001',
            name: '上证指数',
            price: null,
            changePercent: null,
            changeAmount: null,
        })
        assert.deepEqual(body.data.indices[1], {
            index: '399006',
            name: '创业板指',
            price: null,
            changePercent: null,
            changeAmount: null,
        })
    } finally {
        restore()
    }
})

test('GET /internal/index/quotes -> 400 when symbols exceed MAX_SYMBOLS', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => String(100000 + i)).join(',')
    const res = await makeGetRequest(port, `/internal/index/quotes?symbols=${tooMany}`, INTERNAL_TOKEN)

    assert.equal(res.status, 400)
    const body = res.body as { code: number }
    assert.equal(body.code, 400)
})

// 引用 IndexQuoteController 仅为确保模块加载路径与路由一致（防止 tree-shaking 类误判），
// 断言全部经由 HTTP 请求完成。
void IndexQuoteController
