import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { after } from 'node:test'
import express from 'express'

import internalRouter, { publicRouter } from '../src/core/routes/internal'
import pool from '../src/core/db'
import redis from '../src/core/redis'

after(async () => {
    await pool.end()
    redis.disconnect()
})

interface HttpResponse {
    status: number
    body: unknown
}

function post(port: number, path: string, token?: string): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ date: 'invalid-date' })
        const headers: Record<string, string | number> = {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
        }
        if (token) headers['x-internal-token'] = token

        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method: 'POST',
            headers,
        }, (res) => {
            let data = ''
            res.on('data', (chunk: Buffer) => (data += chunk.toString()))
            res.on('end', () => {
                let parsed: unknown = data
                try {
                    parsed = data ? JSON.parse(data) : null
                } catch {
                    // Express 的默认 404 是 HTML；状态码才是此测试关心的契约。
                }
                resolve({
                    status: res.statusCode || 0,
                    body: parsed,
                })
            })
        })
        req.on('error', reject)
        req.end(body)
    })
}

test('音频生成仅通过带鉴权的 internal 路由触发', async () => {
    const app = express()
    app.use(express.json())
    app.use('/internal', internalRouter)
    app.use('/api/agent', publicRouter)

    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port
    const token = process.env.INTERNAL_API_TOKEN
        || process.env.INTERNAL_TOKEN
        || 'change-me-in-production'

    try {
        const internalResponse = await post(
            port,
            '/internal/briefing/generate-audio',
            token,
        )
        assert.equal(internalResponse.status, 400)
        assert.equal((internalResponse.body as { code: number }).code, 400)

        const publicResponse = await post(port, '/api/agent/briefing/generate-audio')
        assert.equal(publicResponse.status, 404)
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})
