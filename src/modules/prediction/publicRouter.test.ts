/**
 * Task 1: /api/predictions public 路由测试（适配 Node 原生 test runner）
 *
 * 测试策略：通过 __predictionPublicDependencies 注入点 mock Service 层（不触达 PG），
 * 覆盖输入校验（400）、列表/统计口径、详情、404。路由 import 链仍加载 core/db pool
 * （pg Pool 惰性连接，不会在无 DB 环境抛错），after 中显式关闭。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { after, before } from 'node:test'
import express from 'express'

import predictionPublicRouter, { __predictionPublicDependencies } from './publicRouter'
import pool from '../../core/db'

const ORIGINAL_DEPS = { ...__predictionPublicDependencies }

const HORIZONS = [
  { horizon: 'short', remaining_estimate: '1-2 周', phase: 'building', direction: 'bullish', target: '上证指数', metric_projection: '预计区间', confidence: 'high' },
  { horizon: 'mid', remaining_estimate: '3-4 周', phase: 'peaking', direction: 'bullish', target: '上证指数', metric_projection: '预计区间', confidence: 'medium' },
  { horizon: 'long', remaining_estimate: '1-3 月', phase: 'decaying', direction: 'neutral', target: '上证指数', metric_projection: '预计区间', confidence: 'low' },
] as const

const baseRow = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  source_type: 'market_trace',
  source_id: 'review:2026-08-07',
  schema_version: '1.0',
  prediction: {
    schema_version: '1.0',
    prediction_status: 'confirmed',
    attribution_summary: '政策预期升温推动主线',
    horizons: HORIZONS,
    evolution_steps: [],
    evolution_narrative: '',
    risks: [],
  },
  due_dates: { short: '2026-08-17', mid: '2026-09-08', long: '2027-01-05' },
  verification: {
    short: { horizon: 'short', result: 'hit' as const, actual: '+1.23%', reason: '方向=bullish', verified_at: '2026-08-17T08:00:00.000Z' },
  },
  status: 'pending',
  created_at: '2026-08-07T12:00:00.000Z',
  ...overrides,
})

interface HttpResponse {
  status: number
  body: unknown
}

function makeJsonRequest(port: number, path: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => (data += chunk.toString()))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(data) })
        } catch {
          resolve({ status: res.statusCode || 0, body: data })
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

let server: http.Server
let port: number

before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/predictions', predictionPublicRouter)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  port = (server.address() as AddressInfo).port
})

after(async () => {
  __predictionPublicDependencies.list = ORIGINAL_DEPS.list
  __predictionPublicDependencies.listAllForStats = ORIGINAL_DEPS.listAllForStats
  __predictionPublicDependencies.getById = ORIGINAL_DEPS.getById
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await pool.end()
})

test('GET /api/predictions?status=bad -> 400', async () => {
  const res = await makeJsonRequest(port, '/api/predictions?status=bad')
  assert.equal(res.status, 400)
  assert.equal((res.body as { code: number }).code, 400)
})

test('GET /api/predictions/abc -> 400', async () => {
  const res = await makeJsonRequest(port, '/api/predictions/abc')
  assert.equal(res.status, 400)
  assert.equal((res.body as { code: number }).code, 400)
})

test('GET /api/predictions -> 200：列表/统计/分页正确', async () => {
  const rows = [
    baseRow({ id: 1 }),
    baseRow({
      id: 2,
      source_id: 'review:2026-08-08',
      created_at: '2026-08-08T12:00:00.000Z',
      status: 'verified',
      due_dates: { short: '2026-08-18', mid: '2026-09-09', long: '2027-01-06' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, actual: '+0.50%', reason: 'x', verified_at: '2026-08-18T08:00:00.000Z' },
        mid: { horizon: 'mid', result: 'miss' as const, actual: '-0.80%', reason: 'x', verified_at: '2026-09-09T08:00:00.000Z' },
        long: { horizon: 'long', result: 'insufficient' as const, actual: '', reason: '无数据源', verified_at: '2027-01-06T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async (status?: 'pending' | 'verified') =>
    status ? rows.filter((r) => r.status === status) : rows
  __predictionPublicDependencies.list = async (params: { status?: 'pending' | 'verified'; page: number; pageSize: number }) => {
    const filtered = params.status ? rows.filter((r) => r.status === params.status) : rows
    return { rows: filtered, total: filtered.length }
  }

  const res = await makeJsonRequest(port, '/api/predictions?page=1&pageSize=20')
  assert.equal(res.status, 200)
  const body = res.body as {
    code: number
    data: {
      items: Array<{ id: number; report_date: string }>
      stats: { total: number; pendingCount: number; verifiedCount: number; hitRate: number | null; verifiedHorizonCount: number; hitCount: number; missCount: number }
      pagination: { page: number; pageSize: number; total: number }
    }
  }
  assert.equal(body.code, 200)
  assert.equal(body.data.items.length, 2)
  assert.equal(body.data.items[0]!.report_date, '2026-08-07')
  assert.equal(body.data.stats.total, 2)
  assert.equal(body.data.stats.pendingCount, 1)
  assert.equal(body.data.stats.verifiedCount, 1)
  // 档位验证：short(hit)+mid(miss)+long(insufficient 计入档位数) → 命中率 2/3
  assert.equal(body.data.stats.verifiedHorizonCount, 4)
  assert.equal(body.data.stats.hitCount, 2)
  assert.equal(body.data.stats.missCount, 1)
  assert.equal(body.data.stats.hitRate, 2 / 3)
  assert.deepEqual(body.data.pagination, { page: 1, pageSize: 20, total: 2 })
})

test('GET /api/predictions -> 200：无验证档位时 hitRate 为 null', async () => {
  const rows = [baseRow({ id: 1, verification: {} })]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  const body = res.body as { data: { stats: { hitRate: number | null } } }
  assert.equal(body.data.stats.hitRate, null)
})

test('GET /api/predictions/1 -> 200：详情含 report_date', async () => {
  __predictionPublicDependencies.getById = async (id: number) => (id === 1 ? baseRow() : null)
  const res = await makeJsonRequest(port, '/api/predictions/1')
  assert.equal(res.status, 200)
  const body = res.body as { data: { id: number; report_date: string } }
  assert.equal(body.data.id, 1)
  assert.equal(body.data.report_date, '2026-08-07')
})

test('GET /api/predictions/999 -> 404', async () => {
  __predictionPublicDependencies.getById = async () => null
  const res = await makeJsonRequest(port, '/api/predictions/999')
  assert.equal(res.status, 404)
})
