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
    short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, actual: '+1.23%', reason: '方向=bullish', verified_at: '2026-08-17T08:00:00.000Z' },
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
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, actual: '+0.50%', reason: 'x', verified_at: '2026-08-18T08:00:00.000Z' },
        mid: { horizon: 'mid', result: 'miss' as const, methodology_version: '4.0' as const, actual: '-0.80%', reason: 'x', verified_at: '2026-09-09T08:00:00.000Z' },
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
      verification: { short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, actual: '+1.00%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' } },
    }),
    baseRow({
      id: 2,
      status: 'verified',
      source_id: 'review:2026-08-08',
      created_at: '2026-08-08T12:00:00.000Z',
      due_dates: { short: '2026-08-18', mid: '2026-09-09', long: '2027-01-06' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, actual: '+0.50%', reason: 'x', verified_at: '2026-08-18T08:00:00.000Z' },
        mid: { horizon: 'mid', result: 'miss' as const, methodology_version: '4.0' as const, actual: '-0.80%', reason: 'x', verified_at: '2026-09-09T08:00:00.000Z' },
        long: { horizon: 'long', result: 'insufficient' as const, actual: '', reason: '无数据源', verified_at: '2027-01-06T08:00:00.000Z' },
      },
    }),
    // skipped 行即使带 verification 内容也不计入 pending/verified/命中统计
    baseRow({
      id: 3,
      status: 'skipped',
      source_id: 'review:2026-08-09',
      created_at: '2026-08-09T12:00:00.000Z',
      verification: { short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, actual: '+2.00%', reason: 'x', verified_at: '2026-08-19T08:00:00.000Z' } },
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
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, actual: '+1.00%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
        mid: { horizon: 'mid', result: 'miss' as const, methodology_version: '4.0' as const, actual: '-0.80%', reason: 'x', verified_at: '2026-09-08T08:00:00.000Z' },
        long: { horizon: 'long', result: 'hit' as const, methodology_version: '4.0' as const, actual: '+1.50%', reason: 'x', verified_at: '2027-01-05T08:00:00.000Z' },
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
  long_excluded: boolean
  settled_ratio: number | null
  flat_rate: number | null
  flat_count: number
  directional_count: number
  long: { n: number; hits: number; hitRate: number | null }
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
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index', actual: '+1.23%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
        mid: { horizon: 'mid', result: 'miss' as const, methodology_version: '4.0' as const, target_type: 'sector', actual: '-0.80%', reason: 'x', verified_at: '2026-09-08T08:00:00.000Z' },
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
      verification: { short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, actual: '+1.00%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' } },
    }),
    // skipped 行即使带 verification（sector hit）也不计入分桶（与 computeStats 口径一致）
    baseRow({
      id: 2,
      status: 'skipped',
      source_id: 'review:2026-08-09',
      created_at: '2026-08-09T12:00:00.000Z',
      verification: { short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'sector', actual: '+2.00%', reason: 'x', verified_at: '2026-08-19T08:00:00.000Z' } },
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

// ============ methodology_version 版本过滤（默认当前生产版本 4.0，防跳变/混桶） ============

test('GET /api/predictions -> 200：版本过滤（默认 4.0）——3.0 命中不计入命中率但计入档位进度', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'verified',
      source_id: 'review:2026-08-07',
      due_dates: { short: '2026-08-17' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, actual: '+1.00%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
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
  // 命中率只统计 4.0：row1 short hit → hitCount=1, missCount=0, hitRate=1（3.0 两档隔离）
  assert.equal(body.data.stats.hitCount, 1)
  assert.equal(body.data.stats.missCount, 0)
  assert.equal(body.data.stats.hitRate, 1)
  // bucketStats 同套版本过滤
  assert.equal(body.data.stats.bucketStats.combined.n, 1)
  assert.equal(body.data.stats.bucketStats.combined.hits, 1)
  // 【阶段 0 门禁断言】同响应 hitRate === bucketStats.combined.hitRate
  assert.equal(body.data.stats.hitRate, body.data.stats.bucketStats.combined.hitRate)
})

test('GET /api/predictions -> 200：无版本旧记录默认（4.0）下隔离，不再兼容计入', async () => {
  // verification entry 缺 methodology_version（2.0 时代存量）→ 默认过滤 4.0 下不计入命中率
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
  assert.equal(body.data.stats.hitCount, 0)
  assert.equal(body.data.stats.hitRate, null)
  assert.equal(body.data.stats.bucketStats.combined.n, 0)
})

// ============ Task 5：long 档不计入迭代看板 + 补看板指标 ============

test('GET /api/predictions -> 200：long 档排除出迭代看板（long_excluded），命中率不含 long', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'verified',
      due_dates: { short: '2026-08-17', mid: '2026-09-08', long: '2027-01-05' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'bullish', actual: '+1.20%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
        long: { horizon: 'long', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'bullish', actual: '+8.00%', reason: 'x', verified_at: '2027-01-05T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  const body = res.body as {
    data: { stats: {
      hitCount: number; missCount: number; hitRate: number | null; verifiedHorizonCount: number
      long_excluded: boolean; settled_ratio: number | null; flat_count: number; directional_count: number
      bucketStats: BucketStatsShape
    } }
  }
  // 命中率不含 long：只有 short 进分子分母 → hitCount=1，hitRate=1（long hit 被排除）
  assert.equal(body.data.stats.hitCount, 1)
  assert.equal(body.data.stats.missCount, 0)
  assert.equal(body.data.stats.hitRate, 1)
  // 档位进度照旧计入 long（版本无关的覆盖度）
  assert.equal(body.data.stats.verifiedHorizonCount, 2)
  assert.equal(body.data.stats.long_excluded, true)
  // 分母 = 非-long 声明档（short + mid）= 2；已结算 = 1
  assert.equal(body.data.stats.settled_ratio, 0.5)
  // bucketStats 同口径排除 long
  assert.equal(body.data.stats.bucketStats.combined.n, 1)
  assert.equal(body.data.stats.bucketStats.combined.long_excluded, true)
})

test('GET /api/predictions -> 200：flat_rate 分母为方向预判数（读 entry.flat，不自行算 k）', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'verified',
      due_dates: { short: '2026-08-17', mid: '2026-09-08' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'bullish', actual: '+1.20%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
        mid: { horizon: 'mid', result: 'miss' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'bullish', flat: true, actual: '+0.10%', reason: 'x', verified_at: '2026-09-08T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  const body = res.body as {
    data: { stats: { flat_count: number; directional_count: number; flat_rate: number | null } }
  }
  assert.equal(body.data.stats.directional_count, 2)
  assert.equal(body.data.stats.flat_count, 1)
  assert.equal(body.data.stats.flat_rate, 0.5)  // 1/2（方向数），非 1/(1+n)
})

test('GET /api/predictions -> 200：flat_rate 无方向样本时为 null（不除零）', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'verified',
      due_dates: { short: '2026-08-17', mid: '2026-09-08' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'neutral', actual: '+0.10%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
        mid: { horizon: 'mid', result: 'miss' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'neutral', actual: '+1.20%', reason: 'x', verified_at: '2026-09-08T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  const body = res.body as {
    data: { stats: { directional_count: number; flat_count: number; flat_rate: number | null } }
  }
  assert.equal(body.data.stats.directional_count, 0)
  assert.equal(body.data.stats.flat_count, 0)
  assert.equal(body.data.stats.flat_rate, null)
})

test('GET /api/predictions -> 200：settled_ratio 含未结算 pending 档，无档位时为 null', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'pending',
      // short/mid 声明但只有 short 有 verification（mid 未结算）→ 分母含 mid
      due_dates: { short: '2026-08-17', mid: '2026-09-08' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'bullish', actual: '+1.20%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  const body = res.body as { data: { stats: { settled_ratio: number | null } } }
  assert.equal(body.data.stats.settled_ratio, 0.5)  // 1 已结算 / 2 非-long 档

  // 无档位 → null（不除零）
  const emptyRows = [baseRow({ id: 2, verification: {} })]
  __predictionPublicDependencies.listAllForStats = async () => emptyRows
  __predictionPublicDependencies.list = async () => ({ rows: emptyRows, total: 1 })
  const res2 = await makeJsonRequest(port, '/api/predictions')
  const body2 = res2.body as { data: { stats: { settled_ratio: number | null } } }
  // HORIZONS 声明了 short/mid/long → 非-long 档 = 2，故不为 null；改用空 horizons 才为 null
  assert.equal(body2.data.stats.settled_ratio, 0)

  const noKeyRows = [baseRow({ id: 3, prediction: { ...baseRow().prediction, horizons: [] }, verification: {} })]
  __predictionPublicDependencies.listAllForStats = async () => noKeyRows
  __predictionPublicDependencies.list = async () => ({ rows: noKeyRows, total: 1 })
  const res3 = await makeJsonRequest(port, '/api/predictions')
  const body3 = res3.body as { data: { stats: { settled_ratio: number | null } } }
  assert.equal(body3.data.stats.settled_ratio, null)
})

// ============ Task 5 修复：settled_ratio 统一口径 + long 命中率交付 ============

test('GET /api/predictions -> 200：settled_ratio 含真 pending（声明档无 entry）且 < 1，与 bucketStats.combined 同值', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'pending',
      // 声明 short/mid（+long），只有 short 有 entry；mid 真 pending → 分母含 mid
      due_dates: { short: '2026-08-17', mid: '2026-09-08', long: '2027-01-05' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'bullish', actual: '+1.20%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  const body = res.body as { data: { stats: { settled_ratio: number | null; bucketStats: BucketStatsShape } } }
  // 1 settled / (1 settled + 1 pending mid) = 0.5（< 1，锁死分母含真 pending）
  assert.equal(body.data.stats.settled_ratio, 0.5)
  // 同响应内 computeStats 与 bucketStats.combined 对同一 scope 必须同值
  assert.equal(body.data.stats.settled_ratio, body.data.stats.bucketStats.combined.settled_ratio)
})

test('GET /api/predictions -> 200：settled_ratio 旧版本已结算档位既不进分子也不进分母', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'verified',
      due_dates: { short: '2026-08-17', mid: '2026-09-08', long: '2027-01-05' },
      verification: {
        // short：3.0 已结算 → 口径隔离（不进分子、也不进 pending）
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '3.0' as const, target_type: 'index' as const, actual: '+1.00%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
        // mid：4.0 已结算 → 分子
        mid: { horizon: 'mid', result: 'miss' as const, methodology_version: '4.0' as const, target_type: 'index' as const, actual: '-0.80%', reason: 'x', verified_at: '2026-09-08T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  const body = res.body as { data: { stats: { settled_ratio: number | null; bucketStats: BucketStatsShape } } }
  // settled_4_0 = 1（mid miss）；pending = 0（short 3.0 被隔离）→ 1/1 = 1（若旧版本计入 pending 会得 0.5）
  assert.equal(body.data.stats.settled_ratio, 1)
  assert.equal(body.data.stats.settled_ratio, body.data.stats.bucketStats.combined.settled_ratio)
})

test('GET /api/predictions -> 200：long 命中率单独交付 long{n,hits,hitRate}（不进迭代看板分子/分母）', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'verified',
      due_dates: { short: '2026-08-17', mid: '2026-09-08', long: '2027-01-05' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'bullish', actual: '+1.20%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
        // long：4.0 miss（若被误计入命中率会拉低 hitRate）
        long: { horizon: 'long', result: 'miss' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'bullish', actual: '-2.00%', reason: 'x', verified_at: '2027-01-05T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  const body = res.body as {
    data: { stats: {
      hitRate: number | null; long_excluded: boolean
      long: { n: number; hits: number; hitRate: number | null }
      bucketStats: BucketStatsShape
    } }
  }
  // 迭代看板命中率不含 long：只有 short hit → hitRate 1
  assert.equal(body.data.stats.hitRate, 1)
  assert.equal(body.data.stats.long_excluded, true)
  // long 单列命中率交付（用户可见）
  assert.equal(body.data.stats.long.n, 1)
  assert.equal(body.data.stats.long.hits, 0)
  assert.equal(body.data.stats.long.hitRate, 0)
  assert.deepEqual(body.data.stats.bucketStats.combined.long, { n: 1, hits: 0, hitRate: 0 })
})

test('GET /api/predictions -> 200：无 long 样本时 long.hitRate 为 null（不用 0）', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'verified',
      due_dates: { short: '2026-08-17', mid: '2026-09-08' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'bullish', actual: '+1.20%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  const body = res.body as { data: { stats: { long: { n: number; hits: number; hitRate: number | null } } } }
  assert.deepEqual(body.data.stats.long, { n: 0, hits: 0, hitRate: null })
})

// ============ Task 5 二轮修复：insufficient 计 pending + long_excluded 近似排除 + 舍入对齐 ============

test('GET /api/predictions -> 200：4.0 insufficient 计入 pending（数据可用性状态非判定结论）→ settled_ratio 0.5', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'pending',
      due_dates: { short: '2026-08-17', mid: '2026-09-08' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'bullish', actual: '+1.20%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
        // mid 的 insufficient 属数据可用性状态（数据源故障/无数据），非判定结论 → 计入 pending
        mid: { horizon: 'mid', result: 'insufficient' as const, methodology_version: '4.0' as const, target_type: 'index' as const, actual: '', reason: '无数据源', verified_at: '2026-09-08T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  const body = res.body as { data: { stats: { settled_ratio: number | null; bucketStats: BucketStatsShape } } }
  // 1 settled(hit) / (1 settled + 1 insufficient pending) = 0.5（若把 insufficient 双排除会得 1）
  assert.equal(body.data.stats.settled_ratio, 0.5)
  assert.equal(body.data.stats.settled_ratio, body.data.stats.bucketStats.combined.settled_ratio)
})

test('GET /api/predictions -> 200：approximate-long 的 long_excluded 在 computeStats 与 bucketStats 一致（同源，均 false）', async () => {
  const rows = [
    baseRow({
      id: 1,
      status: 'verified',
      prediction: { ...baseRow().prediction, due_dates_approximate: ['long'] },
      due_dates: { short: '2026-08-17', long: '2027-01-05' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, actual: '+1.20%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
        long: { horizon: 'long', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, actual: '+8.00%', reason: 'x', verified_at: '2027-01-05T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length })

  const res = await makeJsonRequest(port, '/api/predictions')
  const body = res.body as { data: { stats: { long_excluded: boolean; bucketStats: BucketStatsShape } } }
  // 近似 long 不算「被排除的 long 档」（bucketStats 已排除近似）→ computeStats 必须同源同值（false）
  assert.equal(body.data.stats.long_excluded, false)
  assert.equal(body.data.stats.long_excluded, body.data.stats.bucketStats.combined.long_excluded)
})

test('GET /api/predictions -> 200：settled_ratio / flat_rate 舍入到 4 位（两侧同值 0.3333）', async () => {
  // settled_ratio：1 settled + 2 pending = 1/3 → 0.3333（与 agent-py round(...,4) 同值）
  const rows1 = [
    baseRow({
      id: 1,
      status: 'pending',
      prediction: { ...baseRow().prediction, horizons: [{ horizon: 'short' }, { horizon: 'mid' }] },
      due_dates: { short: '2026-08-17', mid: '2026-09-08' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, actual: '+1.20%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
      },
    }),
    baseRow({
      id: 2,
      status: 'pending',
      source_id: 'review:2026-08-08',
      created_at: '2026-08-08T12:00:00.000Z',
      prediction: { ...baseRow().prediction, horizons: [{ horizon: 'short' }] },
      due_dates: { short: '2026-08-18' },
      verification: {},
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows1
  __predictionPublicDependencies.list = async () => ({ rows: rows1, total: rows1.length })
  const res1 = await makeJsonRequest(port, '/api/predictions')
  const body1 = res1.body as { data: { stats: { settled_ratio: number | null; bucketStats: BucketStatsShape } } }
  assert.equal(body1.data.stats.settled_ratio, 0.3333)
  assert.equal(body1.data.stats.settled_ratio, body1.data.stats.bucketStats.combined.settled_ratio)

  // flat_rate：3 方向已结算、1 个 flat = 1/3 → 0.3333
  const rows2 = [
    baseRow({
      id: 3,
      status: 'verified',
      prediction: { ...baseRow().prediction, horizons: [{ horizon: 'short' }, { horizon: 'mid' }] },
      due_dates: { short: '2026-08-17', mid: '2026-09-08' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'bullish', flat: true, actual: '+0.10%', reason: 'x', verified_at: '2026-08-17T08:00:00.000Z' },
        mid: { horizon: 'mid', result: 'miss' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'bullish', actual: '-2.00%', reason: 'x', verified_at: '2026-09-08T08:00:00.000Z' },
      },
    }),
    baseRow({
      id: 4,
      status: 'verified',
      source_id: 'review:2026-08-08',
      created_at: '2026-08-08T12:00:00.000Z',
      prediction: { ...baseRow().prediction, horizons: [{ horizon: 'short' }] },
      due_dates: { short: '2026-08-18' },
      verification: {
        short: { horizon: 'short', result: 'hit' as const, methodology_version: '4.0' as const, target_type: 'index' as const, direction: 'bearish', actual: '+1.20%', reason: 'x', verified_at: '2026-08-18T08:00:00.000Z' },
      },
    }),
  ]
  __predictionPublicDependencies.listAllForStats = async () => rows2
  __predictionPublicDependencies.list = async () => ({ rows: rows2, total: rows2.length })
  const res2 = await makeJsonRequest(port, '/api/predictions')
  const body2 = res2.body as { data: { stats: { directional_count: number; flat_count: number; flat_rate: number | null; bucketStats: BucketStatsShape } } }
  assert.equal(body2.data.stats.directional_count, 3)
  assert.equal(body2.data.stats.flat_count, 1)
  assert.equal(body2.data.stats.flat_rate, 0.3333)
  assert.equal(body2.data.stats.flat_rate, body2.data.stats.bucketStats.combined.flat_rate)
})
