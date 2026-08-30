import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { internalMirror, __fearGreedInternalDeps } from './internalMirror'

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

const ORIGINAL = { ...__fearGreedInternalDeps }

before(() => {
  __fearGreedInternalDeps.getLatestJq = async () => ({
    key: 'jq', name: '韭圈儿恐贪指数', composite: 62.5, label: '贪婪',
    history: { dates: ['2026-08-28'], scores: [62.5] },
    indicators: [{ key: 'breadth', name: '股价强度', score: 70, label: '贪婪', history: { dates: [], scores: [] }, excluded: false }],
  })
})
after(() => { Object.assign(__fearGreedInternalDeps, ORIGINAL) })

test('GET /internal/fear-greed 镜像契约（index/indicators/history）', async () => {
  const app = express()
  app.use('/internal/fear-greed', internalMirror)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.on('listening', r))
  const port = (server.address() as AddressInfo).port
  try {
    const res = await get(port, '/internal/fear-greed')
    assert.equal(res.status, 200)
    assert.equal(res.json.code, 200)
    assert.equal(res.json.data.index, 62.5)
    assert.equal(res.json.data.label, '贪婪')
    assert.equal(res.json.data.indicators[0].key, 'breadth')
    assert.deepEqual(res.json.data.history.dates, ['2026-08-28'])
  } finally { server.close() }
})

test('无数据 → 200 + 空字段（不 500）', async () => {
  __fearGreedInternalDeps.getLatestJq = async () => null
  const app = express()
  app.use('/internal/fear-greed', internalMirror)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.on('listening', r))
  const port = (server.address() as AddressInfo).port
  try {
    const res = await get(port, '/internal/fear-greed')
    assert.equal(res.status, 200)
    assert.equal(res.json.code, 200)
    assert.equal(res.json.data.index, null)
    assert.deepEqual(res.json.data.indicators, [])
  } finally { server.close() }
})
