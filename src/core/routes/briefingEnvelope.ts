/**
 * 早/午/晚报统一出口：briefing.v1 信封归一化。
 *
 * 只做只读投影，不改生成链路：
 * - pre  ← brief_morning + broadcast_morning
 * - mid  ← midday 报告
 * - post ← brief_evening + broadcast_evening
 *
 * 渲染差异（头条、机会/风险、异象/行情）保留在 display_report 的可选字段里，
 * 由前端按 slot 决定展示哪些块。
 */

export type BriefingSlot = 'pre' | 'mid' | 'post'
export type BriefingReportType = 'morning' | 'midday' | 'evening'

export interface BriefingTag {
    text: string
    type?: 'stock' | 'sector'
}

export interface BriefingHighlight {
    label: string
    title?: string
    conclusion: string
    tags: BriefingTag[]
}

export interface BriefingSection {
    id: string
    title: string
    conclusion: string
    source: string | null
    tags: BriefingTag[]
    opportunities?: string[]
    risks?: string[]
    claim_ids: string[]
    judgment_id: string | null
    is_headline: boolean
}

export interface BriefingDisplayReport {
    summary: string
    highlight: BriefingHighlight | null
    sections: BriefingSection[]
    risks: string[]
}

export interface BriefingIndexPerf {
    name: string
    close: number | null
    pct_change: number | null
}

export interface BriefingSectorPerf {
    name: string
    pct_change: number | null
}

export interface BriefingBreadth {
    advance_count: number | null
    decline_count: number | null
    flat_count: number | null
}

/** 晚报专属区块：异象判定 + 大盘/板块行情（由 review 报告只读投影）。 */
export interface BriefingEveningExtras {
    has_anomaly: boolean
    anomaly_conclusion: string | null
    indexes: BriefingIndexPerf[]
    breadth: BriefingBreadth | null
    sector_ranking: {
        top_gainers: BriefingSectorPerf[]
        top_losers: BriefingSectorPerf[]
    }
}

export interface BriefingEnvelope {
    schema_version: 'briefing.v1'
    report_type: BriefingReportType
    slot: BriefingSlot
    date: string
    as_of: string
    display_report: BriefingDisplayReport
    podcast_brief: unknown
    audio_path: string | null
    judgment_ids: string[]
    /** 仅晚报（post）有值；晨报/午报为 null。 */
    evening_extras: BriefingEveningExtras | null
}

export interface BriefingReportRow {
    content: Record<string, unknown>
    created_at?: string | null
    report_date?: string | null
    status?: string | null
}

export interface BroadcastReportRow {
    content: Record<string, unknown>
}

interface BriefEnvelopeInput {
    slot: 'pre' | 'post'
    date: string
    brief: BriefingReportRow
    broadcast?: BroadcastReportRow | null
    /** 晚报附加：review 报告行（用于异象结论与行情投影）。 */
    review?: BriefingReportRow | null
}

interface MiddayEnvelopeInput {
    date: string
    report: BriefingReportRow
}

