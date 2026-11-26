/**
 * V4 冻结快照内部接口 handler。
 *
 * 两个端点（由 `core/routes/internal.ts` 挂载，鉴权沿用 verifyInternalToken）：
 * - `POST /internal/brain-v4/snapshots`：录制快照；
 * - `GET /internal/brain-v4/snapshots/:snapshotId`：读取/回放冻结 manifest。
 *
 * 生产 fetcher 目前只保留最小映射注册表（Task 7 接入真实数据源），
 * 测试通过 `createSnapshotHandlers({ fetcher, store })` 注入 fake。
 */

import type { Request, Response } from 'express'

import {
    createSnapshotStore,
    recordSnapshot,
    replaySnapshot,
    type SnapshotFetcher,
    type SnapshotStore,
    type SnapshotToolRequest,
} from './snapshotService'

export interface SnapshotControllerDeps {
    fetcher?: SnapshotFetcher
    store?: SnapshotStore
}

export interface SnapshotHandlers {
    record: (req: Request, res: Response) => Promise<void>
    get: (req: Request, res: Response) => Promise<void>
}

const productionFetchers = new Map<string, SnapshotFetcher>()

/** 注册生产 fetcher；未注册的工具录制时显式报错，不静默返回空数据。 */
export function registerSnapshotFetcher(tool: string, fetcher: SnapshotFetcher): void {
    productionFetchers.set(tool, fetcher)
}

const defaultFetcher: SnapshotFetcher = async (tool, params) => {
    const registered = productionFetchers.get(tool)
    if (!registered) {
        throw new Error(`no production fetcher registered for tool: ${tool}`)
    }
    return registered(tool, params)
}

const defaultStore: SnapshotStore = createSnapshotStore()

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

function parseRequests(rawRequests: unknown): SnapshotToolRequest[] | null {
    if (!Array.isArray(rawRequests) || rawRequests.length === 0) return null
    const requests: SnapshotToolRequest[] = []
    for (const raw of rawRequests) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
        const record = raw as Record<string, unknown>
        const requestId = typeof record['request_id'] === 'string' ? record['request_id'].trim() : ''
        const tool = typeof record['tool'] === 'string' ? record['tool'].trim() : ''
        if (!requestId || !tool) return null
        const rawParams = record['params'] === undefined ? {} : record['params']
        if (rawParams === null || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
            return null
        }
        requests.push({
            request_id: requestId,
            tool,
            params: rawParams as Record<string, unknown>,
        })
    }
    return requests
}

export function createSnapshotHandlers(deps: SnapshotControllerDeps = {}): SnapshotHandlers {
    const fetcher = deps.fetcher ?? defaultFetcher
    const store = deps.store ?? defaultStore

    return {
        record: async (req: Request, res: Response): Promise<void> => {
            const body = (req.body ?? {}) as Record<string, unknown>
            const asOf = typeof body['as_of'] === 'string' ? body['as_of'].trim() : ''
            if (!asOf) {
                res.status(400).json({ code: 400, message: 'as_of 必填' })
                return
            }
            const requests = parseRequests(body['requests'])
            if (requests === null) {
                res.status(400).json({
                    code: 400,
                    message: 'requests 须为非空数组，且每项含 request_id/tool/params',
                })
                return
            }
            const rawSnapshotId = body['snapshot_id']
            const snapshotId =
                typeof rawSnapshotId === 'string' && rawSnapshotId.trim()
                    ? rawSnapshotId.trim()
                    : undefined

            try {
                const record = await recordSnapshot(
                    { as_of: asOf, snapshot_id: snapshotId, requests },
                    fetcher,
                )
                store.save(record)
                res.json({ code: 0, data: record, message: '' })
            } catch (err: unknown) {
                res.status(502).json({ code: 502, message: errorMessage(err) })
            }
        },

        get: async (req: Request, res: Response): Promise<void> => {
            const raw = req.params?.['snapshotId']
            const snapshotId = Array.isArray(raw) ? raw[0] : raw
            if (!snapshotId) {
                res.status(400).json({ code: 400, message: 'snapshotId 必填' })
                return
            }
            const record = store.get(snapshotId)
            if (!record) {
                res.status(404).json({ code: 404, message: 'snapshot not found' })
                return
            }
            // 回放只读冻结 manifest，不重新取数。
            res.json({
                code: 0,
                data: {
                    snapshot_id: record.snapshot_id,
                    as_of: record.as_of,
                    sha256: record.sha256,
                    manifest: replaySnapshot(record.manifest),
                },
                message: '',
            })
        },
    }
}

export const snapshotHandlers: SnapshotHandlers = createSnapshotHandlers()
