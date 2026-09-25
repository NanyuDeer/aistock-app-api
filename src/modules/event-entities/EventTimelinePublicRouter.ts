/**
 * 重大事件时间线公开 API（spec §2/§3/§10.1，Phase 1）。
 *
 * 本接口**不读 `agent_analysis_reports`**（spec §2 冻结原则：GI 旁路、不 Gate Timeline）。
 * 时间线不依赖事件传导是否完成、不依赖 GI；未来事件无传导也照常展示。
 * event_status 必须用读时重算值，禁止直接用落库快照（spec §3.3 读时重算）。
 *
 * 例外（2026-09-24 展示层对齐 + 过滤）：① `source_type='news'` 事件的**标题**按事件传导报告
 * `content.title`（LLM 理解提炼标题）兜底覆盖——仅展示层对齐（时间线与事件传导标题
 * 一致），不 Gate、不依赖传导完成；无传导报告的 news 事件回退 `event_entities.title`
 * （原始抓取标题），calendar 等其余类型原样透传。
 * ② 影响板块 impactSectors 对所有事件按传导 chain Top3，空回退 event_entities.impact_sectors 列。
 * ③ **occurred 事件必须在事件传导报告存在**，否则排除（无报告事件点击详情 404 → 前端「服务
 * 异常」）；scheduled/upcoming/ongoing 未来事件保留（点击就地展开不跳详情）。
 *
 * 挂载点：index.ts 在反代之前以 app.use('/api/agent', eventTimelinePublicRouter) 注册。
 * 路径：GET /api/agent/event/timeline
 */

import { type Request, type Response, Router } from 'express'

import pool from '../../core/db'
import {
    listEventEntities,
    normalizeImpactSectors,
    withComputedStatus,
    startDateOf,
    type EventEntityStatus,
} from './EventEntityService'

export const eventTimelinePublicRouter: Router = Router()

/** YYYY-MM-DD 正则校验。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** 枚举集合：合法 status 值。 */
const STATUS_ENUM: ReadonlySet<string> = new Set([
    'scheduled',
    'upcoming',
    'ongoing',
    'occurred',
])
const ORDER_ENUM: ReadonlySet<string> = new Set(['asc', 'desc'])
/** pageSize 上限 100（防止过大分页压垮 DB）。 */
const MAX_PAGE_SIZE = 100
/** pageSize 缺省值。 */
const DEFAULT_PAGE_SIZE = 20
/** 时间线展示的最大影响板块数（conduction chain 按 impactStrength 降序取前 N）。 */
const MAX_IMPACT_SECTORS = 3

/**
 * 上海时区墙钟日期（固定 +8，无 DST）。用 startDateOf 保持一致计算口径。
 * 对齐 EventEntityService.startDateOf 既有做法。
 */
function shanghaiToday(): string {
    return startDateOf(new Date().toISOString())
}

/**
 * 上海时区日期偏移 N 天（YYYY-MM-DD），N 可为负数（过去）。
 */
