/**
 * Event Entity 服务（spec §3/§10，design-debate 2026-09-15 定稿）。
 *
 * 职责边界：
 * - event_id 仅 app-api 首写生成（不可变随机 ID，ON CONFLICT 不更新）；
 * - canonical_event_key = event_start_date|canonical_title，只做确定性幂等
 *   （spec §3.1），不做语义 Merge；canonical_title 复用 calendar 模块归一化，
 *   保证 News/Calendar 两通道未来收敛时 key 口径一致；
 * - event_status 为确定性纯函数；写库列仅 display-only 快照，**读时按 now
 *   重算为权威**（design-debate：now 越过 start/end 无刷新作业的闭合）。
 */

import { randomUUID } from 'node:crypto'

import pool from '../../core/db'

export type EventEntityStatus = 'scheduled' | 'upcoming' | 'ongoing' | 'occurred'

export const SOURCE_TYPES = ['news', 'calendar', 'announcement', 'manual', 'agent'] as const
export const TIME_SOURCES = [
    'calendar',
    'official_announcement',
    'news_extraction',
    'manual',
    'publish_time_fallback',
] as const

export interface EventEntityRow {
    event_id: string
    canonical_event_key: string
    title: string
    summary: string | null
    scrape_at: string
    publish_time: string | null
    event_start_time: string
    event_end_time: string | null
    time_source: string
    time_confidence: number | null
    event_status: string
    source_type: string
    source_event_id: string | null
    created_at: string
    updated_at: string
}

export interface EventEntityInput {
    title: string
    source_type: (typeof SOURCE_TYPES)[number]
    event_start_time: string
    publish_time?: string | null
    event_end_time?: string | null
    time_source: (typeof TIME_SOURCES)[number]
    time_confidence?: number | null
    summary?: string | null
    source_event_id?: string | null
}

/** 判断是否为 date-only（00:00 整点），spec §3.4：当日整天 ongoing、次日 0 点 occurred。 */
export function isDateOnly(iso: string): boolean {
    return /^\d{4}-\d{2}-\d{2}T00:00:00/.test(iso)
}

/**
 * 确定性状态机（禁 LLM，spec §3.3/§6.1）：
 * - date-only：当日整天 ongoing，次日 0 点起 occurred；
 * - 单日（无 end）：end=start；
 * - 多日：start≤now≤end → ongoing，now>end → occurred；
 * - event_start_time 为 NULL（历史 fallback）→ 保守 occurred，不冒充未来。
 * upcoming（预热窗口）待 P1 预热语义定义，P0 一律落 scheduled。
 */
export function computeEventStatus(
    startIso: string | null,
    endIso: string | null,
    nowIso: string,
): EventEntityStatus {
    const now = new Date(nowIso).getTime()
    if (!startIso) return 'occurred'
    const start = new Date(startIso)
    const startMs = start.getTime()
    if (now < startMs) return 'scheduled'
    if (isDateOnly(startIso)) {
        // date-only：事件日整天有效，次日 0 点前均 ongoing（spec §3.4）
        const nextDay = new Date(startMs + 24 * 3600 * 1000)
        return now < nextDay.getTime() ? 'ongoing' : 'occurred'
    }
    // 单日（无 end）= start；多日 = end。含 end 时刻（start≤now≤end → ongoing）
    const end = endIso ? new Date(endIso) : new Date(start)
    return now <= end.getTime() ? 'ongoing' : 'occurred'
}

/** canonical_title 归一化（spec §0.2 硬约束）：NFKC 全角→半角 + 去空白/标点/符号 +
 * 小写；**只去书写噪声、不做语义归并**（"2026-09" vs "9月" 不等价）。
 * 注意：与 calendar 模块 `dedupHash` 各自独立（calendar 用其通道内 key）；
 * 本函数是 Event Entity canonical 的统一口径，未来 calendar→entity 物化作业须复用本函数。 */
export function normalizeTitle(title: string): string {
    return String(title)
        .normalize('NFKC')
        .replace(/[\s\p{P}\p{S}_]+/gu, '')
        .toLowerCase()
}

/** canonical_event_key = event_start_date|canonical_title（spec §3.1，无通道前缀）。 */
export function canonicalKey(eventStartDate: string, title: string): string {
    return `${eventStartDate}|${normalizeTitle(title)}`
}

/** event_start_time → 上海时区日期（YYYY-MM-DD）。Asia/Shanghai = UTC+8 无 DST，
 * 用固定偏移计算（弃用 locale 类方法，避免 ICU/locale 差异）。 */
export function startDateOf(eventStartTime: string): string {
    const d = new Date(new Date(eventStartTime).getTime() + 8 * 3600 * 1000)
    return d.toISOString().slice(0, 10)
}

