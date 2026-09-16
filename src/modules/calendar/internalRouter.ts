import { Router, type Request, type Response } from 'express'
import { listDeliveryDates } from './CalendarRuleService'
import { listEvents, upsertEvent, toContractEvent } from './MarketCalendarEventService'

export const calendarInternalRouter: Router = Router()

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// token 请求时动态求值（优先级表达式对齐 prediction/internalRouter.ts 先例）：
// 模块加载期常量会被 core/db 的 dotenv 抢先固化，测试 before() 设置的 token 无法生效，
// 因此改为每次请求读取，保证 INTERNAL_API_TOKEN/INTERNAL_TOKEN 变更即时生效。
function currentInternalToken(): string {
  return process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production'
}

// 独立鉴权（对齐 modules/prediction/internalRouter.ts 先例）
calendarInternalRouter.use((req: Request, res: Response, next) => {
  if (req.headers['x-internal-token'] !== currentInternalToken()) {
    return res.status(403).json({ code: 403, message: 'Forbidden — invalid internal token' })
  }
  next()
})

calendarInternalRouter.get('/events', async (req: Request, res: Response) => {
  try {
    const dateFrom = String(req.query.dateFrom ?? '')
    const dateTo = String(req.query.dateTo ?? '')
    if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) {
      return res.status(400).json({ code: 400, message: 'dateFrom/dateTo 必填且须为 YYYY-MM-DD' })
    }
    const delivery = listDeliveryDates(dateFrom, dateTo)
    const rows = await listEvents(dateFrom, dateTo)
    const events = [...delivery, ...rows.map(toContractEvent)].sort((a, b) => String(a.date).localeCompare(String(b.date)))
    // 信封 code 对齐 internal.ts 成功约定（200）；agent-py _request 仅接受 code==200，0 会恒降级（C1）
    res.json({ code: 200, data: { events } })
  } catch (err) {
    console.error('[Calendar] GET /events error:', err)
    res.status(502).json({ code: 502, message: String(err) })
  }
})

calendarInternalRouter.post('/events', async (req: Request, res: Response) => {
  try {
    const { event_date, title, importance, market, event_time, source, detail, result } = (req.body ?? {}) as Record<string, unknown>
    if (typeof event_date !== 'string' || !DATE_RE.test(event_date) || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ code: 400, message: 'event_date(YYYY-MM-DD) 与 title 必填' })
    }
    if (importance !== undefined && !['high', 'medium', 'low'].includes(String(importance))) {
      return res.status(400).json({ code: 400, message: 'importance 须为 high/medium/low' })
    }
    if (market !== undefined && !['CN', 'US_OVERNIGHT'].includes(String(market))) {
      return res.status(400).json({ code: 400, message: 'market 须为 CN/US_OVERNIGHT' })
    }
    const src = source === undefined ? 'L3' : String(source)
    if (!['L1', 'L2', 'L3', 'L4'].includes(src)) {
      return res.status(400).json({ code: 400, message: 'source 须为 L1/L2/L3/L4' })
    }
    const row = await upsertEvent({
      event_date,
      title,
      importance: importance === undefined ? undefined : (importance as 'high' | 'medium' | 'low'),
      market: market === undefined ? undefined : (market as 'CN' | 'US_OVERNIGHT'),
      event_time: event_time === undefined ? null : String(event_time),
      source: src as 'L1' | 'L2' | 'L3' | 'L4',
      detail: detail === undefined ? null : String(detail),
      result: result === undefined ? null : String(result),
    })
    res.json({ code: 0, data: { id: row.id, upserted: row.upserted } })
  } catch (err) {
    console.error('[Calendar] POST /events error:', err)
    res.status(502).json({ code: 502, message: String(err) })
  }
})

/** 存量披露密度（§4.2）：performance_reports 按 ann_date 聚合，供节奏引擎作"披露高峰"辅助信号。 */
calendarInternalRouter.get('/earnings-density', async (req: Request, res: Response) => {
  try {
    const dateFrom = String(req.query.dateFrom ?? '')
    const dateTo = String(req.query.dateTo ?? '')
    if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) {
      return res.status(400).json({ code: 400, message: 'dateFrom/dateTo 必填且须为 YYYY-MM-DD' })
    }
    const result = await (await import('../../core/db')).default.query<{ ann_date: string; count: string }>(
      `SELECT to_char(ann_date, 'YYYY-MM-DD') AS ann_date, COUNT(*)::text AS count
       FROM performance_reports WHERE ann_date BETWEEN $1 AND $2 GROUP BY ann_date ORDER BY ann_date ASC`,
      [dateFrom, dateTo],
    )
    res.json({ code: 200, data: { density: result.rows.map((r) => ({ date: r.ann_date, count: Number(r.count) })) } })
  } catch (err) {
    console.error('[Calendar] GET /earnings-density error:', err)
    res.status(502).json({ code: 502, message: String(err) })
  }
})
