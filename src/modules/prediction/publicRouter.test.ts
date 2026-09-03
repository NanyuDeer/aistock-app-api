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
  __predictionPublicDependencies.listAllForStats = async (status?: 'pending' | 'verified' | 'skipped') =>
    status ? rows.filter((r) => r.status === status) : rows
  __predictionPublicDependencies.list = async (params: { status?: 'pending' | 'verified' | 'skipped'; source_id?: string; page: number; pageSize: number }) => {
    const filtered = params.status ? rows.filter((r) => r.status === params.status) : rows
    return { rows: filtered, total: filtered.length }
  }

  const res = await makeJsonRequest(port, '/api/predictions?page=1&pageSize=20')
  assert.equal(res.status, 200)
  const body = res.body as {
    code: number
    data: {
      items: Array<{ id: number; report_date: string }>
      stats: { total: number; pendingCount: number; verifiedCount: number; skippedCount: number; hitRate: number | null; verifiedHorizonCount: number; hitCount: number; missCount: number }
      pagination: { page: number; pageSize: number; total: number }
    }
  }
  assert.equal(body.code, 200)
  assert.equal(body.data.items.length, 2)
  assert.equal(body.data.items[0]!.report_date, '2026-08-07')
  assert.equal(body.data.stats.total, 2)
  assert.equal(body.data.stats.pendingCount, 1)
  assert.equal(body.data.stats.verifiedCount, 1)
  assert.equal(body.data.stats.skippedCount, 0)
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

test('GET /api/predictions?status=skipped -> 200：skipped 过滤生效', async () => {
  const rows = [baseRow({ id: 1, status: 'skipped' })]
  let capturedStatus: unknown
  __predictionPublicDependencies.listAllForStats = async (status?: 'pending' | 'verified' | 'skipped') => {
    capturedStatus = status
    return status ? rows.filter((r) => r.status === status) : rows
  }
  __predictionPublicDependencies.list = async (params: { status?: 'pending' | 'verified' | 'skipped'; source_id?: string; page: number; pageSize: number }) => {
    const filtered = params.status ? rows.filter((r) => r.status === params.status) : rows
    return { rows: filtered, total: filtered.length }
  }

  const res = await makeJsonRequest(port, '/api/predictions?status=skipped')
  assert.equal(res.status, 200)
  assert.equal(capturedStatus, 'skipped')
  const body = res.body as {
    data: { stats: { total: number; skippedCount: number; pendingCount: number; verifiedCount: number }; pagination: { total: number } }
  }
  assert.equal(body.data.stats.total, 1)
  assert.equal(body.data.stats.skippedCount, 1)
  assert.equal(body.data.stats.pendingCount, 0)
  assert.equal(body.data.stats.verifiedCount, 0)
  assert.equal(body.data.pagination.total, 1)
})

test('GET /api/predictions?source_id=review:2026-08-07 -> 200：source_id 过滤生效', async () => {
  const rows = [baseRow()]
  let capturedSourceId: unknown
  let capturedListSourceId: unknown
  __predictionPublicDependencies.listAllForStats = async (_status?: 'pending' | 'verified' | 'skipped', source_id?: string) => {
    capturedSourceId = source_id
    return rows
  }
  __predictionPublicDependencies.list = async (params: { status?: 'pending' | 'verified' | 'skipped'; source_id?: string; page: number; pageSize: number }) => {
    capturedListSourceId = params.source_id
    return { rows, total: rows.length }
  }

  const res = await makeJsonRequest(port, '/api/predictions?source_id=review:2026-08-07')
  assert.equal(res.status, 200)
  assert.equal(capturedSourceId, 'review:2026-08-07')
  assert.equal(capturedListSourceId, 'review:2026-08-07')
})

test('GET /api/predictions?source_id=bad-format -> 400', async () => {
  const res = await makeJsonRequest(port, '/api/predictions?source_id=2026-08-07')
  assert.equal(res.status, 400)
  const body = res.body as { code: number }
  assert.equal(body.code, 400)
})

test('GET /api/predictions?source_type=market_trace -> 200：source_type 过滤透传（列表与统计同口径）', async () => {
  const rows = [baseRow()]
  let capturedType: unknown
  let capturedListType: unknown
  __predictionPublicDependencies.listAllForStats = async (_status?: 'pending' | 'verified' | 'skipped', _source_id?: string, source_type?: 'market_trace' | 'sector_prediction') => {
    capturedType = source_type
    return rows
  }
  __predictionPublicDependencies.list = async (params: { status?: 'pending' | 'verified' | 'skipped'; source_id?: string; source_type?: 'market_trace' | 'sector_prediction'; page: number; pageSize: number }) => {
    capturedListType = params.source_type
    return { rows, total: rows.length }
  }

  const res = await makeJsonRequest(port, '/api/predictions?source_type=market_trace')
  assert.equal(res.status, 200)
  assert.equal(capturedType, 'market_trace')
  assert.equal(capturedListType, 'market_trace')
})

