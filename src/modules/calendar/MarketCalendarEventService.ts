import { createHash } from 'node:crypto'
import pool from '../../core/db'
import type { CalendarEvent } from './CalendarRuleService'
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService'

export interface CalendarEventRow {
  id: number
  event_date: string
  title: string
  importance: 'high' | 'medium' | 'low'
  market: 'CN' | 'US_OVERNIGHT'
  event_time: string | null
  source: 'L1' | 'L2' | 'L3' | 'L4'
  detail: string | null
  result: string | null
}

export interface CalendarEventInput {
  event_date: string
  title: string
  importance?: 'high' | 'medium' | 'low'
  market?: 'CN' | 'US_OVERNIGHT'
  event_time?: string | null
  source?: 'L1' | 'L2' | 'L3' | 'L4'
  detail?: string | null
  result?: string | null
}

/** title 归一化：trim + 去空白标点 + 小写（upsert 去重键，spec §4.4）。
 * 用 Unicode 属性转义（\p{P} 标点 / \p{S} 符号），避免 \W 把中文当非单词字符删光。 */
export function normalizeTitle(title: string): string {
  return title.replace(/[\s\p{P}\p{S}_]+/gu, '').toLowerCase()
}

/** upsert 键 = event_date + title 归一化 hash（三源共用去重）。 */
export function dedupHash(eventDate: string, title: string): string {
  return createHash('sha256').update(`${eventDate}|${normalizeTitle(title)}`).digest('hex').slice(0, 16)
}

/** 表记录 source → 对外 type 推导（L2/L3 财报预告→earnings，宏观标题→macro，L4→seed）。 */
export function typeFromSource(row: Pick<CalendarEventRow, 'source' | 'title'>): CalendarEvent['type'] {
  if (row.source === 'L1') return 'delivery'
  if (row.source === 'L2' || row.source === 'L3') {
    if (/(发布日程|CPI|PPI|PMI|社融|FOMC|议息)/.test(row.title)) return 'macro'
    return 'earnings'
  }
  return 'seed'
}

/** 事件 time ≥ 15:00 视为隔夜（§4.5 上海 15:00 边界）。event_time 格式 HH:MM。 */
export function isOvernightEvent(eventTime: string | null): boolean {
  if (!eventTime) return false
  const h = Number(eventTime.slice(0, 2))
  if (Number.isNaN(h)) return false
  return h >= 15
}

export async function listEvents(dateFrom: string, dateTo: string): Promise<CalendarEventRow[]> {
  const result = await pool.query<CalendarEventRow>(
    `SELECT id, to_char(event_date, 'YYYY-MM-DD') AS event_date, title, importance, market, event_time, source, detail, result
     FROM market_calendar_events WHERE event_date BETWEEN $1 AND $2 ORDER BY event_date ASC, event_time ASC NULLS LAST, title ASC`,
    [dateFrom, dateTo],
  )
  return result.rows
}

export async function upsertEvent(input: CalendarEventInput): Promise<{ id: number; upserted: boolean }> {
  const importance = input.importance ?? 'medium'
  const market = input.market ?? 'CN'
  const source = input.source ?? 'L3'
  const eventTime = input.event_time ?? null
  const detail = input.detail ?? null
  const result = input.result ?? null
  const hash = dedupHash(input.event_date, input.title)
  const dbResult = await pool.query<{ id: string; inserted: boolean }>(
    `INSERT INTO market_calendar_events (event_date, title, importance, market, event_time, source, detail, result, dedup_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (event_date, dedup_hash) DO UPDATE
       SET importance = EXCLUDED.importance, market = EXCLUDED.market, event_time = EXCLUDED.event_time,
           source = EXCLUDED.source, detail = EXCLUDED.detail, result = EXCLUDED.result
     RETURNING id, (xmax = 0) AS inserted`,
    [input.event_date, input.title, importance, market, eventTime, source, detail, result, hash],
  )
  const row = dbResult.rows[0]
  return { id: Number(row.id), upserted: row.inserted === true }
}

/** 事件行 → 对外契约（US 隔夜 ≥15:00 顺延次一交易日，§4.5；日历未覆盖年份 fail-close 保留原日期）。 */
export function toContractEvent(row: CalendarEventRow): Record<string, unknown> {
  let date = row.event_date
  if (row.market === 'US_OVERNIGHT' && isOvernightEvent(row.event_time)) {
    try {
      date = TradingCalendarService.getNextTradingDay(new Date(`${row.event_date}T00:00:00Z`))
        .toISOString()
        .slice(0, 10)
    } catch {
      /* 日历未覆盖：保留原日期 */
    }
  }
  return { date, type: typeFromSource(row), title: row.title, importance: row.importance, source: row.source, event_time: row.event_time, result: row.result }
}
