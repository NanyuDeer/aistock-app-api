import { Router, type Request, type Response } from 'express'
import pool from '../../core/db'
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService'
import { shanghaiDateStr, shanghaiDateTimeParts } from '../../shared/utils/shanghaiTime'
import { listEvents, toContractEvent } from './MarketCalendarEventService'
import { listDeliveryDates } from './CalendarRuleService'

export const rhythmMasterPublicRouter: Router = Router()

// refresh_slot 展示优先级（前端展示最新）
// 2026-09-19：三时点排序改为 created_at 倒序（手动补跑覆盖优先展示），
// 原 SLOT_PRIORITY 优先级（midday>morning>after_close）已不再用于本接口排序。

/** 每日收盘基准建议仓位（rhythm_card.position_band；行缺失/无仓位语义 = null，前端如实展示）。 */
export interface RhythmPositionBand {
    min?: number | null
    max?: number | null
    text?: string
}

/** 日历聚合行（契约 #7）：level 可空——行缺失/沿用前值 → null（前端灰格）。 */
export interface RhythmCalendarRow {
    report_date: string
    level: string | null
    score: string | null
    basis_date: string | null
    position_band: RhythmPositionBand | null
}

/** 日历聚合纯函数（design-debate R7 裁决）：把"最近 N 个交易日"与"after_close 行"
 *  合并为补位网格。行缺失日期 → level=null（灰格），有行透传 level/score/basis_date/position_band。
 *  恒取 after_close（三时点 level 恒等，删 slot 参数）。 */
export function mergeRhythmCalendarDays(
    dates: string[],
    rows: RhythmCalendarRow[],
): Array<{
    date: string
    refresh_slot: string
    level: string | null
    score: number | null
    basis_date: string | null
    position_band: RhythmPositionBand | null
}> {
    const byDate = new Map(rows.map((r) => [r.report_date, r]))
    return dates.map((d) => {
        const row = byDate.get(d)
        return {
            date: d,
            refresh_slot: 'after_close',
            level: row?.level ?? null,
            score: row?.score != null ? Number(row.score) : null,
            basis_date: row?.basis_date ?? null,
            position_band: row?.position_band ?? null,
        }
    })
}

/** 网格单日事件显示上限（裁决 C5：防 earnings 密集日刷屏，L3 恒 medium 无 low 缓冲）。 */
export const CALENDAR_GRID_PER_CELL_MAX = 3
const IMPORTANCE_ORDER = { high: 2, medium: 1, low: 0 } as const

/** 窗口内"日历可见"事件按日分组（对外契约：importance≥medium + 每格上限 3 + 溢出折叠；无则空数组）。
 *
 * 裁决 C5：由 type 白名单（{macro,delivery}）改为 importance≥medium 过滤 —— 让 earnings/seed
 * 进入网格（此前被丢弃），但剔除 low；单日超 CALENDAR_GRID_PER_CELL_MAX 折叠为 { overflow: N } 占位
 * （前端展开），防 earnings 密集日刷屏（L3 恒 medium 无 low 缓冲）。low 不进网格。
 */
export async function loadCalendarEventsByDate(
  dates: string[],
): Promise<Map<string, Array<Record<string, unknown>>>> {
  if (!dates.length) return new Map()
  const from = dates[dates.length - 1]
  const to = dates[0]
  const rows = await listEvents(from, to)
  const merged = [
    ...listDeliveryDates(from, to),
    ...rows.map((row) => toContractEvent(row)),
  ]
  const byDate = new Map<string, Array<Record<string, unknown>>>()
  for (const ev of merged) {
    // 裁决 C5：importance ≥ medium 过滤替代 type 白名单（low 不进网格）
    const importance = String(ev.importance ?? 'medium')
    if ((IMPORTANCE_ORDER[importance as keyof typeof IMPORTANCE_ORDER] ?? 1) < 1) continue
    const key = String(ev.date)
    const list = byDate.get(key) ?? []
    list.push(ev as unknown as Record<string, unknown>)
    byDate.set(key, list)
  }
  // 每格上限 + 溢出折叠（裁决 C5）：超限尾部折叠为 { overflow: N } 占位
  for (const [key, list] of byDate) {
    if (list.length <= CALENDAR_GRID_PER_CELL_MAX) continue
    byDate.set(key, [
      ...list.slice(0, CALENDAR_GRID_PER_CELL_MAX),
      { overflow: list.length - CALENDAR_GRID_PER_CELL_MAX },
    ])
  }
  return byDate
}

/** GET /api/agent/rhythm-master/calendar?naturalDays=N — 自然日网格（契约 #7 扩展）。
 *  N=自然日数量（含周末/节假日）；无 report 的日期 level=null（周末/无档如实展示）。
 *  事件仍按自然日 loadCalendarEventsByDate 关联（含 US 隔夜顺延后的反应日归属）。
 *  dates 必须为降序（新到老），与既有 days 分支方向一致（loadCalendarEventsByDate 的 from=dates[last]、to=dates[0]）。 */
