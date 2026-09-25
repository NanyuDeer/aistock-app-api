/**
 * Calendar → Event Entity 物化作业（spec §7.2/§7.3 重大事件时间线 Phase 0.5）。
 *
 * 本文件只接收 rows（读 calendar 表由 index.ts 编排），避免 modules 间 import。
 * index.ts（composition root）负责：调用 listEvents() → 传递 rows 给本模块。
 *
 * 设计原则：
 * - 确定性准入，禁 LLM：qualifyCalendarEvent 为纯函数，无外部依赖。
 * - 单行容错：materializeCalendarRows 逐行 try/catch，绝不因单行失败中断整批。
 * - upsertEventEntity 同模块内调用，EventEntityInput 导入 EventEntityService 类型。
 */

import {
    upsertEventEntity,
    type EventEntityInput,
} from './EventEntityService'

/**
 * 日历行窄接口（结构化类型，不 import calendar 模块的类型，避免跨模块依赖）。
 * event_date 为 'YYYY-MM-DD'，title 为日历标题，importance 为 'high' | 'medium' | 'low'，
 * source 为 'L1' | 'L2' | 'L3' | 'L4'，detail 为可选详情。
 */
export interface CalendarRowLike {
    event_date: string // 'YYYY-MM-DD'
    title: string
    importance: string // 'high' | 'medium' | 'low'
    source: string // 'L1' | 'L2' | 'L3' | 'L4'
    detail?: string | null
}

/**
 * 确定性准入（禁 LLM）。Calendar 不能全量进入时间线（spec §7.2/§7.3 红线）。
 *
 * 规则说明：
 * - row.importance === 'high' → true：项目的 high 仅由种子 source='L4' 显式录入
 *   或候选晋升产生，代表已确认为重大事件（spec §7.2 重大事件定义）。
 * - row.source === 'L4' → true：种子事件，人工显式录入（spec §7.3 种子源）。
 * - 其他 → false：防止时间线退化成普通活动日历（日常公告、低优提醒等
 *   不应填充时间线，保证时间线的「重大」语义浓度）。
 */
export function qualifyCalendarEvent(row: CalendarRowLike): boolean {
    if (row.importance === 'high') return true
    if (row.source === 'L4') return true
    return false
}

/**
 * 日历行 → EventEntityInput 映射。
 *
 * 映射要点（spec §3.4/§5B.4）：
 * - event_start_time：date-only → `${row.event_date}T00:00:00+08:00`。
 *   computeEventStatus 依赖 isDateOnly 的 `^\d{4}-\d{2}-\d{2}T00:00:00` 前缀
 *   判定"当日整天 ongoing、次日 occurred"，**不要改动这个格式**。
 * - event_end_time = 同 event_start_time（单日事件 end = start，spec §3.4）。
 * - time_confidence = 0.95：日历来源可靠、日期明确（spec §5B.4）。
 * - 使用原始 row.event_date，不要套用 toContractEvent 的 US 隔夜顺延
 *   （时间线按事件真实发生日展示）。
 * - source_type: 'calendar'
 * - time_source: 'calendar'
 */
export function toCalendarEntityInput(row: CalendarRowLike): EventEntityInput {
    const startTime = `${row.event_date}T00:00:00+08:00`
    return {
        title: row.title,
        source_type: 'calendar',
        event_start_time: startTime,
        event_end_time: startTime, // 单日事件 end = start
        time_source: 'calendar',
        time_confidence: 0.95,
        summary: row.detail ?? null,
        source_event_id: null,
    }
}

/**
 * MaterializeCalendarRowsResult：物化结果统计。
 */
export interface MaterializeCalendarRowsResult {
    materialized: number
    skipped: number
    failed: number
}

/**
 * 逐行物化：qualifyCalendarEvent 不过 → skipped++；通过 →
 * await upsertEventEntity(toCalendarEntityInput(row)) →
 * 成功 materialized++，单行异常 catch 后 failed++ 并 console.warn。
 *
 * 绝不因单行失败中断整批（幂等 upsert，重复执行不产生重复实体）。
 */
export async function materializeCalendarRows(
    rows: CalendarRowLike[],
): Promise<MaterializeCalendarRowsResult> {
    let materialized = 0
    let skipped = 0
    let failed = 0

    for (const row of rows) {
        // 确定性准入过滤（spec §7.2 红线：防止时间线退化成普通活动日历）
        if (!qualifyCalendarEvent(row)) {
            skipped++
            continue
        }

        try {
            await upsertEventEntity(toCalendarEntityInput(row))
            materialized++
        } catch (err: unknown) {
            failed++
            console.warn(
                '[CalendarEntityMaterializer] 单行物化失败:',
                `title="${row.title}"`,
                `date="${row.event_date}"`,
                err instanceof Error ? err.message : String(err),
            )
        }
    }

    return { materialized, skipped, failed }
}