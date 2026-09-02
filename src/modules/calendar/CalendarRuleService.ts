/** L1 规则日历层：期指交割日 = 每月第三个周五（纯计算，遇休市不顺延，spec §4.1）。 */
export interface CalendarEvent {
  date: string
  type: 'delivery' | 'earnings' | 'seed' | 'macro'
  title: string
  importance: 'high' | 'medium' | 'low'
  source: 'L1' | 'L2' | 'L3' | 'L4'
  event_time?: string | null
  result?: string | null
}

/** 每月第 n 个指定星期几（weekday: 0=Mon..6=Sun，默认 4=周五），UTC 日期。
 * 注意：语义为 0=Mon 而非 JS Date.getUTCDay() 的 0=Sun，保证契约默认值 weekday=4 即"周五"（期指交割日）。 */
export function nthWeekday(year: number, month: number, weekday = 4, n = 3): Date {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const jsWeekday = (weekday + 1) % 7 // 0=Mon..6=Sun → JS 0=Sun..6=Sat
  const diff = (jsWeekday - first.getUTCDay() + 7) % 7
  return new Date(Date.UTC(year, month - 1, 1 + diff + (n - 1) * 7))
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** 窗口内全部交割日（含边界），按日期升序。 */
export function listDeliveryDates(dateFrom: string, dateTo: string): CalendarEvent[] {
  const from = new Date(`${dateFrom}T00:00:00Z`)
  const to = new Date(`${dateTo}T00:00:00Z`)
  const events: CalendarEvent[] = []
  const y0 = from.getUTCFullYear()
  const m0 = from.getUTCMonth() + 1
  const y1 = to.getUTCFullYear()
  const m1 = to.getUTCMonth() + 1
  for (let y = y0; y <= y1; y++) {
    for (let m = y === y0 ? m0 : 1; m <= (y === y1 ? m1 : 12); m++) {
      const d = nthWeekday(y, m, 4, 3)
      const iso = toISODate(d)
      if (iso >= dateFrom && iso <= dateTo) {
        events.push({ date: iso, type: 'delivery', title: `${y}-${String(m).padStart(2, '0')} 股指期货交割日`, importance: 'medium', source: 'L1' })
      }
    }
  }
  return events
}
