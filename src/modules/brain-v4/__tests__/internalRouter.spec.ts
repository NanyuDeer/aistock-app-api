/**
 * V4 影子归档与只读对比内部接口测试（Task 7）。
 *
 * 测试策略（对齐仓库既有 node:test + tsx）：
 * 1. 用假 `SqlExecutor` 直测 Service 的 SQL 谓词，断言只查影子表、只返回影子行；
 * 2. 用注入 Service 的 Express 实例覆盖 401/403、归档强制 is_shadow、
 *    快照 SHA 不一致的 comparison 被拒绝；
 * 3. 不启动真实 PostgreSQL，不触达生产表。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { after, before } from 'node:test'
import express from 'express'

import {
    BrainV4ArchiveService,
    SnapshotMismatchError,
    type ArchiveRunRecord,
    type SqlExecutor,
} from '../BrainV4ArchiveService'
import { createBrainV4InternalRouter, type BrainV4RouterService } from '../internalRouter'

const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production'

interface QueryCapture {
    text: string
    values: unknown[]
}

interface FakeDbOptions {
    runRows?: Record<string, Record<string, unknown>>
}

/** 假 SQL 执行器：按 SQL 关键词分派，记录全部 SQL 供谓词断言。 */
function createFakeDb(options: FakeDbOptions = {}): { db: SqlExecutor; queries: QueryCapture[] } {
    const queries: QueryCapture[] = []
    const runRows = options.runRows ?? {}
    const db: SqlExecutor = {
        async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
            queries.push({ text, values: [...(values ?? [])] })
            if (text.includes('FROM brain_v4_runs')) {
                const requested = String(values?.[0] ?? '')
                const row = runRows[requested]
                return { rows: (row ? [row] : []) as T[] }
            }
            return { rows: [] as T[] }
        },
    }
    return { db, queries }
}

function runRecord(overrides: Partial<ArchiveRunRecord> = {}): ArchiveRunRecord {
    return {
        v4_run_id: 'v4-run-1',
        legacy_run_id: 'legacy-run-1',
        feature_id: 'market_trace',
        profile: 'market_trace',
        subject_type: 'market',
        subject_code: '000001-SH',
        as_of: '2026-11-26T15:30:00+08:00',
        data_cutoff: '2026-11-26T15:00:00+08:00',
        snapshot_id: 'snap-1',
        snapshot_sha: 'a'.repeat(64),
        parent_run_id: null,
        relation: null,
        config_version: 'c1',
        method_version: 'v4.0',
        model_version: 'm1',
        prompt_version: 'p1',
        is_shadow: false,
        payload: { headline: 'v4' },
        ...overrides,
    }
}

function makeServiceStub(capture: { runs: ArchiveRunRecord[] }): BrainV4RouterService {
    return {
        async archiveRun(record: ArchiveRunRecord) {
            capture.runs.push(record)
            return { ...record, id: 1, is_shadow: true, created_at: '2026-11-26T07:30:00Z' }
        },
        async getRun(v4RunId: string) {
            return v4RunId === 'v4-run-1'
                ? { v4_run_id: v4RunId, is_shadow: true, feature_id: 'market_trace' }
                : null
        },
        async listRuns() {
            return [{ v4_run_id: 'v4-run-1', is_shadow: true, feature_id: 'market_trace' }]
        },
        async getComparison() {
            return null
        },
        async archiveComparison() {
            throw new Error('not used')
        },
    }
}

function createApp(service: BrainV4RouterService): express.Express {
    const app = express()
    app.use(express.json())
    app.use('/internal/brain-v4', createBrainV4InternalRouter({ service }))
    return app
}

interface HttpResponse {
    status: number
    body: Record<string, unknown>
}

function request(
    port: number,
    method: string,
    path: string,
    options: { token?: string; body?: unknown } = {},
): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
        const headers: Record<string, string> = {}
        if (options.token !== undefined) headers['x-internal-token'] = options.token
        if (payload !== undefined) {
            headers['content-type'] = 'application/json'
            headers['content-length'] = String(Buffer.byteLength(payload))
        }
        const req = http.request(
            { hostname: '127.0.0.1', port, path, method, headers },
            (res) => {
                let data = ''
                res.on('data', (chunk: Buffer) => (data += chunk.toString()))
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) })
                    } catch {
                        resolve({ status: res.statusCode ?? 0, body: { raw: data } })
                    }
                })
            },
        )
        req.on('error', reject)
        if (payload !== undefined) req.write(payload)
        req.end()
    })
}

let server: http.Server
let port = 0
const captured = { runs: [] as ArchiveRunRecord[] }

before(async () => {
    const app = createApp(makeServiceStub(captured))
    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    port = (server.address() as AddressInfo).port
})

after(async () => {
    await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
    )
})

