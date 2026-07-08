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
import { WindLeaderService } from '../../modules/monitor/WindLeaderService'
import { StockMonitorService } from '../../modules/monitor/service'
import { TenxScoreService } from '../../modules/monitor/TenxScoreService'
import { IndustryKGService } from '../../modules/monitor/IndustryKGService'
import { HotBurstService } from '../../modules/monitor/HotBurstService'
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

/** Express 5 query 参数安全提取为 string（string | string[] | undefined → string | undefined） */
function queryStr(req: Request, key: string): string | undefined {
    const raw = req.query[key]
    const val = Array.isArray(raw) ? raw[0] : raw
    return typeof val === 'string' ? val : undefined
}

/** Express 5 query 参数安全提取为 int（带默认值） */
function queryInt(req: Request, key: string, defaultValue: number): number {
    const str = queryStr(req, key)
    if (!str) return defaultValue
    const num = parseInt(str)
    return isNaN(num) ? defaultValue : num
}

/** 从 unknown 错误中安全提取 message */
function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
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

// ==================== Phase 5: 新增 /internal/* 接口（供 Python Agent 调用） ====================
// 以下 9 个路由对接 monitor 模块现有 Service，全部走 verifyInternalToken 鉴权。
// Service 失败时返回 502 + 错误信息（区别于现有接口的 500）。
// 注意路由注册顺序：静态路径必须在参数化路径之前，避免 :param 匹配到静态词。

/**
 * GET /internal/wind-leaders
 * 风口龙头分析数据（热门板块 + 龙头股）
 */
router.get('/wind-leaders', async (req: Request, res: Response) => {
    const limit = Math.min(queryInt(req, 'limit', 8), 50)
    try {
        const data = await WindLeaderService.getWindLeaders(limit)
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error('[Internal] wind-leaders error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/monitor/alerts
 * 全局告警历史（研判资讯事件，分页查询）
 *
 * 注意：必须注册在 /monitor/:symbol 之前，否则 "alerts" 会被 :symbol 匹配
 */
router.get('/monitor/alerts', async (req: Request, res: Response) => {
    try {
        const data = await StockMonitorService.getAlertHistory({
            cycle: queryStr(req, 'cycle'),
            change_type: queryStr(req, 'change_type'),
            limit: queryInt(req, 'limit', 20),
            offset: queryInt(req, 'offset', 0),
        })
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error('[Internal] monitor/alerts error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/monitor/:symbol
 * 个股监控数据（该股票的研判资讯事件列表）
 */
router.get('/monitor/:symbol', async (req: Request, res: Response) => {
    const symbol = param(req, 'symbol')
    if (!isValidAShareSymbol(symbol)) {
        return res.status(400).json({ code: 400, message: 'Invalid symbol — A股代码必须是6位数字' })
    }
    try {
        const data = await StockMonitorService.getMonitorData(symbol)
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error(`[Internal] monitor/${symbol} error:`, errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/tenx/score/:symbol
 * 个股十倍股评分（6维度18指标百分制评分体系）
 */
router.get('/tenx/score/:symbol', async (req: Request, res: Response) => {
    const symbol = param(req, 'symbol')
    if (!isValidAShareSymbol(symbol)) {
        return res.status(400).json({ code: 400, message: 'Invalid symbol — A股代码必须是6位数字' })
    }
    try {
        const data = await TenxScoreService.getScore(symbol)
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error(`[Internal] tenx/score/${symbol} error:`, errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/tenx/top
 * 十倍股评分 Top 列表（当前为 stub，返回固定占位数据）
 */
router.get('/tenx/top', async (req: Request, res: Response) => {
    try {
        const data = await TenxScoreService.getTopStocks({
            limit: queryInt(req, 'limit', 10),
        })
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error('[Internal] tenx/top error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/graph/concepts
 * 行业知识图谱 — 所有概念列表
 *
 * 注意：必须注册在 /graph/:concept 之前，否则 "concepts" 会被 :concept 匹配
 */
router.get('/graph/concepts', async (req: Request, res: Response) => {
    try {
        const data = await IndustryKGService.getConcepts()
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error('[Internal] graph/concepts error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/graph/:concept
 * 行业知识图谱 — 根据概念获取产业链子图（接受概念 ID 或名称）
 */
router.get('/graph/:concept', async (req: Request, res: Response) => {
    const concept = param(req, 'concept')
    if (!concept) {
        return res.status(400).json({ code: 400, message: 'Concept is required' })
    }
    try {
        const data = await IndustryKGService.getGraphByConcept(concept)
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error(`[Internal] graph/${concept} error:`, errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/institution-research/history
 * 机构调研推荐热门股历史记录（从数据库查询，分页）
 *
 * 注意：注册在 /institution-research 之前，避免路径歧义
 */
router.get('/institution-research/history', async (req: Request, res: Response) => {
    try {
        const data = await HotBurstService.getHotBurstHistory({
            limit: queryInt(req, 'limit', 50),
            offset: queryInt(req, 'offset', 0),
            minResonanceOnly: queryStr(req, 'min_resonance_only') !== 'false',
        })
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error('[Internal] institution-research/history error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/institution-research
 * 机构调研推荐热门股检测结果（四信号源共振模型）
 */
router.get('/institution-research', async (req: Request, res: Response) => {
    try {
        const data = await HotBurstService.getHotBurst({
            hours: queryInt(req, 'hours', 6),
            minResonanceCount: queryInt(req, 'min_resonance_count', 0),
        })
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error('[Internal] institution-research error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

export default router
