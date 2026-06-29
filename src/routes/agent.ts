/**
 * Agent 路由 - 处理 AI 对话相关请求
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { handleMessage } from '../agent/orchestrator'

const router = Router()

/**
 * POST /api/agent/chat/message
 * 发送对话消息（非流式）
 */
router.post('/chat/message', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { message, session_id, context } = req.body || {}

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ code: 400, message: '参数 message 必填且为字符串' })
    }

    const result = await handleMessage(message, {
      sessionId: session_id || `session_${Date.now()}`,
      userId: (req as any).userId,
      ...context
    })

    res.json({
      code: 200,
      data: result
    })
  } catch (err: any) {
    console.error('[AgentRoute] chat/message error:', err)
    res.status(500).json({ code: 500, message: err.message || 'Internal Server Error' })
  }
})

/**
 * GET /api/agent/skills
 * 获取所有已注册的 Skills 列表
 */
router.get('/skills', async (_req: Request, res: Response) => {
  try {
    const { getAllSkills } = await import('../agent/skills/registry')
    const skills = getAllSkills().map(s => ({
      name: s.name,
      description: s.description
    }))
    res.json({ code: 200, data: skills })
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message })
  }
})

/**
 * GET /api/agent/briefing/morning
 * 获取今日晨报
 */
router.get('/briefing/morning', async (_req: Request, res: Response) => {
  // TODO: 实现晨间决策官 Agent
  res.json({
    code: 200,
    data: {
      date: new Date().toISOString().slice(0, 10),
      title: '今日早点听（开发中）',
      segments: [],
      events: [],
      sectors: []
    }
  })
})

/**
 * GET /api/agent/briefing/evening
 * 获取今日晚报
 */
router.get('/briefing/evening', async (_req: Request, res: Response) => {
  // TODO: 实现晚报生成
  res.json({
    code: 200,
    data: {
      date: new Date().toISOString().slice(0, 10),
      title: '今日晚报（开发中）',
      segments: [],
      events: [],
      sectors: []
    }
  })
})

/**
 * GET /api/agent/valuation/:symbol
 * 获取动态估值
 */
router.get('/valuation/:symbol', async (req: Request, res: Response) => {
  // TODO: 实现动态估值 Skill
  res.json({
    code: 200,
    data: {
      symbol: req.params.symbol,
      level: '合理',
      score: 50,
      dimensions: {},
      narrative: '估值功能开发中'
    }
  })
})

/**
 * GET /api/agent/event/list
 * 获取事件列表
 */
router.get('/event/list', async (_req: Request, res: Response) => {
  // TODO: 实现事件列表查询
  res.json({ code: 200, data: [] })
})

/**
 * GET /api/agent/event/chain/:id
 * 获取事件传导链
 */
router.get('/event/chain/:id', async (req: Request, res: Response) => {
  // TODO: 实现事件传导链
  res.json({
    code: 200,
    data: {
      id: req.params.id,
      chain: [],
      narrative: '事件传导链功能开发中'
    }
  })
})

/**
 * GET /api/agent/alert/list
 * 获取提醒列表
 */
router.get('/alert/list', async (_req: Request, res: Response) => {
  // TODO: 实现异动提醒列表
  res.json({ code: 200, data: [] })
})

/**
 * POST /api/agent/alert/subscribe
 * 订阅异动提醒
 */
router.post('/alert/subscribe', async (req: Request, res: Response) => {
  const { symbols } = req.body || {}
  // TODO: 实现订阅逻辑
  res.json({ code: 200, data: { subscribed: symbols || [] } })
})

/**
 * POST /api/agent/push/token
 * 注册推送 Token（App 端调用）
 */
router.post('/push/token', async (req: Request, res: Response) => {
  const { token, provider } = req.body || {}
  // TODO: 存储推送 Token 到数据库
  console.log(`[PushToken] provider=${provider}, token=${token?.slice(0, 20)}...`)
  res.json({ code: 200, data: { registered: true } })
})

export default router
