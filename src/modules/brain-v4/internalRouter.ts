/**
 * 智慧大脑 V4 影子归档与只读对比内部路由（Task 7）。
 *
 * 挂载点：`src/index.ts` 中 `app.use('/internal/brain-v4', brainV4InternalRouter)`，
 * 必须位于 `app.use('/internal', internalRouter)` **之后**，保证 Task 3 的
 * `/internal/brain-v4/snapshots` 仍先命中既有路由。
 *
 * 契约：
 * - 全部接口要求 `X-Internal-Token`（缺失 401、错误 403）；
 * - 统一响应 `{ code, data, message }`；
 * - 写归档强制影子；comparison 快照 SHA 不一致返回 409；
 * - 本地实现 `verifyInternalToken`，不向 `core/routes/internal.ts` 追加新路由。
 */

import { Router, type Request, type Response } from 'express'

import brainV4ArchiveService, {
    ArchiveNotFoundError,
    ArchiveValidationError,
    SnapshotMismatchError,
    type ArchiveComparisonRecord,
    type ArchiveRow,
    type ArchiveRunRecord,
    type RunFilter,
} from './BrainV4ArchiveService'

export interface BrainV4RouterService {
    archiveRun(record: ArchiveRunRecord): Promise<ArchiveRow>
    getRun(v4RunId: string): Promise<ArchiveRow | null>
    listRuns(filter: RunFilter): Promise<ArchiveRow[]>
    getComparison(comparisonId: string): Promise<ArchiveRow | null>
    archiveComparison(record: ArchiveComparisonRecord): Promise<ArchiveRow>
    getBriefing(date: string, slot: string): Promise<ArchiveRow | null>
}

export interface BrainV4RouterDeps {
    service?: BrainV4RouterService
}

const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production'

interface TokenCheck {
    ok: boolean
    status: number
    message: string
}

/** 与仓库既有 Internal API 相同的 token 读取规则（优先 `X-Internal-Token`）。 */
function verifyInternalToken(req: Request): TokenCheck {
    const raw = req.headers['x-internal-token']
    const token = Array.isArray(raw) ? raw[0] : raw
    if (!token) {
        return { ok: false, status: 401, message: 'missing internal token' }
    }
    if (token !== INTERNAL_TOKEN) {
        return { ok: false, status: 403, message: 'invalid internal token' }
    }
    return { ok: true, status: 0, message: '' }
}

function queryString(req: Request, key: string): string | undefined {
    const raw = req.query[key]
    const value = Array.isArray(raw) ? raw[0] : raw
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function paramString(req: Request, key: string): string {
    const raw = req.params[key]
    const value = Array.isArray(raw) ? raw[0] : raw
    return value ?? ''
}

function sendError(res: Response, err: unknown): void {
    if (err instanceof ArchiveValidationError) {
        res.status(400).json({ code: 400, message: err.message })
        return
    }
    if (err instanceof ArchiveNotFoundError) {
        res.status(404).json({ code: 404, message: err.message })
        return
    }
    if (err instanceof SnapshotMismatchError) {
        res.status(409).json({ code: 409, message: err.message })
        return
    }
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ code: 500, message })
}

function isComparisonBody(body: Record<string, unknown>): boolean {
    return typeof body['comparison_id'] === 'string' && body['comparison_id'].trim() !== ''
}

/** 只读简报时段；`midday` 为既有 `mid` 的兼容别名。 */
const BRIEFING_SLOTS = new Set(['pre', 'mid', 'midday', 'post'])

export function createBrainV4InternalRouter(deps: BrainV4RouterDeps = {}): Router {
    const service = deps.service ?? brainV4ArchiveService
    const router = Router()
    router.use((req: Request, res: Response, next: () => void) => {
        const check = verifyInternalToken(req)
        if (!check.ok) {
            res.status(check.status).json({ code: check.status, message: check.message })
            return
        }
        next()
    })

    router.post('/archive', async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as Record<string, unknown>
        try {
            // 写归档强制影子：无论调用方传什么，`is_shadow` 一律覆盖为 true。
            const data = isComparisonBody(body)
                ? await service.archiveComparison(body as unknown as ArchiveComparisonRecord)
                : await service.archiveRun(
                      { ...body, is_shadow: true } as unknown as ArchiveRunRecord,
                  )
            res.json({ code: 0, data, message: '' })
        } catch (err: unknown) {
            sendError(res, err)
        }
    })

    router.get('/briefings', async (req: Request, res: Response) => {
        const date = queryString(req, 'date')
        if (!date) {
            res.status(400).json({ code: 400, message: 'date 必填' })
            return
        }
        const slot = queryString(req, 'slot')
        if (!slot || !BRIEFING_SLOTS.has(slot)) {
            res.status(400).json({
                code: 400,
                message: 'slot 必须为 pre|mid|midday|post 之一',
            })
            return
        }
        try {
            // 无数据返回 data:null，不用 404 让审计脚本区分“未产出”和“接口错误”。
            const data = await service.getBriefing(date, slot)
            res.json({ code: 0, data, message: '' })
        } catch (err: unknown) {
            sendError(res, err)
        }
    })

    router.get('/runs', async (req: Request, res: Response) => {        const filter: RunFilter = {
            feature: queryString(req, 'feature'),
            profile: queryString(req, 'profile'),
            date: queryString(req, 'date'),
        }
        try {
            const data = await service.listRuns(filter)
            res.json({ code: 0, data, message: '' })
        } catch (err: unknown) {
            sendError(res, err)
        }
    })

    router.get('/runs/:v4RunId', async (req: Request, res: Response) => {
        const v4RunId = paramString(req, 'v4RunId')
        if (!v4RunId) {
            res.status(400).json({ code: 400, message: 'v4RunId 必填' })
            return
        }
        try {
            const data = await service.getRun(v4RunId)
            if (!data) {
                res.status(404).json({ code: 404, message: 'run not found' })
                return
            }
            res.json({ code: 0, data, message: '' })
        } catch (err: unknown) {
            sendError(res, err)
        }
    })

    router.get('/comparisons/:comparisonId', async (req: Request, res: Response) => {
        const comparisonId = paramString(req, 'comparisonId')
        if (!comparisonId) {
            res.status(400).json({ code: 400, message: 'comparisonId 必填' })
            return
        }
        try {
            const data = await service.getComparison(comparisonId)
            if (!data) {
                res.status(404).json({ code: 404, message: 'comparison not found' })
                return
            }
            res.json({ code: 0, data, message: '' })
        } catch (err: unknown) {
            sendError(res, err)
        }
    })

    return router
}

export const brainV4InternalRouter = createBrainV4InternalRouter()

export default brainV4InternalRouter
