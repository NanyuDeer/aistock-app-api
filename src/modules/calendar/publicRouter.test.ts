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
        { report_type: 'rhythm_master', report_date: params?.[0], user_id: 'after_close', content: { refresh_slot: 'after_close', rhythm_card: { score: 60 } }, created_at: new Date('2026-08-29T16:10:00+08:00') },
        { report_type: 'rhythm_master', report_date: params?.[0], user_id: 'midday', content: { refresh_slot: 'midday', rhythm_card: { score: 60 } }, created_at: new Date('2026-08-31T12:35:00+08:00') },
      ], rowCount: 2 }
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
