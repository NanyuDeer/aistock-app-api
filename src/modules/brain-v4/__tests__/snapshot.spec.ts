/**
 * V4 冻结快照的纯逻辑与内部接口测试（Task 3 Step 5）。
 *
 * 测试策略：
 * 1. 纯函数优先直测：规范化 JSON、SHA-256 稳定性、回放不触达上游；
 * 2. 控制器用假 req/res 直测：POST 录制信封、GET 读取同一 manifest；
 * 3. 不启动真实 HTTP 服务、不触达数据库/Redis。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Request, Response } from 'express'

import {
    canonicalJson,
    computeSha256,
    createSnapshotStore,
    recordSnapshot,
    replaySnapshot,
    type SnapshotFetcher,
    type SnapshotRequestBody,
} from '../snapshotService'
import { createSnapshotHandlers } from '../snapshotController'

const BODY: SnapshotRequestBody = {
    as_of: '2026-11-26T10:00:00+08:00',
    requests: [
        { request_id: 'r2', tool: 'calendar', params: { date: '2026-11-26', b: 2, a: 1 } },
        { request_id: 'r1', tool: 'news', params: { symbol: '600519-SH' } },
    ],
}

interface MockResponse {
    statusCode: number
    body: Record<string, unknown>
    status(code: number): MockResponse
    json(payload: Record<string, unknown>): MockResponse
}

function createMockResponse(): MockResponse {
    const res: MockResponse = {
        statusCode: 200,
        body: {},
        status(code: number) {
            this.statusCode = code
            return this
        },
        json(payload: Record<string, unknown>) {
            this.body = payload
            return this
        },
    }
    return res
}

function createCountingFetcher(): { fetcher: SnapshotFetcher; calls: () => number } {
    let count = 0
    const fetcher: SnapshotFetcher = async (tool, params) => {
        count += 1
        return { tool, params, value: 42 }
    }
    return { fetcher, calls: () => count }
}

test('canonicalJson sorts object keys recursively without whitespace', () => {
    assert.equal(
        canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
        '{"a":{"c":3,"d":2},"b":1}',
    )
})

test('computeSha256 is stable for the same canonical payload', () => {
    const first = computeSha256(canonicalJson({ a: 1, b: [2, 3] }))
    const second = computeSha256(canonicalJson({ b: [2, 3], a: 1 }))
    assert.equal(first, second)
    assert.equal(first.length, 64)
})

test('recordSnapshot produces identical sha256 and snapshot_id for identical input', async () => {
    const { fetcher } = createCountingFetcher()

    const first = await recordSnapshot(BODY, fetcher)
    const second = await recordSnapshot(BODY, fetcher)

    assert.equal(first.sha256, second.sha256)
    assert.equal(first.snapshot_id, second.snapshot_id)
    assert.equal(canonicalJson(first.manifest), canonicalJson(second.manifest))
    assert.equal(first.manifest.entries.length, 2)
    assert.deepEqual(
        first.manifest.entries.map((entry) => entry.request_id),
        ['r1', 'r2'],
    )
})

test('replaySnapshot never touches upstream and can filter by request_id', async () => {
    const { fetcher, calls } = createCountingFetcher()
    const recorded = await recordSnapshot(BODY, fetcher)
    const callsAfterRecord = calls()

    const replayed = replaySnapshot(recorded.manifest)
    const filtered = replaySnapshot(recorded.manifest, ['r2'])

    assert.equal(calls(), callsAfterRecord)
    assert.deepEqual(replayed.entries, recorded.manifest.entries)
    assert.deepEqual(
        filtered.entries.map((entry) => entry.request_id),
        ['r2'],
    )
})

test('POST /internal/brain-v4/snapshots records, GET replays same manifest', async () => {
    const { fetcher, calls } = createCountingFetcher()
    const store = createSnapshotStore()
    const handlers = createSnapshotHandlers({ fetcher, store })

    const postRes = createMockResponse()
    await handlers.record(
        { body: BODY } as unknown as Request,
        postRes as unknown as Response,
    )

    assert.equal(postRes.statusCode, 200)
    assert.equal(postRes.body.code, 0)
    assert.equal(postRes.body.message, '')
    const recorded = postRes.body.data as Record<string, unknown>
    const snapshotId = recorded.snapshot_id as string
    const callsAfterPost = calls()

    const getRes = createMockResponse()
    await handlers.get(
        { params: { snapshotId } } as unknown as Request,
        getRes as unknown as Response,
    )

    assert.equal(getRes.statusCode, 200)
    assert.equal(getRes.body.code, 0)
    const replayed = getRes.body.data as Record<string, unknown>
    assert.equal(replayed.sha256, recorded.sha256)
    assert.deepEqual(replayed.manifest, recorded.manifest)
    assert.equal(calls(), callsAfterPost)
})

test('POST rejects invalid body and GET returns 404 for unknown snapshot', async () => {
    const { fetcher } = createCountingFetcher()
    const handlers = createSnapshotHandlers({ fetcher, store: createSnapshotStore() })

    const invalidRes = createMockResponse()
    await handlers.record(
        { body: { as_of: '', requests: [] } } as unknown as Request,
        invalidRes as unknown as Response,
    )
    assert.equal(invalidRes.statusCode, 400)
    assert.equal(invalidRes.body.code, 400)

    const missingRes = createMockResponse()
    await handlers.get(
        { params: { snapshotId: 'snap_missing' } } as unknown as Request,
        missingRes as unknown as Response,
    )
    assert.equal(missingRes.statusCode, 404)
    assert.equal(missingRes.body.code, 404)
})
