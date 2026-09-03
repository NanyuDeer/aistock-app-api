import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { rhythmMasterPublicRouter } from './publicRouter'
import pool from '../../core/db'

const ORIGINAL_QUERY = pool.query
function get(port: number, path: string) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data || '{}') }))
    })
    req.on('error', reject)
    req.end()
  })
}

before(async () => {
  ;(pool as any).query = async (sql: string, params?: unknown[]) => {
    if (String(sql).includes('agent_analysis_reports') && String(sql).includes('rhythm_master')) {
      return { rows: [
        { report_type: 'rhythm_master', report_date: params?.[0], user_id: 'after_close', content: { refresh_slot: 'after_close', rhythm_card: { score: 60, level: 'active' } }, created_at: new Date('2026-08-29T16:10:00+08:00') },
        { report_type: 'rhythm_master', report_date: params?.[0], user_id: 'midday', content: { refresh_slot: 'midday', rhythm_card: { score: 60, level: 'active' } }, created_at: new Date('2026-08-31T12:35:00+08:00') },
      ], rowCount: 2 }
    }
    if (String(sql).includes('market_calendar_events')) {
      return { rows: [
        // 窗口内 CN macro（含 US 隔夜顺延入窗口 + 非 macro 财报排除）
        { id: 1, event_date: '2026-09-02', title: '中国 8 月 CPI 年率', importance: 'high', market: 'CN', event_time: '09:30', source: 'L2', detail: null, result: null },
        { id: 2, event_date: '2026-09-02', title: '美联储 9 月 FOMC 议息', importance: 'high', market: 'US_OVERNIGHT', event_time: '15:30', source: 'L3', detail: null, result: null },
        { id: 3, event_date: '2026-09-02', title: '宁德时代中报披露日程', importance: 'medium', market: 'CN', event_time: null, source: 'L2', detail: null, result: null }, // earnings → 排除
      ], rowCount: 3 }
    }
    return { rows: [], rowCount: 0 }
  }
})
after(async () => { ;(pool as any).query = ORIGINAL_QUERY; await pool.end() })

test('GET /api/agent/rhythm-master/:date 返回按 refresh_slot 优先级排序的版本', async () => {
  const app = express()
  app.use('/api/agent', rhythmMasterPublicRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.on('listening', r))
  const port = (server.address() as AddressInfo).port
  try {
    const res = await get(port, '/api/agent/rhythm-master/2026-08-31')
    assert.equal(res.status, 200)
    assert.equal(res.json.data.versions[0].refresh_slot, 'midday')
    assert.equal(res.json.data.versions[1].refresh_slot, 'after_close')
    const bad = await get(port, '/api/agent/rhythm-master/20260831')
    assert.equal(bad.status, 400)
  } finally { server.close() }
})

test('GET /rhythm-master/calendar 每行含 events：仅 macro、US 隔夜顺延后按对外契约、非 macro 排除、无事件日空数组', async () => {
  const app = express()
  app.use('/api/agent', rhythmMasterPublicRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.on('listening', r))
  const port = (server.address() as AddressInfo).port
  try {
    const res = await get(port, '/api/agent/rhythm-master/calendar?days=5')
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.json.data.days))
    // 存在至少一天包含 macro 事件；所有 events 元素 type 均为 macro 且带对外契约字段
    const dayWithEvents = res.json.data.days.find((d: any) => Array.isArray(d.events) && d.events.length > 0)
    assert.ok(dayWithEvents, '应存在带 events 的交易日')
    assert.ok(dayWithEvents.events.every((e: any) => e.type === 'macro'))
    assert.ok(dayWithEvents.events.every((e: any) => typeof e.title === 'string' && e.source && e.importance))
    // 全部行都有 events 字段（无事件 = []）
    assert.ok(res.json.data.days.every((d: any) => Array.isArray(d.events)))
    // 向后兼容：原有 level/score/position_band 仍存在
    assert.ok('level' in dayWithEvents && 'position_band' in dayWithEvents)
  } finally { server.close() }
})
