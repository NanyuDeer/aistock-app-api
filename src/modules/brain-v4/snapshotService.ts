/**
 * V4 冻结快照纯逻辑：规范化 JSON、SHA-256 与无上游回放。
 *
 * 设计约束（Task 3）：
 * - 同一输入两次录制必须得到同一 SHA-256（键排序、无空白差异）；
 * - `replaySnapshot` 只读 manifest，不接收 fetcher，因此回放不可能触达上游；
 * - 本 Task 不做持久化，快照存于可注入的进程内存储。
 */

import { createHash } from 'node:crypto'

export interface SnapshotToolRequest {
    request_id: string
    tool: string
    params: Record<string, unknown>
}

export interface SnapshotRequestBody {
    as_of: string
    snapshot_id?: string
    requests: SnapshotToolRequest[]
}

export interface SnapshotEntry extends SnapshotToolRequest {
    result: unknown
}

export interface SnapshotManifest {
    snapshot_id: string
    as_of: string
    entries: SnapshotEntry[]
}

export interface SnapshotRecord {
    snapshot_id: string
    as_of: string
    sha256: string
    manifest: SnapshotManifest
}

export type SnapshotFetcher = (
    tool: string,
    params: Record<string, unknown>,
) => Promise<unknown>

export interface SnapshotStore {
    save(record: SnapshotRecord): void
    get(snapshotId: string): SnapshotRecord | undefined
}

function sortValue(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString()
    if (Array.isArray(value)) return value.map((item) => sortValue(item))
    if (value !== null && typeof value === 'object') {
        const source = value as Record<string, unknown>
        const sorted: Record<string, unknown> = {}
        for (const key of Object.keys(source).sort()) {
            const item = source[key]
            if (item !== undefined) sorted[key] = sortValue(item)
        }
        return sorted
    }
    if (typeof value === 'bigint') return value.toString()
    return value
}

/** 规范化 JSON：递归键排序、无空白差异。 */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(sortValue(value)) ?? 'null'
}

export function computeSha256(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex')
}

function compareEntries(a: SnapshotEntry, b: SnapshotEntry): number {
    if (a.request_id !== b.request_id) return a.request_id < b.request_id ? -1 : 1
    if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1
    return 0
}

function normalizeRequest(request: SnapshotToolRequest): SnapshotToolRequest {
    return {
        request_id: request.request_id,
        tool: request.tool.trim().toLowerCase(),
        params: sortValue(request.params) as Record<string, unknown>,
    }
}

/** 录制一次冻结快照：串行取数后生成稳定 manifest 与 SHA-256。 */
export async function recordSnapshot(
    body: SnapshotRequestBody,
    fetcher: SnapshotFetcher,
): Promise<SnapshotRecord> {
    // 先规范化并按 request_id 排序，保证与请求到达顺序无关。
    const normalized = body.requests
        .map(normalizeRequest)
        .sort((a, b) =>
            a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0,
        )

    const entries: SnapshotEntry[] = []
    for (const request of normalized) {
        const result = await fetcher(request.tool, request.params)
        entries.push({ ...request, result })
    }

    const identity = computeSha256(canonicalJson({ as_of: body.as_of, requests: normalized }))
    const snapshotId = body.snapshot_id?.trim() || `snap_${identity.slice(0, 16)}`
    const manifest: SnapshotManifest = {
        snapshot_id: snapshotId,
        as_of: body.as_of,
        entries,
    }
    return {
        snapshot_id: snapshotId,
        as_of: body.as_of,
        sha256: computeSha256(canonicalJson(manifest)),
        manifest,
    }
}

/** 纯回放：只读 manifest，可按 request_id 过滤，绝不触达上游。 */
export function replaySnapshot(
    manifest: SnapshotManifest,
    requestIds?: readonly string[],
): SnapshotManifest {
    const wanted = requestIds && requestIds.length > 0 ? new Set(requestIds) : undefined
    const entries = manifest.entries
        .filter((entry) => wanted === undefined || wanted.has(entry.request_id))
        .slice()
        .sort(compareEntries)
    return {
        snapshot_id: manifest.snapshot_id,
        as_of: manifest.as_of,
        entries,
    }
}

export function createSnapshotStore(): SnapshotStore {
    const records = new Map<string, SnapshotRecord>()
    return {
        save(record: SnapshotRecord): void {
            records.set(record.snapshot_id, record)
        },
        get(snapshotId: string): SnapshotRecord | undefined {
            return records.get(snapshotId)
        },
    }
}