test('GET /api/predictions?source_type=bad -> 400', async () => {
  const res = await makeJsonRequest(port, '/api/predictions?source_type=bad')
  assert.equal(res.status, 400)
  const body = res.body as { code: number }
  assert.equal(body.code, 400)
})

test('GET /api/predictions -> 200：computeStats 显式跳过 skipped 行（skippedCount 单独统计）', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'pending',
      verification: { short: { horizon: 'short', result: 'hit' as const, actual: '+1.00%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' } },
    }),
    baseRow({
      id: 2,
      status: 'verified',
      source_id: 'review:2026-08-08',
      created_at: '2026-08-08T12:00:00.000Z',
      due_dates: { short: '2026-08-18', mid: '2026-09-09', long: '2027-01-06' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, actual: '+0.50%', reason: 'x', verified_at: '2026-08-18T08:00:00.000Z' },
        mid: { horizon: 'mid', result: 'miss' as const, actual: '-0.80%', reason: 'x', verified_at: '2026-09-09T08:00:00.000Z' },
        long: { horizon: 'long', result: 'insufficient' as const, actual: '', reason: '无数据源', verified_at: '2027-01-06T08:00:00.000Z' },
      },
    }),
    // skipped 行即使带 verification 内容也不计入 pending/verified/命中统计
    baseRow({
      id: 3,
      status: 'skipped',
      source_id: 'review:2026-08-09',
      created_at: '2026-08-09T12:00:00.000Z',
      verification: { short: { horizon: 'short', result: 'hit' as const, actual: '+2.00%', reason: 'x', verified_at: '2026-08-19T08:00:00.000Z' } },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  assert.equal(res.status, 200)
  const body = res.body as {
    data: { stats: { total: number; pendingCount: number; verifiedCount: number; skippedCount: number; verifiedHorizonCount: number; hitCount: number; missCount: number; hitRate: number | null } }
  }
  assert.equal(body.data.stats.total, 3)
  assert.equal(body.data.stats.skippedCount, 1)
  assert.equal(body.data.stats.pendingCount, 1)
  assert.equal(body.data.stats.verifiedCount, 1)
  // row3(skipped) 的 short 档位不计入：1(row1) + 3(row2) = 4
  assert.equal(body.data.stats.verifiedHorizonCount, 4)
  // row3(skipped) 的 hit 不计入：1(row1) + 1(row2 short) = 2
  assert.equal(body.data.stats.hitCount, 2)
  assert.equal(body.data.stats.missCount, 1)
  assert.equal(body.data.stats.hitRate, 2 / 3)
})

