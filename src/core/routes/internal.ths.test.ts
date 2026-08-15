/**
 * M2 板块验证: GET /internal/ths/index-map 路由测试（Task 1）
 *
 * 组装方式对齐 internal.index-kline.test.ts：随机端口监听 + x-internal-token；
 * monkey-patch ThsBoardService.__indexMapDeps（不触达真实 Tushare）。
 *
 * 相对 brief 的四处一致性微调（详见 task-1-report.md）：
 * 1. 挂载 '/internal' 前缀（仓库既有惯例；brief 示例裸挂载 + /internal/... 请求路径会 404）
 * 2. mock 按 type 区分 N=概念 / I=行业 各返回 1 条 → 全表合并后 ts_codes.length === 2（与断言一致）
 * 3. 每个用例前 __resetIndexMapCache()：用例 1 会填充进程缓存，不重置则用例 2 命中缓存返回 200 而非 502
 * 4. 拆解改用 redis.disconnect()（对齐 internal.index-kline.test.ts 惯例；
 *    拆解期 CacheService 降级 WARN 为本机 Redis 环境噪音，不影响断言）
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { after, before } from 'node:test'
import express from 'express'
import internalRouter from './internal'
import * as ThsBoardService from '../../modules/quote/ThsBoardService'
import pool from '../db'
import redis from '../redis'
import { closeAllAgents } from '../../shared/utils/httpAgent'

const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production'
interface HttpResponse { status: number; body: unknown }
function makeGetRequest(port: number, path: string, token?: string): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {}
        if (token !== undefined) headers['x-internal-token'] = token
        const req = http.get({ hostname: '127.0.0.1', port, path, headers }, (res) => {
            let data = ''
            res.on('data', (c: Buffer) => (data += c.toString()))
            res.on('end', () => {
                try { resolve({ status: res.statusCode || 0, body: JSON.parse(data) }) }
                catch { resolve({ status: res.statusCode || 0, body: data }) }
            })
        })
        req.on('error', reject)
    })
}

let server: http.Server
let port: number
before(async () => {
    const app = express()
    app.use('/internal', internalRouter)
    server = app.listen(0)
    await new Promise<void>((r) => server.once('listening', r))
    port = (server.address() as AddressInfo).port
})
after(async () => {
    server?.close()
    await pool.end().catch(() => {})
    redis.disconnect()
    await closeAllAgents()
})

/** monkey-patch 注入：tsx ESM 下 namespace 绑定只读（getter），按仓库惯例（__marketEventHandlers）
 * 只替换 __indexMapDeps 对象的 getThsIndex 属性，不重绑命名空间本身。 */
function patchGetThsIndex(impl: ThsBoardService.ThsBoardDeps['getThsIndex']): void {
    ThsBoardService.__indexMapDeps.getThsIndex = impl
}

test('GET /internal/ths/index-map -> 200 返回全表 + updated_at', async () => {
    // monkey-patch 真实取数层（N=概念 / I=行业 各 1 条 → 全表 2 条）
    patchGetThsIndex(async (type: string) => (type === 'N'
        ? [{ ts_code: '885525.TI', name: '白酒概念', count: 20, exchange: 'A', list_date: '20140415', type: 'N' }]
        : [{ ts_code: '881121.TI', name: '半导体', count: 100, exchange: 'A', list_date: '20070101', type: 'I' }]))
    ThsBoardService.__resetIndexMapCache()
    const res = await makeGetRequest(port, '/internal/ths/index-map', INTERNAL_TOKEN)
    assert.equal(res.status, 200)
    const body = res.body as { code: number; data: { ts_codes: unknown[]; updated_at: string } }
    assert.equal(body.code, 200)
    assert.equal(body.data.ts_codes.length, 2)
    assert.ok(body.data.updated_at)
})

test('GET /internal/ths/index-map -> 取数失败 502', async () => {
    patchGetThsIndex(async () => { throw new Error('boom') })
    ThsBoardService.__resetIndexMapCache()
    const res = await makeGetRequest(port, '/internal/ths/index-map', INTERNAL_TOKEN)
    assert.equal(res.status, 502)
})

// ============ Task 2: GET /internal/ths/resolve（三级匹配） ============
// 与 Task 1 同款约定：resolveBoardName 内部走 getIndexMap()（进程缓存 + 6h TTL），
// 故每个用例先 patchGetThsIndex 注入 mock，再 __resetIndexMapCache() 隔离缓存，
// 避免命中上一用例的缓存（不用 brief 的 namespace 赋值——ESM/tsx 下会抛只读绑定错误）。

test('GET /internal/ths/resolve?name=白酒板块 -> 归一化精确命中', async () => {
    patchGetThsIndex(async () => [
        { ts_code: '885525.TI', name: '白酒概念', count: 20, exchange: 'A', list_date: '20140415', type: 'N' },
    ])
    ThsBoardService.__resetIndexMapCache()
    const res = await makeGetRequest(port, '/internal/ths/resolve?name=' + encodeURIComponent('白酒板块'), INTERNAL_TOKEN)
    assert.equal(res.status, 200)
    const body = res.body as { code: number; data: { matched: { ts_code: string; name: string } | null } }
    assert.equal(body.code, 200)
    const matched = body.data.matched
    assert.equal(matched?.ts_code, '885525.TI')
    assert.equal(matched?.name, '白酒概念')
})

test('GET /internal/ths/resolve?name=不存在的板块 -> matched null', async () => {
    patchGetThsIndex(async () => [
        { ts_code: '885525.TI', name: '白酒概念', count: 20, exchange: 'A', list_date: '20140415', type: 'N' },
    ])
    ThsBoardService.__resetIndexMapCache()
    const res = await makeGetRequest(port, '/internal/ths/resolve?name=' + encodeURIComponent('不存在板块'), INTERNAL_TOKEN)
    assert.equal(res.status, 200)
    const body = res.body as { code: number; data: { matched: { ts_code: string; name: string } | null } }
    assert.equal(body.code, 200)
    assert.equal(body.data.matched, null)
})

test('GET /internal/ths/resolve 缺 name -> 400', async () => {
    const res = await makeGetRequest(port, '/internal/ths/resolve', INTERNAL_TOKEN)
    assert.equal(res.status, 400)
    assert.equal((res.body as { code: number }).code, 400)
})