export interface UpsertResult {
    row: EventEntityRow
    inserted: boolean
}

/** upsert：canonical_event_key 幂等（spec §3.1）。event_id/created_at 首写即定、
 * 冲突不更新；只更新易变业务字段；source_event_id 首次保留。 */
export async function upsertEventEntity(input: EventEntityInput): Promise<UpsertResult> {
    const key = canonicalKey(startDateOf(input.event_start_time), input.title)
    const db = await pool.query<EventEntityRow & { inserted: unknown }>(
        `INSERT INTO event_entities
           (event_id, canonical_event_key, title, summary, scrape_at, publish_time,
            event_start_time, event_end_time, time_source, time_confidence,
            event_status, source_type, source_event_id)
         VALUES
           ($1, $2, $3, $4, DEFAULT, $5, $6, $7, $8, $9,
            $10, $11, $12)
         ON CONFLICT (canonical_event_key) DO UPDATE SET
            title = EXCLUDED.title,
            summary = EXCLUDED.summary,
            publish_time = EXCLUDED.publish_time,
            event_start_time = EXCLUDED.event_start_time,
            event_end_time = EXCLUDED.event_end_time,
            time_source = EXCLUDED.time_source,
            time_confidence = EXCLUDED.time_confidence,
            event_status = EXCLUDED.event_status,
            source_type = EXCLUDED.source_type,
            source_event_id = COALESCE(EXCLUDED.source_event_id, event_entities.source_event_id),
            updated_at = now()
         RETURNING *, (xmax = 0) AS inserted`,
        [
            `EVT-${randomUUID()}`,
            key,
            input.title,
            input.summary ?? null,
            input.publish_time ?? null,
            input.event_start_time,
            input.event_end_time ?? null,
            input.time_source,
            input.time_confidence ?? null,
            computeEventStatus(
                input.event_start_time,
                input.event_end_time ?? null,
                new Date().toISOString(),
            ),
            input.source_type,
            input.source_event_id ?? null,
        ],
    )
    const r = db.rows[0]
    // xmax 命中冲突时为非 0（新行 xmax=0）；pg 布尔按 't'/'f' 解析为 boolean
    const inserted = r.inserted === true || String(r.inserted) === 't'
    return { row: r, inserted }
}

export interface EventEntityListFilters {
    dateFrom?: string
    dateTo?: string
    status?: EventEntityStatus
}

/** 列表查询：日期过滤作用于 event_start_date 表达列（NULL 行不参与但照常返回）；
 * status 过滤由调用方在读时重算值上执行（本函数只做日期过滤，缺省不过滤）。 */
export async function listEventEntities(
    filters: EventEntityListFilters = {},
): Promise<EventEntityRow[]> {
    const clauses: string[] = []
    const values: string[] = []
    if (filters.dateFrom) {
        values.push(filters.dateFrom)
        clauses.push(
            `to_char(CAST(event_start_time AT TIME ZONE 'Asia/Shanghai' AS date), 'YYYY-MM-DD') >= $${values.length}`,
        )
    }
    if (filters.dateTo) {
        values.push(filters.dateTo)
        clauses.push(
            `to_char(CAST(event_start_time AT TIME ZONE 'Asia/Shanghai' AS date), 'YYYY-MM-DD') <= $${values.length}`,
        )
    }
    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const db = await pool.query<EventEntityRow>(
        `SELECT * FROM event_entities ${whereClause}
         ORDER BY event_start_time ASC, created_at ASC`,
        values,
    )
    return db.rows
}

/** 读时重算：附加权威 status（覆盖写库 display-only 快照），供过滤/展示使用。 */
export function withComputedStatus(
    rows: EventEntityRow[],
    nowIso: string,
): Array<EventEntityRow & { computed_status: EventEntityStatus }> {
    return rows.map((row) => ({
        ...row,
        computed_status: computeEventStatus(row.event_start_time, row.event_end_time, nowIso),
    }))
}

/** 对外契约：agent-py GET 消费 data.items（对齐 data_client.get_event_entities）。 */
export function toContractEventEntity(
    row: EventEntityRow & { computed_status?: EventEntityStatus },
): Record<string, unknown> {
    return {
        event_id: row.event_id,
        title: row.title,
        summary: row.summary,
        publish_time: row.publish_time,
        event_start_time: row.event_start_time,
        event_end_time: row.event_end_time,
        // 读时重算优先，无则落写库快照
        event_status: row.computed_status ?? row.event_status,
        time_source: row.time_source,
        // pg NUMERIC 默认返回字符串，契约层统一转 number（null 保留）
        time_confidence: row.time_confidence === null ? null : Number(row.time_confidence),
        source_type: row.source_type,
        source_event_id: row.source_event_id,
    }
}