rhythmMasterPublicRouter.get('/rhythm-master/calendar', async (req: Request, res: Response) => {
    const naturalDaysParam = Number(req.query.naturalDays ?? 0)
    const naturalDays = Number.isFinite(naturalDaysParam) ? Math.max(0, Math.floor(naturalDaysParam)) : 0
    if (naturalDays > 0) {
      // 自然日模式：生成最近 naturalDays 个自然日（含周末），降序（新到老）
      // 用上海时区分量构造日期（shanghaiDateTimeParts + Date.UTC），避免 toISOString()
      // 在 00:00–08:00 上海时间错位到前一天（UTC drift），保证 grid 与周末归属对齐。
      const dates: string[] = []
      const now = new Date()
      const today = shanghaiDateTimeParts(now)
      if (!today) return res.status(500).json({ code: 500, message: 'Invalid date' })
      for (let i = 0; i < naturalDays; i++) {
        const d = new Date(Date.UTC(today.year, today.month - 1, today.day - i))
        dates.push(shanghaiDateStr(d))
      }
      const result = await pool.query(
        `SELECT (report_date AT TIME ZONE 'Asia/Shanghai')::date::text AS report_date,
                content->'rhythm_card'->>'level' AS level,
                content->'rhythm_card'->>'score' AS score,
                content->>'basis_date' AS basis_date,
                content->'rhythm_card'->'position_band' AS position_band
         FROM agent_analysis_reports
         WHERE report_type = 'rhythm_master' AND user_id = 'after_close'
           AND (report_date AT TIME ZONE 'Asia/Shanghai')::date = ANY($1::date[])
         ORDER BY report_date DESC`,
        [dates],
      )
      const eventsByDate = await loadCalendarEventsByDate(dates)
      const merged = dates.map((d) => {
        const row = result.rows.find((r: any) => r.report_date === d)
        return {
          date: d,
          refresh_slot: 'after_close',
          level: row?.level ?? null,
          score: row?.score != null ? Number(row.score) : null,
          basis_date: row?.basis_date ?? null,
          position_band: row?.position_band ?? null,
          events: eventsByDate.get(d) ?? [],
        }
      })
      return res.json({ code: 0, data: { days: merged } })
    }
    const daysParam = Number(req.query.days ?? 60)
    const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(Math.floor(daysParam), 60) : 60
    try {
        const recent = TradingCalendarService.getRecentTradingDays(new Date(), days)
        const dates = recent.map((d) => d.toISOString().slice(0, 10))
        const result = await pool.query(
            `SELECT (report_date AT TIME ZONE 'Asia/Shanghai')::date::text AS report_date,
                    content->'rhythm_card'->>'level' AS level,
                    content->'rhythm_card'->>'score' AS score,
                    content->>'basis_date' AS basis_date,
                    content->'rhythm_card'->'position_band' AS position_band
             FROM agent_analysis_reports
             WHERE report_type = 'rhythm_master' AND user_id = 'after_close'
               AND (report_date AT TIME ZONE 'Asia/Shanghai')::date = ANY($1::date[])
             ORDER BY report_date DESC`,
            [dates],
        )
        const eventsByDate = await loadCalendarEventsByDate(dates)
        // 返回行时带上 events
        res.json({ code: 0, data: { days: mergeRhythmCalendarDays(dates, result.rows).map((d) => ({ ...d, events: eventsByDate.get(d.date) ?? [] })) } })
    } catch (err) {
        console.error('[Calendar] GET /rhythm-master/calendar error:', err)
        res.status(500).json({ code: 500, message: String(err) })
    }
})

/** GET /api/agent/rhythm-master/:date — 前端读三时点版本（契约 #4/#6）。 */
rhythmMasterPublicRouter.get('/rhythm-master/:date', async (req: Request, res: Response) => {
  const date = String(req.params.date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ code: 400, message: 'date 须为 YYYY-MM-DD' })
  }
  try {
    const result = await pool.query(
      `SELECT report_type, report_date, user_id, content, created_at
       FROM agent_analysis_reports
       WHERE report_type = 'rhythm_master' AND report_date = $1 AND user_id IN ('after_close','morning','midday')
       ORDER BY created_at DESC`,
      [date],
    )
    const versions = result.rows
      .map((r) => ({ refresh_slot: r.user_id as string, created_at: r.created_at as string, content: r.content as unknown }))
      // 2026-09-19：排序由 SLOT_PRIORITY（midday>morning>after_close）改为 created_at 倒序——
      // 手动补跑（target_date 覆盖）生成的新卡 created 最新，需优先展示；原"三时点优先级"
      // 在自动调度下与 created_at 倒序基本同序，测试契约兼容。
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    res.json({ code: 0, data: { date, versions } })
  } catch (err) {
    console.error('[Calendar] GET /rhythm-master error:', err)
    res.status(500).json({ code: 500, message: String(err) })
  }
})
