/**
 * Internal API 路由 — 仅供 Python Agent 服务内部调用
 *
 * 除 /health 外，所有接口需要携带 X-Internal-Token header 进行鉴权。
 * /internal/health 是例外：注册在鉴权中间件之前，无需 token，
 * 作为轻量健康探针供 Python /health/ready 探测 Node.js 连通性。
 * 这些接口不对外暴露，Python 服务通过此接口获取 A 股数据。
 */
import { Router, type Request, type Response } from 'express'
import { TencentQuoteService } from '../../modules/quote/TencentQuoteService'
import { getSinaMoneyflow } from '../../modules/quote/SinaMoneyFlowService'
import { getCapitalFlow } from '../../modules/quote/TushareCapitalFlowService'
import { TushareTagLeaderService } from '../../modules/quote/TushareTagLeaderService'
import { ClsStockNewsService } from '../../modules/monitor/ClsStockNewsService'
import { ThsService } from '../../modules/monitor/ThsService'
import { isValidAShareSymbol } from '../../shared/utils/validator'
import { isValidTagCode } from '../../shared/utils/validator'

const router: Router = Router()

// 内网鉴权中间件
// 优先 INTERNAL_API_TOKEN（Python agent-py 用的变量名），兼容 INTERNAL_TOKEN（其他模块旧约定）
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production'

function verifyInternalToken(req: Request, res: Response, next: Function): void {
    const token = req.headers['x-internal-token']
    if (token !== INTERNAL_TOKEN) {
        res.status(403).json({ code: 403, message: 'Forbidden — invalid internal token' })
        return
    }
    next()
}

/** Express 5 params 类型安全提取（string | string[] → string） */
function param(req: Request, key: string): string {
    const val = req.params[key]
    return Array.isArray(val) ? val[0] : (val || '')
}

/**
 * GET /internal/health
 * 轻量健康探针，供 Python Agent 服务 /health/ready 探测 Node.js 连通性。
 *
 * 刻意注册在 verifyInternalToken 中间件之前：健康检查不应被鉴权阻断
 * （Python 探针不携带 X-Internal-Token，避免探针因 token 配置漂移而误判）。
 * 仅返回进程存活状态，不触达数据库/Redis，保持低延迟。
 */
router.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' })
})

router.use(verifyInternalToken)

/**
 * GET /internal/quote/:symbol
 * 个股实时行情（腾讯数据源）
 */
router.get('/quote/:symbol', async (req: Request, res: Response) => {
    const symbol = param(req, 'symbol')
    if (!isValidAShareSymbol(symbol)) {
        return res.status(400).json({ code: 400, message: 'Invalid symbol — A股代码必须是6位数字' })
    }

    try {
        const data = await TencentQuoteService.getQuote(symbol)
        res.json({ code: 200, data })
    } catch (err: any) {
        console.error(`[Internal] quote/${symbol} error:`, err.message)
        res.status(500).json({ code: 500, message: err.message })
    }
})

/**
 * GET /internal/flow/:symbol
 * 个股资金流向（新浪 + Tushare 双源）
 */
router.get('/flow/:symbol', async (req: Request, res: Response) => {
    const symbol = param(req, 'symbol')
    if (!isValidAShareSymbol(symbol)) {
        return res.status(400).json({ code: 400, message: 'Invalid symbol — A股代码必须是6位数字' })
    }

    try {
        // 优先使用新浪资金流，备选 Tushare
        let data: Record<string, any> | null = await getSinaMoneyflow(symbol)
        if (!data) {
            data = await getCapitalFlow(symbol) as unknown as Record<string, any>
        }
        res.json({ code: 200, data })
    } catch (err: any) {
        console.error(`[Internal] flow/${symbol} error:`, err.message)
        res.status(500).json({ code: 500, message: err.message })
    }
})

/**
 * GET /internal/leader/:tagCode
 * 板块龙头股（Tushare 数据源）
 */
router.get('/leader/:tagCode', async (req: Request, res: Response) => {
    const tagCode = param(req, 'tagCode').toUpperCase()
    if (!isValidTagCode(tagCode)) {
        return res.status(400).json({ code: 400, message: 'Invalid tagCode — 必须是 BK+数字，例如 BK0475' })
    }

    const count = Math.min(parseInt(req.query.count as string) || 10, 50)

    try {
        const leaders = await TushareTagLeaderService.getTagLeaders(tagCode, count)
        res.json({ code: 200, data: { tag_code: tagCode, leaders } })
    } catch (err: any) {
        console.error(`[Internal] leader/${tagCode} error:`, err.message)
        res.status(500).json({ code: 500, message: err.message })
    }
})

/**
 * GET /internal/news/search/:symbol
 * 财联社个股相关新闻
 */
router.get('/news/search/:symbol', async (req: Request, res: Response) => {
    const symbol = param(req, 'symbol')
    if (!isValidAShareSymbol(symbol)) {
        return res.status(400).json({ code: 400, message: 'Invalid symbol — A股代码必须是6位数字' })
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50)

    try {
        const data = await ClsStockNewsService.getStockNews(symbol, { limit, lastTime: 0 })
        res.json({ code: 200, data })
    } catch (err: any) {
        console.error(`[Internal] news/search/${symbol} error:`, err.message)
        res.status(500).json({ code: 500, message: err.message })
    }
})

/**
 * GET /internal/news/latest
 * 财联社最新快讯（晨报用，不带股票关键词）
 */
router.get('/news/latest', async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50)

    try {
        const data = await ClsStockNewsService.getLatestNews(limit)
        res.json({ code: 200, data })
    } catch (err: any) {
        console.error('[Internal] news/latest error:', err.message)
        res.status(500).json({ code: 500, message: err.message })
    }
})

/**
 * GET /internal/news/fulltext/:id
 * 财联社新闻全文
 */
router.get('/news/fulltext/:id', async (req: Request, res: Response) => {
    const newsId = param(req, 'id')
    if (!newsId || !/^\d+$/.test(newsId)) {
        return res.status(400).json({ code: 400, message: 'Invalid news ID — 必须是数字' })
    }

    try {
        const data = await ClsStockNewsService.getNewsFulltext(newsId)
        if (!data) {
            return res.status(404).json({ code: 404, message: 'News not found' })
        }
        res.json({ code: 200, data })
    } catch (err: any) {
        console.error(`[Internal] news/fulltext/${newsId} error:`, err.message)
        res.status(500).json({ code: 500, message: err.message })
    }
})

/**
 * GET /internal/forecast/:symbol
 * 机构盈利预测（同花顺数据源）
 */
router.get('/forecast/:symbol', async (req: Request, res: Response) => {
    const symbol = param(req, 'symbol')
    if (!isValidAShareSymbol(symbol)) {
        return res.status(400).json({ code: 400, message: 'Invalid symbol — A股代码必须是6位数字' })
    }

    try {
        const data = await ThsService.getProfitForecast(symbol)
        res.json({ code: 200, data })
    } catch (err: any) {
        console.error(`[Internal] forecast/${symbol} error:`, err.message)
        res.status(500).json({ code: 500, message: err.message })
    }
})

export default router
