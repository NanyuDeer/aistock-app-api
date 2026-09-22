import { createHash } from 'node:crypto'
import pool from '../../core/db'
import type { CalendarEvent } from './CalendarRuleService'
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService'

/** 建表 DDL（index.ts 启动建表 + 测试字面量断言共用，防跨处漂移）。
 * 含 result_source（auto|manual）/result_attempted_at 两列；source 缺省 'L4' 保持。 */
export const DDL_MARKET_CALENDAR_EVENTS = `
CREATE TABLE IF NOT EXISTS market_calendar_events (
  id BIGSERIAL PRIMARY KEY,
  event_date DATE NOT NULL,
  title TEXT NOT NULL,
  importance TEXT NOT NULL DEFAULT 'medium',
  market TEXT NOT NULL DEFAULT 'CN',
  event_time TEXT,
  source TEXT NOT NULL DEFAULT 'L4',
  detail TEXT,
  result TEXT,
  result_source TEXT,
  result_attempted_at TIMESTAMPTZ,
  dedup_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

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
  /** 读侧折叠命中数（同 event_date + 归一标题相同的行数）；非折叠读取时为 1。toContractEvent 不透传。 */
  merged_count?: number
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

/** 平台后缀白名单（§5.9，D-b）：剥离"分隔符+平台名"；可配置常量便于扩充。 */
const PLATFORM_SUFFIXES: string[] = ['moomoo', '东方财富', '同花顺', '新浪财经', '财联社', '证券时报', 'e公司', '界面新闻']

/** title 归一化：trim + 去空白标点小写 + 白名单后缀剥离 + 尾部丨/| 片段剥离。
 * 写侧 dedupHash 与读侧折叠必须共用本函数（防两处口径漂移，§12 实施注意 14）。
 * 仅白名单剥离，禁止激进归一化（硬约束 10，防误并"业绩预告-上修"类有语义标题）。 */
export function normalizeTitle(title: string): string {
  let t = title.replace(/[\s\p{P}\p{S}_]+/gu, '').toLowerCase()
  // 剥离"分隔符 + 平台后缀"（_ 已在标点类，故分隔符归零后平台名紧贴主体）
  for (const suffix of PLATFORM_SUFFIXES) {
    if (t.endsWith(suffix)) {
      t = t.slice(0, -suffix.length)
      break
    }
  }
  // 剥离尾部 丨/| 片段（§5.9：出现位置在标题后半段）
  const sep = t.lastIndexOf('丨')
  if (sep > Math.floor(t.length / 2)) t = t.slice(0, sep)
  return t || title.replace(/[\s\p{P}\p{S}_]+/gu, '').toLowerCase() // 剥离后为空回退原值（防空键）
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
  // 读侧折叠（X4）：同 event_date + 归一标题相同 → 合并为一行；保留 importance 最高、result 非空者优先（同序则保首个）。
  // 只加折叠逻辑，不改 SQL 投影；与写侧共用 normalizeTitle 防口径漂移。
  const order = { high: 2, medium: 1, low: 0 } as const
  const byKey = new Map<string, CalendarEventRow & { merged_count: number }>()
  for (const row of result.rows) {
    const key = `${row.event_date}|${normalizeTitle(row.title)}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, { ...row, merged_count: 1 })
      continue
    }
    const curScore = (order[row.importance as keyof typeof order] ?? 0) + (row.result ? 1 : 0)
    const prevScore = (order[prev.importance as keyof typeof order] ?? 0) + (prev.result ? 1 : 0)
    if (curScore > prevScore) {
      byKey.set(key, { ...row, merged_count: prev.merged_count + 1 })
    } else {
      prev.merged_count += 1
    }
  }
  return [...byKey.values()]
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
    } catch (err) {
      // 交易日历未覆盖年份（§4.5 fail-close）：保留原日期，不抛 502
      console.warn('[Calendar] overnight mapping skipped (calendar uncovered):', err)
    }
  }
  return { date, type: typeFromSource(row), title: row.title, importance: row.importance, source: row.source, event_time: row.event_time, result: row.result }
}
