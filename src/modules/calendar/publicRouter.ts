import { Router, type Request, type Response } from 'express'
import pool from '../../core/db'

export const rhythmMasterPublicRouter: Router = Router()

// refresh_slot 展示优先级（前端展示最新）
const SLOT_PRIORITY: Record<string, number> = { midday: 2, morning: 1, after_close: 0 }

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