test('GET /api/predictions -> 200：越年近似档不计入命中率分母（approximateHorizonCount 单独统计）', async () => {
  const rows = [
    baseRow({
      id: 1,
      prediction: {
        ...baseRow().prediction,
        due_dates_approximate: ['mid', 'long'],
      },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, actual: '+1.00%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
        mid: { horizon: 'mid', result: 'miss' as const, actual: '-0.80%', reason: 'x', verified_at: '2026-09-08T08:00:00.000Z' },
        long: { horizon: 'long', result: 'hit' as const, actual: '+1.50%', reason: 'x', verified_at: '2027-01-05T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  assert.equal(res.status, 200)
  const body = res.body as {
    data: { stats: { verifiedHorizonCount: number; hitCount: number; missCount: number; hitRate: number | null; approximateHorizonCount: number } }
  }
  // 近似档照常验证（档位进度不受影响）：short/mid/long 三档均有 verification
  assert.equal(body.data.stats.verifiedHorizonCount, 3)
  // 命中率只统计精确档 short：hit=1；mid/long 近似档不混入分母
  assert.equal(body.data.stats.hitCount, 1)
  assert.equal(body.data.stats.missCount, 0)
  assert.equal(body.data.stats.approximateHorizonCount, 2)
  assert.equal(body.data.stats.hitRate, 1)
})

interface BucketShape {
  n: number
  hits: number
  hitRate: number
  sufficientSample: boolean
}
interface BucketStatsShape {
  combined: BucketShape
  index: BucketShape
  sector: BucketShape
}

test('GET /api/predictions -> 200：bucketStats 按 target_type 分桶（index/sector 各计各的）', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'verified',
      source_id: 'review:2026-08-07',
      due_dates: { short: '2026-08-17', mid: '2026-09-08', long: '2027-01-05' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, target_type: 'index', actual: '+1.23%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
        mid: { horizon: 'mid', result: 'miss' as const, target_type: 'sector', actual: '-0.80%', reason: 'x', verified_at: '2026-09-08T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  assert.equal(res.status, 200)
  const body = res.body as { data: { stats: { bucketStats: BucketStatsShape } } }
  assert.equal(body.data.stats.bucketStats.index.n, 1)
  assert.equal(body.data.stats.bucketStats.index.hits, 1)
  assert.equal(body.data.stats.bucketStats.index.hitRate, 1)
  assert.equal(body.data.stats.bucketStats.index.sufficientSample, false)
  assert.equal(body.data.stats.bucketStats.sector.n, 1)
  assert.equal(body.data.stats.bucketStats.sector.hits, 0)
  assert.equal(body.data.stats.bucketStats.sector.hitRate, 0)
  assert.equal(body.data.stats.bucketStats.sector.sufficientSample, false)
  assert.equal(body.data.stats.bucketStats.combined.n, 2)
  assert.equal(body.data.stats.bucketStats.combined.hits, 1)
  assert.equal(body.data.stats.bucketStats.combined.hitRate, 0.5)
})

test('GET /api/predictions -> 200：bucketStats 旧记录无 target_type 归 index 且跳过 skipped 行', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'pending',
      verification: { short: { horizon: 'short', result: 'hit' as const, actual: '+1.00%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' } },
    }),
    // skipped 行即使带 verification（sector hit）也不计入分桶（与 computeStats 口径一致）
    baseRow({
      id: 2,
      status: 'skipped',
      source_id: 'review:2026-08-09',
      created_at: '2026-08-09T12:00:00.000Z',
      verification: { short: { horizon: 'short', result: 'hit' as const, target_type: 'sector', actual: '+2.00%', reason: 'x', verified_at: '2026-08-19T08:00:00.000Z' } },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  assert.equal(res.status, 200)
  const body = res.body as { data: { stats: { bucketStats: BucketStatsShape } } }
  // 无 target_type 旧记录归 index
  assert.equal(body.data.stats.bucketStats.index.n, 1)
  assert.equal(body.data.stats.bucketStats.index.hits, 1)
  // skipped 行的 sector hit 不计入分桶
  assert.equal(body.data.stats.bucketStats.sector.n, 0)
  assert.equal(body.data.stats.bucketStats.sector.hits, 0)
  assert.equal(body.data.stats.bucketStats.combined.n, 1)
  assert.equal(body.data.stats.bucketStats.combined.hits, 1)
})

// ============ 阶段 0：methodology_version 版本过滤（默认 2.0，防跳变/混桶） ============

test('GET /api/predictions -> 200：版本过滤（默认 2.0）——3.0 命中不计入命中率但计入档位进度', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'verified',
      source_id: 'review:2026-08-07',
      due_dates: { short: '2026-08-17' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '2.0' as const, target_type: 'index' as const, actual: '+1.00%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
      },
    }),
    baseRow({
      id: 2,
      status: 'verified',
      source_id: 'review:2026-08-08',
      created_at: '2026-08-08T12:00:00.000Z',
      due_dates: { short: '2026-08-18', mid: '2026-09-09' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '3.0' as const, target_type: 'index' as const, actual: '+0.50%', reason: 'x', verified_at: '2026-08-18T08:00:00.000Z' },
        mid: { horizon: 'mid', result: 'miss' as const, methodology_version: '3.0' as const, target_type: 'index' as const, actual: '-0.80%', reason: 'x', verified_at: '2026-09-09T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  assert.equal(res.status, 200)
  const body = res.body as {
    data: { stats: { verifiedHorizonCount: number; hitCount: number; missCount: number; hitRate: number | null; bucketStats: BucketStatsShape } }
  }
  // 进度全量（版本无关）：1(row1) + 2(row2) = 3 档
  assert.equal(body.data.stats.verifiedHorizonCount, 3)
  // 命中率只统计 2.0：row1 short hit → hitCount=1, missCount=0, hitRate=1（3.0 两档隔离）
  assert.equal(body.data.stats.hitCount, 1)
  assert.equal(body.data.stats.missCount, 0)
  assert.equal(body.data.stats.hitRate, 1)
  // bucketStats 同套版本过滤
  assert.equal(body.data.stats.bucketStats.combined.n, 1)
  assert.equal(body.data.stats.bucketStats.combined.hits, 1)
  // 【阶段 0 门禁断言】同响应 hitRate === bucketStats.combined.hitRate
  assert.equal(body.data.stats.hitRate, body.data.stats.bucketStats.combined.hitRate)
})

test('GET /api/predictions -> 200：无版本旧记录兼容视为 2.0（默认过滤，防跳变）', async () => {
  // verification entry 缺 methodology_version（2.0 时代存量）→ 默认过滤 2.0 下计入
  const rows = [
    baseRow({
      id: 1,
      status: 'verified',
      source_id: 'review:2026-08-07',
      due_dates: { short: '2026-08-17' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, target_type: 'index' as const, actual: '+1.00%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  assert.equal(res.status, 200)
  const body = res.body as {
    data: { stats: { hitCount: number; hitRate: number | null; bucketStats: BucketStatsShape } }
  }
  assert.equal(body.data.stats.hitCount, 1)
  assert.equal(body.data.stats.hitRate, 1)
  assert.equal(body.data.stats.bucketStats.combined.n, 1)
  assert.equal(body.data.stats.hitRate, body.data.stats.bucketStats.combined.hitRate)
})
