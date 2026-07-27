import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { after } from 'node:test'
import express from 'express'

import internalRouter, { publicRouter } from '../src/core/routes/internal'
import pool from '../src/core/db'
import redis from '../src/core/redis'
import { AzureMultiVoiceTtsProvider } from '../src/core/services/tts.service'

after(async () => {
    await pool.end()
    redis.disconnect()
})

interface HttpResponse {
    status: number
    body: unknown
}

function post(port: number, path: string, token?: string, payload: object = { date: 'invalid-date' }): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload)
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

test('音频内部路由把 PostgreSQL DATE 投影为固定日期文本', async () => {
    const date = '2026-07-24'
    const originalQuery = pool.query.bind(pool)
    const originalSynthesize = AzureMultiVoiceTtsProvider.prototype.synthesize
    const originalAudioDir = process.env.AGENT_AUDIO_DIR
    const originalProvider = process.env.TTS_PROVIDER
    const originalAzureRegion = process.env.AZURE_SPEECH_REGION
    const originalAzureKey = process.env.AZURE_SPEECH_KEY
    const fileOps = fs.promises as unknown as {
        mkdir: typeof fs.promises.mkdir
        writeFile: typeof fs.promises.writeFile
        rename: typeof fs.promises.rename
    }
    const originalMkdir = fileOps.mkdir
    const originalWriteFile = fileOps.writeFile
    const originalRename = fileOps.rename
    const brief = {
        id: 101,
        report_type: 'brief_morning',
        report_date: date,
        status: 'completed',
        data_source: 'qa:run:remote:26',
        created_at: '2026-07-24T08:56:00+08:00',
        content: {
            schema_version: 'brief.v1',
            brief_type: 'morning',
            as_of: '2026-07-24T00:00:00+08:00',
            items: Array.from({ length: 3 }, () => ({
                title: '市场结论',
                conclusion: '市场结论有效',
                evidence: [{
                    id: '1',
                    report_type: 'morning',
                    data_source: 'qa:run:remote:26',
                    created_at: '2026-07-24T08:00:00+08:00',
                }],
                as_of: '2026-07-24T08:00:00+08:00',
                confidence: 'unknown',
                uncertainty: '上游置信度未提供',
            })),
            degraded: false,
            missing_sources: [],
        },
    }
    const broadcast = {
        id: 202,
        report_type: 'broadcast_morning',
        report_date: date,
        status: 'completed',
        data_source: 'brief_broadcast',
        created_at: '2026-07-24T09:00:00+08:00',
        content: {
            schema_version: 'broadcast.v1',
            brief_type: 'morning',
            source_brief: {
                id: '101',
                report_type: 'brief_morning',
                report_date: date,
                as_of: '2026-07-24T00:00:00+08:00',
            },
            degraded: false,
            missing_sources: [],
            dialogue: [{ role: 'host', content: '早上好。' }],
            audio_path: null,
        },
    }
    ;(pool as unknown as { query: typeof pool.query }).query = async (sql: string, values?: unknown[]) => {
        if (values?.[0] === 'brief_morning' || values?.[0] === 'broadcast_morning') {
            assert.match(sql, /report_date::text AS report_date/)
            return { rows: [values[0] === 'brief_morning' ? brief : broadcast] } as never
        }
        return { rows: [] } as never
    }
    AzureMultiVoiceTtsProvider.prototype.synthesize = async () => Buffer.from('ID3')
    fileOps.mkdir = async () => undefined
    fileOps.writeFile = async () => undefined
    fileOps.rename = async () => undefined
    process.env.AGENT_AUDIO_DIR = 'C:\\tmp\\w30-audio-route'
    process.env.TTS_PROVIDER = 'azure'
    process.env.AZURE_SPEECH_REGION = 'test-region'
    process.env.AZURE_SPEECH_KEY = 'not-a-secret'

    const app = express()
    app.use(express.json())
    app.use('/internal', internalRouter)
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port
    const token = process.env.INTERNAL_API_TOKEN
        || process.env.INTERNAL_TOKEN
        || 'change-me-in-production'

    try {
        const response = await post(port, '/internal/briefing/generate-audio', token, {
            date,
            brief_type: 'morning',
        })
        assert.equal(response.status, 200)
        assert.equal((response.body as { code: number }).code, 0)
        assert.equal(
            ((response.body as { data: { audio_path: string } }).data.audio_path),
            `/api/agent/audio/broadcast-morning-${date}.mp3`,
        )
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        ;(pool as unknown as { query: typeof pool.query }).query = originalQuery
        AzureMultiVoiceTtsProvider.prototype.synthesize = originalSynthesize
        fileOps.mkdir = originalMkdir
        fileOps.writeFile = originalWriteFile
        fileOps.rename = originalRename
        if (originalAudioDir === undefined) delete process.env.AGENT_AUDIO_DIR
        else process.env.AGENT_AUDIO_DIR = originalAudioDir
        if (originalProvider === undefined) delete process.env.TTS_PROVIDER
        else process.env.TTS_PROVIDER = originalProvider
        if (originalAzureRegion === undefined) delete process.env.AZURE_SPEECH_REGION
        else process.env.AZURE_SPEECH_REGION = originalAzureRegion
        if (originalAzureKey === undefined) delete process.env.AZURE_SPEECH_KEY
        else process.env.AZURE_SPEECH_KEY = originalAzureKey
    }
})