const EVIDENCE_SOURCE_MAP: Record<string, string> = {
    morning: 'morning',
    wind_leader: 'wind_leader',
    hot_burst: 'hot_burst',
    review: 'review',
    trend_score: 'trend',
    event_conduction: 'event',
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function asArray(value: unknown): unknown[] | null {
    return Array.isArray(value) ? value : null
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null
}

function stringArray(value: unknown): string[] {
    return (asArray(value) ?? []).filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

function resolveAsOf(content: Record<string, unknown>, row: BriefingReportRow, date: string): string {
    return nonEmptyString(content.as_of)
        ?? nonEmptyString(row.created_at)
        ?? `${date}T00:00:00+08:00`
}

function sourceFromEvidence(item: Record<string, unknown>): string | null {
    const evidence = asArray(item.evidence)?.[0]
    const reportType = asRecord(evidence)?.report_type
    if (typeof reportType !== 'string') return null
    return EVIDENCE_SOURCE_MAP[reportType] ?? null
}

function mapBriefItem(item: unknown, slot: 'pre' | 'post', index: number): BriefingSection | null {
    const record = asRecord(item)
    if (!record) return null
    const title = nonEmptyString(record.title)
    const conclusion = nonEmptyString(record.conclusion)
    if (!title || !conclusion) return null
    return {
        id: `${slot}-${index}`,
        title,
        conclusion,
        source: sourceFromEvidence(record),
        tags: [],
        claim_ids: [],
        judgment_id: null,
        is_headline: index === 0,
    }
}

function asFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

/** 指数：review 快照里 indexes 可能是对象 map（生产）或数组（旧 fixture）。 */
function mapIndexes(value: unknown): BriefingIndexPerf[] {
    const entries = Array.isArray(value)
        ? value
        : asRecord(value) ? Object.values(value as Record<string, unknown>) : []
    return entries
        .map((entry) => {
            const record = asRecord(entry)
            if (!record) return null
            const name = nonEmptyString(record.name)
            if (!name) return null
            return {
                name,
                close: asFiniteNumber(record.close),
                pct_change: asFiniteNumber(record.change_pct ?? record.pct_change),
            }
        })
        .filter((item): item is BriefingIndexPerf => item !== null)
}

/** 板块：取前 5 个，字段名固定为 pct_change。 */
function mapSectors(value: unknown): BriefingSectorPerf[] {
    return (asArray(value) ?? [])
        .slice(0, 5)
        .map((entry) => {
            const record = asRecord(entry)
            if (!record) return null
            const name = nonEmptyString(record.name)
            if (!name) return null
            return { name, pct_change: asFiniteNumber(record.pct_change) }
        })
        .filter((item): item is BriefingSectorPerf => item !== null)
}

function mapBreadth(value: unknown): BriefingBreadth | null {
    const record = asRecord(value)
    if (!record) return null
    const advance = asFiniteNumber(record.advance_count)
    const decline = asFiniteNumber(record.decline_count)
    const flat = asFiniteNumber(record.flat_count)
    if (advance === null && decline === null && flat === null) return null
    return { advance_count: advance, decline_count: decline, flat_count: flat }
}

const ATTRIBUTION_TITLE = '归因结论'
const NO_ANOMALY_KEYWORDS = ['证据不足', '未确认主因']

/** 归因结论：优先 review.attribution_summary，缺失时回退 brief 的「归因结论」条目。 */
function resolveAttributionConclusion(
    briefContent: Record<string, unknown>,
    reviewContent: Record<string, unknown> | null,
): string | null {
    const trace = asRecord(asRecord(reviewContent?.market_trace)?.trace)
    const summary = nonEmptyString(trace?.attribution_summary)
    if (summary) return summary
    for (const item of asArray(briefContent.items) ?? []) {
        const record = asRecord(item)
        if (record?.title === ATTRIBUTION_TITLE) {
            return nonEmptyString(record.conclusion)
        }
    }
    return null
}

/**
 * 晚报 extras 只读投影（与前端 eveningBriefCards 的判定口径一致）：
 * - brief 降级或 review 未完成 → 无异象
 * - 结论文本含「证据不足 / 未确认主因」→ 无异象
 * - 其余（含 review 缺失）→ 保守判定有异象
 */
function buildEveningExtras(
    briefContent: Record<string, unknown>,
    review: BriefingReportRow | null | undefined,
): BriefingEveningExtras {
    const reviewContent = asRecord(review?.content)
    const conclusion = resolveAttributionConclusion(briefContent, reviewContent)
    const degraded = briefContent.degraded === true
    const reviewIncomplete = !!review && review.status !== 'completed'
    const hasAnomaly = !degraded && !reviewIncomplete
        && !(conclusion && NO_ANOMALY_KEYWORDS.some((keyword) => conclusion.includes(keyword)))

    const snapshot = asRecord(asRecord(reviewContent?.market_trace)?.snapshot)
    const aShare = asRecord(snapshot?.a_share)
    const sectors = asRecord(aShare?.sectors)

    return {
        has_anomaly: hasAnomaly,
        anomaly_conclusion: conclusion,
        indexes: mapIndexes(aShare?.indexes),
        breadth: mapBreadth(aShare?.breadth),
        sector_ranking: {
            top_gainers: mapSectors(sectors?.top_gainers),
            top_losers: mapSectors(sectors?.top_losers),
        },
    }
}

export function buildBriefEnvelope(input: BriefEnvelopeInput): BriefingEnvelope {
    const content = input.brief.content
    const items = asArray(content.items) ?? []
    const sections = items
        .map((item, index) => mapBriefItem(item, input.slot, index))
        .filter((section): section is BriefingSection => section !== null)

    const highlight: BriefingHighlight | null = input.slot === 'pre' && sections[0]
        ? {
            label: '今日头条',
            title: sections[0].title,
            conclusion: sections[0].conclusion,
            tags: sections[0].tags,
        }
        : null

    const summary = input.slot === 'post'
        ? sections.find((section) => section.title === '收盘复盘')?.conclusion
            ?? sections[0]?.conclusion
            ?? ''
        : sections[0]?.conclusion ?? ''

    const broadcastContent = input.broadcast?.content
    const dialogue = asArray(broadcastContent?.dialogue)

    return {
        schema_version: 'briefing.v1',
        report_type: input.slot === 'pre' ? 'morning' : 'evening',
        slot: input.slot,
        date: input.date,
        as_of: resolveAsOf(content, input.brief, input.date),
        display_report: {
            summary,
            highlight,
            sections,
            risks: [],
        },
        podcast_brief: dialogue ?? content.podcast_brief ?? null,
        audio_path: nonEmptyString(broadcastContent?.audio_path),
        judgment_ids: [],
        evening_extras: input.slot === 'post' ? buildEveningExtras(content, input.review) : null,
    }
}

function mapMiddaySection(value: unknown, index: number): BriefingSection | null {
    const record = asRecord(value)
    if (!record) return null
    const title = nonEmptyString(record.title)
    const conclusion = nonEmptyString(record.conclusion)
    if (!title || !conclusion) return null

    const opportunities = stringArray(record.opportunities)
    const risks = stringArray(record.risks)
    return {
        id: `mid-${index}`,
        title,
        conclusion,
        source: 'midday',
        tags: [],
        ...(opportunities.length ? { opportunities } : {}),
        ...(risks.length ? { risks } : {}),
        claim_ids: [],
        judgment_id: null,
        is_headline: false,
    }
}

export function buildMiddayEnvelope(input: MiddayEnvelopeInput): BriefingEnvelope {
    const content = input.report.content
    const display = asRecord(content.display_report) ?? {}
    const sections = (asArray(display.sections) ?? [])
        .map((section, index) => mapMiddaySection(section, index))
        .filter((section): section is BriefingSection => section !== null)

    return {
        schema_version: 'briefing.v1',
        report_type: 'midday',
        slot: 'mid',
        date: input.date,
        as_of: resolveAsOf(content, input.report, input.date),
        display_report: {
            summary: nonEmptyString(display.summary) ?? '',
            highlight: null,
            sections,
            risks: stringArray(display.risks),
        },
        podcast_brief: content.podcast_brief ?? null,
        audio_path: nonEmptyString(content.audio_path),
        judgment_ids: [],
        evening_extras: null,
    }
}
