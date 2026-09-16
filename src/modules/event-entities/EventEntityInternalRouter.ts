/**
 * Event Entity internal router（spec §10.2，design-debate 2026-09-15 定稿）。
 *
 * 信封纪律：GET/POST 一律 `{ code: 200, data: ... }`——agent-py `_request`
 * 只收 code==200（记忆 #59：calendar POST code:0 是坑）；禁止抄 calendar 的 code:0。
 * 鉴权：独立 token（INTERNAL_API_TOKEN || INTERNAL_TOKEN 动态求值，对齐 calendar 先例）。
 */

import { type Request, type Response, Router } from 'express'

import {
    computeEventStatus,
    listEventEntities,
    toContractEventEntity,
    upsertEventEntity,
    withComputedStatus,
    type EventEntityInput,
    SOURCE_TYPES,
    TIME_SOURCES,
} from './EventEntityService'

export const eventEntityInternalRouter: Router = Router()

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)?$/
const STATUS_ENUM = new Set(['scheduled', 'upcoming', 'ongoing', 'occurred'])

// token 请求时动态求值（对齐 calendar internalRouter：模块加载期常量会被 dotenv
// 抢先固化，测试 before() 设置的 token 无法生效）
function currentInternalToken(): string {
    return process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production'
}

eventEntityInternalRouter.use((req: Request, res: Response, next) => {
    if (req.headers['x-internal-token'] !== currentInternalToken()) {
        return res.status(403).json({ code: 403, message: 'Forbidden — invalid internal token' })
    }
    next()
})

// date-only 'YYYY-MM-DD' → 上海零点 ISO（agent-py 物化契约同款格式）
function normalizeStartTime(v: string): string | null {
    if (DATE_RE.test(v)) return `${v}T00:00:00+08:00`
    if (ISO_RE.test(v)) return v
    return null
}

eventEntityInternalRouter.post('/', async (req: Request, res: Response) => {
    try {
        const body = (req.body ?? {}) as Record<string, unknown>
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (!title) {
            return res.status(400).json({ code: 400, message: 'title 必填' })
        }
        const source_type = String(body.source_type ?? '')
        if (!SOURCE_TYPES.includes(source_type as (typeof SOURCE_TYPES)[number])) {
            return res.status(400).json({ code: 400, message: 'source_type 须为 news/calendar/announcement/manual/agent' })
        }
        const startRaw = typeof body.event_start_time === 'string' ? body.event_start_time : ''
        const event_start_time = normalizeStartTime(startRaw)
        if (!event_start_time) {
            return res.status(400).json({ code: 400, message: 'event_start_time 必填且须为 YYYY-MM-DD 或 ISO 时间' })
        }
        const time_source = String(body.time_source ?? 'publish_time_fallback')
        if (!TIME_SOURCES.includes(time_source as (typeof TIME_SOURCES)[number])) {
            return res.status(400).json({ code: 400, message: 'time_source 枚举不合法' })
        }
        let time_confidence: number | null = null
        if (body.time_confidence !== undefined && body.time_confidence !== null) {
            time_confidence = Number(body.time_confidence)
            if (!Number.isFinite(time_confidence) || time_confidence < 0 || time_confidence > 1) {
                return res.status(400).json({ code: 400, message: 'time_confidence 须为 0~1' })
            }
        }
        const event_end_time = typeof body.event_end_time === 'string' && body.event_end_time ? body.event_end_time : null
        const publish_time = typeof body.publish_time === 'string' && body.publish_time ? body.publish_time : null
        const summary = typeof body.summary === 'string' ? body.summary : null
        const source_event_id = typeof body.source_event_id === 'string' && body.source_event_id ? body.source_event_id : null

        const input: EventEntityInput = {
            title,
            source_type: source_type as EventEntityInput['source_type'],
            event_start_time,
            publish_time,
            event_end_time,
            time_source: time_source as EventEntityInput['time_source'],
            time_confidence,
            summary,
            source_event_id,
        }
        const { row } = await upsertEventEntity(input)
        const nowIso = new Date().toISOString()
        const entity = toContractEventEntity({
            ...row,
            computed_status: computeEventStatus(row.event_start_time, row.event_end_time, nowIso),
        })
        res.json({ code: 200, data: entity })
    } catch (err) {
        console.error('[EventEntity] POST / error:', err)
        res.status(502).json({ code: 502, message: String(err) })
    }
})

eventEntityInternalRouter.get('/', async (req: Request, res: Response) => {
    try {
        const status = req.query.status ? String(req.query.status) : undefined
        if (status && !STATUS_ENUM.has(status)) {
            return res.status(400).json({ code: 400, message: 'status 须为 scheduled/upcoming/ongoing/occurred' })
        }
        const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : undefined
        const dateTo = req.query.dateTo ? String(req.query.dateTo) : undefined
        if (dateFrom && !DATE_RE.test(dateFrom)) {
            return res.status(400).json({ code: 400, message: 'dateFrom 须为 YYYY-MM-DD' })
        }
        if (dateTo && !DATE_RE.test(dateTo)) {
            return res.status(400).json({ code: 400, message: 'dateTo 须为 YYYY-MM-DD' })
        }
        const rows = await listEventEntities({ dateFrom, dateTo })
        const computed = withComputedStatus(rows, new Date().toISOString())
        const filtered = status ? computed.filter((r) => r.computed_status === status) : computed
        res.json({ code: 200, data: { items: filtered.map(toContractEventEntity) } })
    } catch (err) {
        console.error('[EventEntity] GET / error:', err)
        res.status(502).json({ code: 502, message: String(err) })
    }
})