test('missing token returns 401', async () => {
    const res = await request(port, 'GET', '/internal/brain-v4/runs')
    assert.equal(res.status, 401)
})

test('wrong token returns 403', async () => {
    const res = await request(port, 'GET', '/internal/brain-v4/runs', { token: 'wrong' })
    assert.equal(res.status, 403)
})

test('archive forces is_shadow=true even when caller sends false', async () => {
    const res = await request(port, 'POST', '/internal/brain-v4/archive', {
        token: INTERNAL_TOKEN,
        body: runRecord({ is_shadow: false }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.code, 0)
    assert.equal(captured.runs.length, 1)
    assert.equal(captured.runs[0]?.is_shadow, true)
})

test('GET /runs returns shadow rows with unified envelope', async () => {
    const res = await request(port, 'GET', '/internal/brain-v4/runs?feature=market_trace', {
        token: INTERNAL_TOKEN,
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.code, 0)
    assert.equal(res.body.message, '')
    const data = res.body.data as Array<Record<string, unknown>>
    assert.equal(data.length, 1)
    assert.equal(data[0]?.is_shadow, true)
})

test('GET /runs/:id returns 404 for unknown run', async () => {
    const res = await request(port, 'GET', '/internal/brain-v4/runs/missing', {
        token: INTERNAL_TOKEN,
    })
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 404)
})

test('service read queries only touch shadow rows', async () => {
    const { db, queries } = createFakeDb({
        runRows: { 'v4-run-1': { v4_run_id: 'v4-run-1', is_shadow: true } },
    })
    const service = new BrainV4ArchiveService(db)

    await service.getRun('v4-run-1')
    await service.listRuns({ feature: 'market_trace', profile: 'market_trace', date: '2026-11-26' })
    await service.getComparison('cmp-1')

    assert.ok(queries.length >= 3)
    for (const query of queries) {
        assert.ok(!query.text.includes('brain_run_archives'), `must not read legacy archive: ${query.text}`)
        assert.match(query.text, /is_shadow\s*=\s*TRUE/i)
    }
})

test('archiveRun persists is_shadow=true and returns row', async () => {
    const { db, queries } = createFakeDb()
    const service = new BrainV4ArchiveService(db)
    const row = await service.archiveRun(runRecord({ is_shadow: false }))

    assert.equal(row.is_shadow, true)
    assert.equal(queries.length, 1)
    assert.match(queries[0]?.text ?? '', /INSERT INTO brain_v4_runs/i)
    assert.ok(queries[0]?.values.includes(true))
    assert.ok(!queries[0]?.values.includes(false))
})

test('comparison with mismatched snapshot SHA is rejected', async () => {
    const { db } = createFakeDb({
        runRows: {
            'legacy-run-1': {
                v4_run_id: 'legacy-run-1',
                snapshot_sha: 'a'.repeat(64),
                is_shadow: true,
            },
            'v4-run-1': {
                v4_run_id: 'v4-run-1',
                snapshot_sha: 'b'.repeat(64),
                is_shadow: true,
            },
        },
    })
    const service = new BrainV4ArchiveService(db)

    await assert.rejects(
        () =>
            service.archiveComparison({
                comparison_id: 'cmp-1',
                legacy_run_id: 'legacy-run-1',
                v4_run_id: 'v4-run-1',
                blind_label: 'A',
            }),
        (err: unknown) => err instanceof SnapshotMismatchError,
    )
})

test('POST /archive comparison with mismatched SHA returns 409', async () => {
    const { db } = createFakeDb({
        runRows: {
            'legacy-run-1': {
                v4_run_id: 'legacy-run-1',
                snapshot_sha: 'a'.repeat(64),
                is_shadow: true,
            },
            'v4-run-1': {
                v4_run_id: 'v4-run-1',
                snapshot_sha: 'b'.repeat(64),
                is_shadow: true,
            },
        },
    })
    const app = express()
    app.use(express.json())
    app.use(
        '/internal/brain-v4',
        createBrainV4InternalRouter({ service: new BrainV4ArchiveService(db) }),
    )
    const localServer = app.listen(0)
    await new Promise<void>((resolve) => localServer.once('listening', resolve))
    const localPort = (localServer.address() as AddressInfo).port
    try {
        const res = await request(localPort, 'POST', '/internal/brain-v4/archive', {
            token: INTERNAL_TOKEN,
            body: {
                comparison_id: 'cmp-1',
                legacy_run_id: 'legacy-run-1',
                v4_run_id: 'v4-run-1',
                blind_label: 'A',
            },
        })
        assert.equal(res.status, 409)
        assert.equal(res.body.code, 409)
    } finally {
        await new Promise<void>((resolve, reject) =>
            localServer.close((err) => (err ? reject(err) : resolve())),
        )
    }
})
