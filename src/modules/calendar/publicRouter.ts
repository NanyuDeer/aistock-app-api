import { Router, type Request, type Response } from 'express'
import pool from '../../core/db'
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService'

export const rhythmMasterPublicRouter: Router = Router()

// refresh_slot 展示优先级（前端展示最新）
const SLOT_PRIORITY: Record<string, number> = { midday: 2, morning: 1, after_close: 0 }

/** 日历聚合行（契约 #7）：level 可空——行缺失/沿用前值 → null（前端灰格）。 */
export interface RhythmCalendarRow {
    report_date: string
    level: string | null
    score: string | null
    basis_date: string | null
}

/** 日历聚合纯函数（design-debate R7 裁决）：把"最近 N 个交易日"与"after_close 行"
 *  合并为补位网格。行缺失日期 → level=null（灰格），有行透传 level/score/basis_date。
 *  恒取 after_close（三时点 level 恒等，删 slot 参数）。 */
export function mergeRhythmCalendarDays(
    dates: string[],
    rows: RhythmCalendarRow[],
): Array<{ date: string; refresh_slot: string; level: string | null; score: number | null; basis_date: string | null }> {
    const byDate = new Map(rows.map((r) => [r.report_date, r]))
    return dates.map((d) => {
        const row = byDate.get(d)
        return {
            date: d,
            refresh_slot: 'after_close',
            level: row?.level ?? null,
            score: row?.score != null ? Number(row.score) : null,
            basis_date: row?.basis_date ?? null,
        }
    })
}

/** GET /api/agent/rhythm-master/calendar?days=N — 节奏日历热力图聚合（契约 #7）。
 *  N=交易日数量（默认 60，上限 60）；服务端按交易日历展开日期序列，前端不依赖交易日历。
 *  SQL 级 JSONB 投影 level/score/basis_date，不整行读 content（防响应膨胀）。 */
rhythmMasterPublicRouter.get('/rhythm-master/calendar', async (req: Request, res: Response) => {
    const daysParam = Number(req.query.days ?? 60)
    const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(Math.floor(daysParam), 60) : 60
    try {
        const recent = TradingCalendarService.getRecentTradingDays(new Date(), days)
        const dates = recent.map((d) => d.toISOString().slice(0, 10))
        const result = await pool.query(
            `SELECT (report_date AT TIME ZONE 'Asia/Shanghai')::date::text AS report_date,
                    content->'rhythm_card'->>'level' AS level,
                    content->'rhythm_card'->>'score' AS score,
                    content->>'basis_date' AS basis_date
             FROM agent_analysis_reports
             WHERE report_type = 'rhythm_master' AND user_id = 'after_close'
               AND (report_date AT TIME ZONE 'Asia/Shanghai')::date = ANY($1::date[])
             ORDER BY report_date DESC`,
            [dates],
        )
        res.json({ code: 0, data: { days: mergeRhythmCalendarDays(dates, result.rows) } })
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
      .sort((a, b) => SLOT_PRIORITY[b.refresh_slot] - SLOT_PRIORITY[a.refresh_slot])
    res.json({ code: 0, data: { date, versions } })
  } catch (err) {
    console.error('[Calendar] GET /rhythm-master error:', err)
    res.status(500).json({ code: 500, message: String(err) })
  }
})