function offsetDate(dateStr: string, days: number): string {
    const ms = new Date(dateStr + 'T00:00:00+08:00').getTime() + days * 86400000
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 单事件的传导报告载荷（最新一份）：提炼标题 + 传导 chain。 */
interface ConductionPayload {
    /** 事件传导报告 content.title（LLM 提炼短标题），无/空为 null */
    title: string | null
    /** content.analysis_reports.event_transmission.chain（原始数组，可为 null） */
    chain: unknown
}

/**
 * 读取事件传导报告载荷（标题 + chain），按 event_id 分组（2026-09-24 标题对齐 + 影响板块）。
 *
 * 用途：
 * 1. `source_type='news'` 事件标题与事件传导页保持一致（content.title 优先）；
 * 2. **所有**事件的影响板块优先取传导 chain（按 impactStrength 降序 Top3），
 *    无 chain 再回退 `event_entities.impact_sectors` 列（未来事件 KG 预计算兜底）。
 *
 * 只作用于传入的 paged eventIds（≤ pageSize ≤ 100），避免全表扫描。
 * 记忆 #xx（42P18）：不用 `= ANY($n)` 传 JS 数组，用 `IN ($1,$2,...)` 标量参数。
 */
async function loadConductionPayloads(eventIds: string[]): Promise<Map<string, ConductionPayload>> {
    const map = new Map<string, ConductionPayload>()
    const ids = eventIds.filter((id) => id)
    if (ids.length === 0) return map
    // DISTINCT ON：同一事件多次传导取最新一份报告（created_at DESC 先到先得）
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
    const { rows } = await pool.query<{
        user_id: string
        title: string | null
        chain: unknown
    }>(
        `SELECT DISTINCT ON (user_id) user_id,
                content->>'title' AS title,
                content->'analysis_reports'->'event_transmission'->'chain' AS chain
         FROM agent_analysis_reports
         WHERE report_type = 'event_conduction'
           AND user_id IN (${placeholders})
         ORDER BY user_id, created_at DESC`,
        ids,
    )
    for (const row of rows) {
        map.set(row.user_id, {
            title: row.title && row.title !== '' ? row.title : null,
            chain: row.chain ?? null,
        })
    }
    return map
}

/**
 * 从传导 chain 提取时间线展示的核心影响板块（纯函数）。
 *
 * 规则（对齐 internal.ts extractChainSummary 的行业口径）：
 *  - chain 缺失/非数组 → []
 *  - 过滤 industry 为空的节点
 *  - 按 impactStrength 降序，最多 max 条，只取 industry 名（时间线不需要方向/强度）
 *  - 不修改原 chain
 */
function topImpactSectors(chain: unknown, max = MAX_IMPACT_SECTORS): string[] {
    if (!Array.isArray(chain)) return []
    const entries: Array<{ industry: string; strength: number }> = []
    for (const node of chain) {
        if (!node || typeof node !== 'object') continue
        const item = node as Record<string, unknown>
        const industry = typeof item['industry'] === 'string' ? item['industry'].trim() : ''
        // 过滤无效行业（industry 为空不返回）
        if (!industry) continue
        entries.push({
            industry,
            strength: typeof item['impactStrength'] === 'number' ? item['impactStrength'] : 0,
        })
    }
    return entries
        .sort((a, b) => b.strength - a.strength)
        .slice(0, max)
        .map((e) => e.industry)
}

/**
 * GET /event/timeline
 *
 * Query 参数（全部可选）：
 * - dateFrom（YYYY-MM-DD，缺省 = 上海今天）
 * - dateTo（YYYY-MM-DD，缺省 = 上海今天 + 90 天）
 * - status（scheduled|upcoming|ongoing|occurred，缺省不过滤）
 * - order（asc|desc，缺省 asc）
 * - page（缺省 1，最小 1）
 * - pageSize（缺省 20，上限 100）
 *
 * 响应信封：{ code: 0, data: { items: [...], total, page, pageSize, hasMore } }
 */
eventTimelinePublicRouter.get('/event/timeline', async (req: Request, res: Response) => {
    try {
        // --- 参数校验与缺省值 ---
        const today = shanghaiToday()

        const dateFromRaw = typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined
        const dateToRaw = typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined
        const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined
        const orderRaw = typeof req.query.order === 'string' ? req.query.order : undefined
        const pageRaw = typeof req.query.page === 'string' ? req.query.page : undefined
        const pageSizeRaw = typeof req.query.pageSize === 'string' ? req.query.pageSize : undefined

        // 校验非法值 → 400
        if (dateFromRaw !== undefined && !DATE_RE.test(dateFromRaw)) {
            return res.status(400).json({ code: -1, message: 'dateFrom 须为 YYYY-MM-DD' })
        }
        if (dateToRaw !== undefined && !DATE_RE.test(dateToRaw)) {
            return res.status(400).json({ code: -1, message: 'dateTo 须为 YYYY-MM-DD' })
        }
        if (statusRaw !== undefined && !STATUS_ENUM.has(statusRaw)) {
            return res.status(400).json({ code: -1, message: 'status 须为 scheduled/upcoming/ongoing/occurred' })
        }
        if (orderRaw !== undefined && !ORDER_ENUM.has(orderRaw)) {
            return res.status(400).json({ code: -1, message: 'order 须为 asc 或 desc' })
        }

        const page = pageRaw !== undefined ? parseInt(pageRaw, 10) : 1
        if (!Number.isFinite(page) || page < 1) {
            return res.status(400).json({ code: -1, message: 'page 须为 >= 1 的整数' })
        }

        const pageSize = pageSizeRaw !== undefined ? Math.min(parseInt(pageSizeRaw, 10), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE
        if (!Number.isFinite(pageSize) || pageSize < 1) {
            return res.status(400).json({ code: -1, message: 'pageSize 须为 >= 1 的整数' })
        }

        const dateFrom = dateFromRaw ?? today
        const dateTo = dateToRaw ?? offsetDate(today, 90)
        const order = (orderRaw ?? 'asc') as 'asc' | 'desc'

        // --- 查询与处理 ---
        const rows = await listEventEntities({ dateFrom, dateTo })

        // 读时重算 event_status（spec §3.3：写库列仅 display-only 快照，读时重算为权威）
        const nowIso = new Date().toISOString()
        const computed = withComputedStatus(rows, nowIso)

        // 按 computed_status 过滤（若传了 status 参数）
        const filtered = statusRaw
            ? computed.filter((r) => r.computed_status === (statusRaw as EventEntityStatus))
            : computed

        // 按 event_start_time 排序（asc/desc）
        const sorted = [...filtered].sort((a, b) => {
            const cmp = a.event_start_time.localeCompare(b.event_start_time)
            return order === 'desc' ? -cmp : cmp
        })

        // 展示层增强（2026-09-24 标题对齐 + 影响板块 + 传导存在性过滤）：
        // 对排序后全部事件一次读取最新 event_conduction 报告（不 Gate Timeline 准入，
        // 仅展示层：标题对齐 / impactSectors / occurred 事件存在性校验）。
        // 传导存在性过滤（2026-09-24 用户验收）：occurred 事件必须在事件传导报告存在，
        // 否则前端点击详情 404 显示「服务异常」→ 从时间线排除；
        // scheduled/upcoming/ongoing 未来事件保留（点击就地展开「尚未发生」，不跳详情不报错）。
        const allPayloads = await loadConductionPayloads(sorted.map((row) => row.event_id))
        const shown = sorted.filter((row) => {
            if (row.computed_status !== 'occurred') return true
            return allPayloads.has(row.event_id)
        })

        // 分页：先过滤后分页，保证 total/hasMore 正确
        const total = shown.length
        const startIdx = (page - 1) * pageSize
        const paged = shown.slice(startIdx, startIdx + pageSize)
        const hasMore = startIdx + pageSize < total

        // --- 响应序列化 ---
        const items = paged.map((row) => {
            // summary 为 null 时归一为 ''
            const summary = row.summary ?? ''
            // timeConfidence 为 null 保留 null
            const timeConfidence = row.time_confidence === null ? null : Number(row.time_confidence)
            // 新增 date 字段：eventStartTime 的上海时区日期 YYYY-MM-DD
            const date = startDateOf(row.event_start_time)

            const payload = allPayloads.get(row.event_id)
            // news 事件：有传导提炼标题则覆盖展示（与事件传导页标题一致）；无则回退原始标题
            const title = row.source_type === 'news' && payload?.title ? payload.title : row.title
            // 影响板块：传导 chain（最新报告，按 impactStrength 降序 Top3）优先；
            // chain 空/缺失 → 回退 event_entities.impact_sectors 列（未来事件 KG 预计算兜底）；
            // 两者皆无 → []（前端整块不渲染，方案 A：宏观事件允许无板块）
            const chainSectors = topImpactSectors(payload?.chain)
            const impactSectors =
                chainSectors.length > 0 ? chainSectors : normalizeImpactSectors(row.impact_sectors)

            return {
                eventId: row.event_id,
                title,
                summary,
                eventStartTime: row.event_start_time,
                eventEndTime: row.event_end_time,
                eventStatus: row.computed_status,
                sourceType: row.source_type,
                timeSource: row.time_source,
                timeConfidence: timeConfidence,
                sourceEventId: row.source_event_id,
                date,
                impactSectors,
            }
        })

        res.json({
            code: 0,
            data: { items, total, page, pageSize, hasMore },
        })
    } catch (err: unknown) {
        console.error('[EventTimeline] GET /event/timeline error:', err instanceof Error ? err.message : String(err))
        res.status(500).json({ code: -1, message: 'Internal server error' })
    }
})