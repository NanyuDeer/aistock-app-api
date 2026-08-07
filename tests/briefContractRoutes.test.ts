import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { after } from 'node:test'
import express from 'express'

import { publicRouter } from '../src/core/routes/internal'
import pool from '../src/core/db'
import redis from '../src/core/redis'

const DATE = '2026-07-24'

interface HttpResponse {
    status: number
    body: Record<string, unknown>
}

function request(port: number, pathname: string): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: pathname }, (res) => {
            let raw = ''
            res.on('data', (chunk: Buffer) => (raw += chunk))
            res.on('end', () => resolve({ status: res.statusCode || 0, body: raw ? JSON.parse(raw) : {} }))
        })
        req.on('error', reject)
    })
}

async function withServer(run: (port: number) => Promise<void>): Promise<void> {
    const app = express()
    app.use('/api/agent', publicRouter)
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    try {
        await run((server.address() as AddressInfo).port)
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

after(async () => {
    await pool.end()
    redis.disconnect()
})

test('通用报告入口拒绝旧 broadcast，且不读取持久化旧 text/audio_path', async () => {
    const originalQuery = pool.query.bind(pool)
    let reads = 0
    ;(pool as unknown as { query: typeof pool.query }).query = async () => {
        reads += 1
        return {
            rows: [{
                report_type: 'broadcast',
                report_date: DATE,
                content: { text: '旧播报原文', audio_path: '/api/agent/audio/legacy.mp3' },
            }],
        } as never
    }

    try {
        await withServer(async (port) => {
            const response = await request(port, `/api/agent/report/broadcast/${DATE}`)
            assert.equal(response.status, 400)
            assert.deepEqual(response.body, { code: -1, message: 'Invalid intent: broadcast' })
        })
        assert.equal(reads, 0)
    } finally {
        ;(pool as unknown as { query: typeof pool.query }).query = originalQuery
    }
})

test('通用报告入口继续允许 event_conduction 的公开读取', async () => {
    const originalQuery = pool.query.bind(pool)
    const eventRow = {
        report_type: 'event_conduction',
        report_date: DATE,
        content: { title: '真实事件报告' },
    }
    ;(pool as unknown as { query: typeof pool.query }).query = async () => ({ rows: [eventRow] }) as never

    try {
        await withServer(async (port) => {
            const response = await request(port, `/api/agent/report/event_conduction/${DATE}`)
            assert.equal(response.status, 200)
            assert.deepEqual(response.body, { code: 0, data: eventRow })
        })
    } finally {
        ;(pool as unknown as { query: typeof pool.query }).query = originalQuery
    }
})

function makeBriefRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const item = {
        title: '市场结论',
        conclusion: '市场震荡，关注量能变化',
        evidence: [{
            id: 'report-1',
            report_type: 'review',
            data_source: 'analysis_reports',
            created_at: '2026-07-24T07:20:00+08:00',
        }],
        as_of: '2026-07-24T08:55:00+08:00',
        confidence: 'high',
        uncertainty: '成交量仍待确认',
    }
    return {
        id: 101,
        report_type: 'brief_morning',
        report_date: DATE,
        status: 'completed',
        data_source: 'briefing',
        created_at: '2026-07-24T08:56:00+08:00',
        content: {
            schema_version: 'brief.v1',
            brief_type: 'morning',
            as_of: '2026-07-24T08:55:00+08:00',
            items: [item, item, item],
            degraded: false,
            missing_sources: [],
        },
        ...overrides,
    }
}

function makeBroadcastRow(sourceBrief: Record<string, unknown>): Record<string, unknown> {
    const briefContent = sourceBrief.content as Record<string, unknown>
    return {
        id: 202,
        report_type: 'broadcast_morning',
        report_date: DATE,
        status: 'completed',
        data_source: 'broadcast',
        created_at: '2026-07-24T09:00:00+08:00',
        content: {
            schema_version: 'broadcast.v1',
            brief_type: 'morning',
            source_brief: {
                id: String(sourceBrief.id),
                report_type: 'brief_morning',
                report_date: DATE,
                as_of: briefContent.as_of,
                internal_reference: 'must-not-leak',
            },
            degraded: false,
            missing_sources: [],
            dialogue: [{ role: 'host', content: '早上好。', prompt_debug: 'must-not-leak' }],
            audio_path: `/api/agent/audio/broadcast-morning-${DATE}.mp3`,
        },
    }
}

test('Brief 与 Broadcast 公开路由只返回安全投影并拒绝不安全工件', async () => {
    const originalQuery = pool.query.bind(pool)
    let briefRow = makeBriefRow()
    let broadcastRow = makeBroadcastRow(briefRow)
    ;(pool as unknown as { query: typeof pool.query }).query = async (_sql: string, values?: unknown[]) => {
        if (values?.[0] === 'brief_morning' || values?.[0] === 'brief_evening') return { rows: [briefRow] } as never
        if (values?.[0] === 'broadcast_morning') return { rows: [broadcastRow] } as never
        return { rows: [] } as never
    }

    try {
        await withServer(async (port) => {
            const brief = await request(port, `/api/agent/brief/morning/${DATE}`)
            assert.equal(brief.status, 200)
            assert.deepEqual(brief.body.data, briefRow.content)
            assert.equal((brief.body.data as Record<string, unknown>).id, undefined)

            const broadcast = await request(port, `/api/agent/broadcast/morning/${DATE}`)
            assert.equal(broadcast.status, 200)
            assert.deepEqual(broadcast.body.data, {
                schema_version: 'broadcast.v1',
                brief_type: 'morning',
                source_brief: {
                    id: '101', report_type: 'brief_morning', report_date: DATE,
                    as_of: '2026-07-24T08:55:00+08:00',
                },
                degraded: false,
                missing_sources: [],
                dialogue: [{ role: 'host', content: '早上好。' }],
                audio_path: `/api/agent/audio/broadcast-morning-${DATE}.mp3`,
            })
            assert.equal((broadcast.body.data as Record<string, unknown>).id, undefined)

            const rawBrief = makeBriefRow()
            ;((rawBrief.content as Record<string, unknown>).items as Array<Record<string, unknown>>)[0].conclusion = '{"raw":"json"}'
            briefRow = rawBrief
            assert.deepEqual((await request(port, `/api/agent/brief/morning/${DATE}`)).body, { code: 0, data: null })

            briefRow = makeBriefRow({ report_type: 'brief_evening' })
            assert.deepEqual((await request(port, `/api/agent/brief/morning/${DATE}`)).body, { code: 0, data: null })

            // 变体后缀 missing_sources（如 review.sectors）属合法降级，不应整份拒绝（防复发）
            const degradedEvening = makeBriefRow({
                report_type: 'brief_evening',
            })
            const degradedContent = degradedEvening.content as Record<string, unknown>
            degradedContent.brief_type = 'evening'
            degradedContent.degraded = true
            degradedContent.missing_sources = ['review.sectors']
            ;(degradedContent.items as Array<Record<string, unknown>>) = [
                (degradedContent.items as Array<Record<string, unknown>>)[0],
                (degradedContent.items as Array<Record<string, unknown>>)[1],
            ]
            briefRow = degradedEvening
            assert.deepEqual((await request(port, `/api/agent/brief/evening/${DATE}`)).body, {
                code: 0, data: degradedContent,
            })

            briefRow = makeBriefRow({ report_date: '2026-07-23' })
            assert.deepEqual((await request(port, `/api/agent/brief/morning/${DATE}`)).body, { code: 0, data: null })

            briefRow = makeBriefRow()
            broadcastRow = makeBroadcastRow(briefRow)
            ;((broadcastRow.content as Record<string, unknown>).source_brief as Record<string, unknown>).id = 'wrong-brief'
            assert.deepEqual((await request(port, `/api/agent/broadcast/morning/${DATE}`)).body, { code: 0, data: null })

            broadcastRow = makeBroadcastRow(briefRow)
            ;((broadcastRow.content as Record<string, unknown>).dialogue as Array<Record<string, unknown>>)[0].role = 'unknown'
            assert.deepEqual((await request(port, `/api/agent/broadcast/morning/${DATE}`)).body, { code: 0, data: null })

            broadcastRow = makeBroadcastRow(briefRow)
            broadcastRow.content = { text: '旧播报原文', audio_path: '/api/agent/audio/legacy.mp3' }
            assert.deepEqual((await request(port, `/api/agent/broadcast/morning/${DATE}`)).body, { code: 0, data: null })
        })
    } finally {
        ;(pool as unknown as { query: typeof pool.query }).query = originalQuery
    }
})
