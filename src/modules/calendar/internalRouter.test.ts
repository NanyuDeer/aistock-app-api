import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { calendarInternalRouter } from './internalRouter'
import { nthWeekday, listDeliveryDates } from './CalendarRuleService'
import { dedupHash, normalizeTitle, listEvents, upsertEvent } from './MarketCalendarEventService'
import pool from '../../core/db'
import * as TradingCalendarModule from '../../shared/utils/TradingCalendarService'

const ORIGINAL_QUERY = pool.query
function makeJsonRequest(port: number, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: body ? { 'content-type': 'application/json', 'x-internal-token': 'test-token' } : { 'x-internal-token': 'test-token' } }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data || '{}') }) } catch { resolve({ status: res.statusCode ?? 0, json: {} }) } })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

before(async () => {
  process.env.INTERNAL_API_TOKEN = 'test-token'
  ;(pool as any).query = async (sql: string, params?: unknown[]) => {
    const s = String(sql)
    if (s.includes('FROM market_calendar_events')) return { rows: [], rowCount: 0 }
    if (s.includes('INSERT INTO market_calendar_events')) return { rows: [{ id: 1 }], rowCount: 1 }
    if (s.includes('FROM performance_reports')) return { rows: [], rowCount: 0 }
    return { rows: [], rowCount: 0 }
  }
})

after(async () => {
  ;(pool as any).query = ORIGINAL_QUERY
  delete process.env.INTERNAL_API_TOKEN
  await pool.end()
})

test('nthWeekday 每月第三个周五', () => {
  assert.equal(nthWeekday(2026, 9, 4, 3).toISOString().slice(0, 10), '2026-09-18') // 2026-09 第三个周五
})

test('listDeliveryDates 返回窗口内交割日并排序', () => {
  const events = listDeliveryDates('2026-08-01', '2026-09-30')
  assert.ok(events.length >= 2)
  assert.ok(events.every((e) => e.type === 'delivery' && e.source === 'L1' && e.importance === 'medium'))
  const dates = events.map((e) => e.date).sort()
  assert.deepEqual(events.map((e) => e.date), dates)
})

test('normalizeTitle/dedupHash 稳定且忽略空白标点', () => {
  assert.equal(normalizeTitle(' 英伟达  财报发布! '), '英伟达财报发布')
  assert.equal(dedupHash('2026-09-01', '英伟达财报'), dedupHash('2026-09-01', ' 英伟达 财报 '))
})

test('GET /internal/calendar/events 鉴权 + 参数校验 + 空数组', async () => {
  const app = express()
  app.use(express.json())
  app.use('/internal/calendar', calendarInternalRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.on('listening', r))
  const port = (server.address() as AddressInfo).port
  try {
    const ok = await makeJsonRequest(port, 'GET', '/internal/calendar/events?dateFrom=2026-09-01&dateTo=2026-09-05')
    assert.equal(ok.status, 200)
    assert.ok(Array.isArray(ok.json.data.events))
    const bad = await makeJsonRequest(port, 'GET', '/internal/calendar/events?dateFrom=2026-09-01')
    assert.equal(bad.status, 400)
  } finally { server.close() }
})

test('POST /internal/calendar/events upsert 契约', async () => {
  const app = express()
  app.use(express.json())
  app.use('/internal/calendar', calendarInternalRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.on('listening', r))
  const port = (server.address() as AddressInfo).port
  try {
    const res = await makeJsonRequest(port, 'POST', '/internal/calendar/events', { event_date: '2026-09-01', title: '测试事件', importance: 'high' })
    assert.equal(res.status, 200)
    assert.ok(res.json.data.id >= 0)
    const bad = await makeJsonRequest(port, 'POST', '/internal/calendar/events', { title: '缺日期' })
    assert.equal(bad.status, 400)
  } finally { server.close() }
})

test('US 隔夜事件 event_time>=15:00 顺延次一交易日（§4.5）', async () => {
  ;(pool as any).query = async (sql: string) => {
    if (String(sql).includes('FROM market_calendar_events')) {
      return { rows: [{ id: 1, event_date: '2026-09-02', title: '英伟达财报', importance: 'high', market: 'US_OVERNIGHT', event_time: '22:00', source: 'L3', detail: null, result: null }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
  const app = express()
  app.use('/internal/calendar', calendarInternalRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.on('listening', r))
  const port = (server.address() as AddressInfo).port
  try {
    const res = await makeJsonRequest(port, 'GET', '/internal/calendar/events?dateFrom=2026-09-01&dateTo=2026-09-05')
    const overnight = res.json.data.events.find((e: any) => e.title.includes('英伟达'))
    assert.ok(overnight.date > '2026-09-02', '隔夜事件应顺延到次一交易日')
  } finally { server.close() }
})
