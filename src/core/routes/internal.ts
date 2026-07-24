/**
 * Internal API 路由 — 仅供 Python Agent 服务内部调用
 *
 * 除 /health 外，所有接口需要携带 X-Internal-Token header 进行鉴权。
 * /internal/health 是例外：注册在鉴权中间件之前，无需 token，
 * 作为轻量健康探针供 Python /health/ready 探测 Node.js 连通性。
 * 这些接口不对外暴露，Python 服务通过此接口获取 A 股数据。
 */
import { json, Router, type Request, type Response } from 'express'
import pool from '../db'
import { TencentQuoteService } from '../../modules/quote/TencentQuoteService'
import { getSinaMoneyflow } from '../../modules/quote/SinaMoneyFlowService'
import { getCapitalFlow } from '../../modules/quote/TushareCapitalFlowService'
import { TushareTagLeaderService } from '../../modules/quote/TushareTagLeaderService'
import { ClsStockNewsService } from '../../modules/monitor/ClsStockNewsService'
import { ThsService } from '../../modules/monitor/ThsService'
import { WindLeaderService } from '../../modules/monitor/WindLeaderService'
import { StockMonitorService } from '../../modules/monitor/service'
import { TrendScoreService } from '../../modules/monitor/TrendScoreService'
import { IndustryKGService } from '../../modules/monitor/IndustryKGService'
import { HotBurstService } from '../../modules/monitor/HotBurstService'
import { isValidAShareSymbol } from '../../shared/utils/validator'
import { isValidTagCode } from '../../shared/utils/validator'
// MarketSnapshotService 通过 namespace 导入：路由调用 MarketSnapshotService.getTodayCloseSnapshot()，
// 与 brief 中 verbatim 路由代码一致；MarketSnapshotUnavailableError 用 instanceof 判别 409 分支。
import * as MarketSnapshotService from '../../modules/quote/MarketSnapshotService'
import { MarketSnapshotUnavailableError } from '../../modules/quote/MarketSnapshotService'

// Agent 报告类型枚举
const VALID_REPORT_TYPES = ['morning', 'wind_leader', 'stock', 'alert', 'hot_burst', 'review', 'iterate', 'broadcast', 'event_conduction', 'trend_score']
const INDUSTRY_CHAIN_SOURCE = 'IndustryKGService'

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
 * GET /internal/trend/score/:symbol
 * 个股趋势股评分（4维度百分制评分体系：技术面35%+赛道25%+消息20%+基本面20%）
 */
router.get('/trend/score/:symbol', async (req: Request, res: Response) => {
    const symbol = param(req, 'symbol')
    if (!isValidAShareSymbol(symbol)) {
        return res.status(400).json({ code: 400, message: 'Invalid symbol — A股代码必须是6位数字' })
    }
    try {
        const data = await TrendScoreService.calculateTrendScore(symbol)
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error(`[Internal] trend/score/${symbol} error:`, errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/trend/score/:symbol/detail
 * 个股趋势股评分展开详情（含K线、概念板块K线、新闻、政策趋势等）
 */
router.get('/trend/score/:symbol/detail', async (req: Request, res: Response) => {
    const symbol = param(req, 'symbol')
    if (!isValidAShareSymbol(symbol)) {
        return res.status(400).json({ code: 400, message: 'Invalid symbol — A股代码必须是6位数字' })
    }
    try {
        const data = await TrendScoreService.calculateTrendScore(symbol)
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error(`[Internal] trend/score/${symbol}/detail error:`, errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/trend/top
 * 趋势股评分 Top 列表（按总分降序，排除D级）
 */
router.get('/trend/top', async (req: Request, res: Response) => {
    try {
        const limit = queryInt(req, 'limit', 30)
        const result = await pool.query(`
            SELECT t.symbol, t.score, t.label, t.expected_multiple, t.score_date,
                   t.dim_scores, t.description,
                   COALESCE(s.name, '') as name,
                   COALESCE(s.industry, '') as industry
            FROM trend_scores t
            LEFT JOIN stocks s ON t.symbol = s.symbol
            WHERE t.score_date = (SELECT MAX(t2.score_date) FROM trend_scores t2)
            AND t.label NOT IN ('D')
            AND (t.ma60_excluded IS NULL OR t.ma60_excluded = false)
            ORDER BY t.score DESC
            LIMIT $1
        `, [Math.min(50, Math.max(1, limit))])

        const items = result.rows.map((r: Record<string, unknown>) => ({
            symbol: r.symbol,
            name: r.name,
            industry: r.industry,
            score: Number(r.score),
            label: r.label,
            expectedMultiple: r.expected_multiple,
            scoreDate: r.score_date,
            dimScores: JSON.parse(r.dim_scores as string || '[]'),
            description: r.description,
        }))

        res.json({ code: 200, data: items })
    } catch (err: unknown) {
        console.error('[Internal] trend/top error:', errMsg(err))
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
 * GET /internal/industry/:name/chain
 * 行业知识图谱 — 查询行业上下游产业链
 *
 * 用途：为事件传导 Agent 提供真实产业链关系
 *
 * 参数：
 * - name: 行业名称（URL 参数）
 * - depth: 深度（query 参数，默认 1）
 *
 * 返回：
 * - industry: { id, name } 中心行业信息
 * - upstream: 上游行业列表（含 id, name, leadingStocks）
 * - downstream: 下游行业列表（含 id, name, leadingStocks）
 * - graphVersion: 图谱版本（当前系统无版本字段，返回 null）
 * - updatedAt: 图谱更新时间
 *
 * 注意：
 * - upstream 和 downstream 分别独立扩展 depth 层
 * - 返回扁平列表，不包含层级字段
 * - Agent 负责结合事件内容生成 direction、impactStrength、reason
 *
 * 错误处理：
 * - 行业不存在：返回 HTTP 404
 * - 服务异常：返回 HTTP 502
 */
router.get('/industry/:name/chain', async (req: Request, res: Response) => {
    const name = param(req, 'name')
    if (!name) {
        return res.status(400).json({ code: 400, message: 'Industry name is required' })
    }

    const depth = queryInt(req, 'depth', 1)

    try {
        // 1. 获取完整图谱数据
        const graph = IndustryKGService.getFullGraph()

        // 2. 查找中心行业
        const industry = graph.industries.find(i => i.name === name)

        // 3. 检查行业是否存在
        if (!industry) {
            return res.status(404).json({
                code: 404,
                message: `Industry not found: ${name}`
            })
        }

        // 4. 获取上下游关系
        const { upstream, downstream } = IndustryKGService.getUpstreamDownstream(industry.id, depth)

        // 5. 返回完整结构
        res.json({
            code: 200,
            data: {
                industry: {
                    id: industry.id,
                    name: industry.name,
                },
                upstream,
                downstream,
                graphVersion: null,  // 当前系统无版本字段
                updatedAt: graph.updateTime,
                source: INDUSTRY_CHAIN_SOURCE,
            },
        })
    } catch (err: unknown) {
        console.error(`[Internal] industry/${name}/chain error:`, errMsg(err))
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
            days: queryInt(req, 'days', 30),
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
            limit: queryInt(req, 'limit', 20),
        })
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error('[Internal] institution-research error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/market/close-snapshot
 * 当日 A 股大盘收盘事实快照（供 Python Agent 拉取当日收盘事实）
 *
 * - 200：data 为完整 CloseMarketSnapshot（status: 'complete'）
 * - 409：服务未就绪，data 含 status 与 reason：
 *   - status='not_ready' + reason='market_not_closed'：未收盘 / 非交易日 / 指数数据延迟
 *   - status='incomplete' + reason='incomplete_daily_coverage'：已收盘但 daily 覆盖残缺
 * - 502：其它意外异常（沿用既有 502 约定）
 */
router.get('/market/close-snapshot', async (_req: Request, res: Response) => {
    try {
        const data = await MarketSnapshotService.getTodayCloseSnapshot()
        res.json({ code: 200, data })
    } catch (err: unknown) {
        if (err instanceof MarketSnapshotUnavailableError) {
            res.status(409).json({
                code: 409,
                data: { status: err.status, reason: err.reason },
            })
            return
        }
        console.error('[Internal] market/close-snapshot error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

// ==================== Agent 分析报告持久化接口 ====================

/**
 * POST /internal/analysis-reports
 * 持久化 Agent 分析报告（upsert：存在则更新，不存在则插入）
 *
 * 请求体: { report_type, report_date, user_id?, content, data_source?, status?, generation_time_ms?, model_version?, error_message? }
 */
router.post('/analysis-reports', async (req: Request, res: Response) => {
    const { report_type, report_date, content } = req.body
    let user_id = req.body.user_id ?? null  // 公共报告 user_id 为 null
    const data_source = req.body.data_source ?? null
    const status = req.body.status ?? 'completed'
    const generation_time_ms = req.body.generation_time_ms ?? null
    const model_version = req.body.model_version ?? null
    const error_message = req.body.error_message ?? null

    // 参数校验
    if (!VALID_REPORT_TYPES.includes(report_type)) {
        return res.status(400).json({ code: 400, message: `Invalid report_type: ${report_type}` })
    }
    // event_conduction：必填 event_id，复用 user_id 列做隔离键
    // 同一 report_date 下：相同 event_id → upsert 更新；不同 event_id → 分别保存
    if (report_type === 'event_conduction') {
        const event_id = req.body.event_id
        if (!event_id || typeof event_id !== 'string') {
            return res.status(400).json({ code: 400, message: 'event_id is required for event_conduction report_type' })
        }
        user_id = event_id
    }
    if (!report_date || !/^\d{4}-\d{2}-\d{2}$/.test(report_date)) {
        return res.status(400).json({ code: 400, message: `Invalid report_date format: ${report_date}` })
    }
    if (content === undefined || content === null) {
        return res.status(400).json({ code: 400, message: 'content is required' })
    }

    try {
        // upsert：COALESCE 处理 NULL user_id（公共报告）
        const result = await pool.query(
            `INSERT INTO agent_analysis_reports
                (report_type, report_date, user_id, content, data_source, status,
                 generation_time_ms, model_version, error_message)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (report_type, report_date, COALESCE(user_id, ''))
             DO UPDATE SET
                content = EXCLUDED.content,
                data_source = EXCLUDED.data_source,
                status = EXCLUDED.status,
                generation_time_ms = EXCLUDED.generation_time_ms,
                model_version = EXCLUDED.model_version,
                error_message = EXCLUDED.error_message,
                expires_at = NOW() + INTERVAL '7 days',
                created_at = NOW()
             RETURNING id, report_type, report_date, created_at`,
            [report_type, report_date, user_id, JSON.stringify(content),
             data_source, status, generation_time_ms, model_version, error_message]
        )

        res.status(201).json({
            code: 201,
            data: result.rows[0],
        })
    } catch (err: unknown) {
        console.error('[Internal] analysis-reports POST error:', errMsg(err))
        res.status(500).json({ code: 500, message: errMsg(err) })
    }
})

/**
 * GET /internal/analysis-reports/:type/:date
 * 查询公共报告（user_id 为 NULL）
 *
 * 示例: GET /internal/analysis-reports/morning/2026-07-10
 */
router.get('/analysis-reports/:type/:date', async (req: Request, res: Response) => {
    const report_type = param(req, 'type')
    const report_date = param(req, 'date')

    if (!VALID_REPORT_TYPES.includes(report_type)) {
        return res.status(400).json({ code: 400, message: `Invalid report_type: ${report_type}` })
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(report_date)) {
        return res.status(400).json({ code: 400, message: `Invalid report_date format: ${report_date}` })
    }

    try {
        const result = await pool.query(
            `SELECT id, report_type, report_date, content, data_source, status,
                    generation_time_ms, model_version, created_at
             FROM agent_analysis_reports
             WHERE report_type = $1 AND report_date = $2 AND user_id IS NULL
             LIMIT 1`,
            [report_type, report_date]
        )

        if (result.rows.length === 0) {
            return res.status(404).json({ code: 404, message: 'Report not found' })
        }

        res.json({ code: 200, data: result.rows[0] })
    } catch (err: unknown) {
        console.error('[Internal] analysis-reports GET error:', errMsg(err))
        res.status(500).json({ code: 500, message: errMsg(err) })
    }
})

/**
 * GET /internal/analysis-reports/:type/:date/:userId
 * 查询个性化报告（按用户ID）
 *
 * 示例: GET /internal/analysis-reports/stock/2026-07-10/user_123
 */
router.get('/analysis-reports/:type/:date/:userId', async (req: Request, res: Response) => {
    const report_type = param(req, 'type')
    const report_date = param(req, 'date')
    const user_id = param(req, 'userId')

    if (!VALID_REPORT_TYPES.includes(report_type)) {
        return res.status(400).json({ code: 400, message: `Invalid report_type: ${report_type}` })
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(report_date)) {
        return res.status(400).json({ code: 400, message: `Invalid report_date format: ${report_date}` })
    }
    if (!user_id) {
        return res.status(400).json({ code: 400, message: 'userId is required' })
    }

    try {
        const result = await pool.query(
            `SELECT id, report_type, report_date, content, data_source, status,
                    generation_time_ms, model_version, created_at
             FROM agent_analysis_reports
             WHERE report_type = $1 AND report_date = $2 AND user_id = $3
             LIMIT 1`,
            [report_type, report_date, user_id]
        )

        if (result.rows.length === 0) {
            return res.status(404).json({ code: 404, message: 'Report not found' })
        }

        res.json({ code: 200, data: result.rows[0] })
    } catch (err: unknown) {
        console.error('[Internal] analysis-reports GET (user) error:', errMsg(err))
        res.status(500).json({ code: 500, message: errMsg(err) })
    }
})

/**
 * DELETE /internal/analysis-reports/cleanup
 * 清理过期报告（expires_at < NOW()）
 *
 * 定时任务每天 03:00 自动执行，也可手动触发
 */
router.delete('/analysis-reports/cleanup', async (_req: Request, res: Response) => {
    try {
        const result = await pool.query(
            `DELETE FROM agent_analysis_reports
             WHERE expires_at < NOW()
             RETURNING id`
        )

        const deletedCount = result.rows.length
        console.log(`[Internal] cleanup: deleted ${deletedCount} expired reports`)
        res.json({ code: 200, data: { deleted_count: deletedCount } })
    } catch (err: unknown) {
        console.error('[Internal] analysis-reports cleanup error:', errMsg(err))
        res.status(500).json({ code: 500, message: errMsg(err) })
    }
})

// ==================== 行业向量搜索（pgvector） ====================

/**
 * POST /internal/industries/embeddings
 * Upsert 行业 embedding（供 Python 初始化脚本批量写入）
 *
 * 请求体: { industry_code, industry_name, keywords?, description?, embedding }
 * embedding 必须为 1536 维浮点数组（OpenAI text-embedding-3-small）
 */
router.post('/industries/embeddings', async (req: Request, res: Response) => {
    const { industry_code, industry_name, keywords, description, embedding } = req.body

    if (!industry_code || !industry_name || !embedding || !Array.isArray(embedding)) {
        return res.status(400).json({ code: 400, message: '缺少必填字段：industry_code, industry_name, embedding' })
    }
    if (embedding.length !== 1536) {
        return res.status(400).json({ code: 400, message: `embedding 必须为 1536 维浮点数组，当前 ${embedding.length} 维` })
    }

    try {
        const vectorStr = `[${embedding.join(',')}]`
        await pool.query(
            `INSERT INTO industry_embeddings (industry_code, industry_name, keywords, description, embedding)
             VALUES ($1, $2, $3, $4, $5::vector)
             ON CONFLICT (industry_code)
             DO UPDATE SET
               industry_name = EXCLUDED.industry_name,
               keywords = EXCLUDED.keywords,
               description = EXCLUDED.description,
               embedding = EXCLUDED.embedding,
               updated_at = NOW()`,
            [industry_code, industry_name, keywords || [], description || '', vectorStr]
        )

        res.json({ code: 200, data: { ok: true } })
    } catch (err: unknown) {
        console.error('[Internal] industries/embeddings error:', errMsg(err))
        res.status(500).json({ code: 500, message: errMsg(err) })
    }
})

/**
 * POST /internal/industries/semantic-search
 * 接收 embedding 向量，在 industry_embeddings 表中做 cosine similarity 搜索
 *
 * 请求体: { embedding: number[], threshold?: number, limit?: number }
 * - embedding: 1536 维查询向量
 * - threshold: 相似度阈值（0-1），默认 0.7
 * - limit: 返回数量上限，默认 5
 *
 * 响应: { code: 200, data: { industries: [{code, name, similarity}] } }
 */
router.post('/industries/semantic-search', async (req: Request, res: Response) => {
    const { embedding, threshold = 0.7, limit = 5 } = req.body

    if (!embedding || !Array.isArray(embedding)) {
        return res.status(400).json({ code: 400, message: 'embedding 必须为浮点数组' })
    }
    if (embedding.length !== 1536) {
        return res.status(400).json({ code: 400, message: `embedding 必须为 1536 维浮点数组，当前 ${embedding.length} 维` })
    }

    try {
        // pgvector cosine similarity: 1 - (a <=> b)，<=> 为余弦距离运算符
        const vectorStr = `[${embedding.join(',')}]`
        const result = await pool.query(
            `SELECT
               industry_code AS code,
               industry_name AS name,
               1 - (embedding <=> $1::vector) AS similarity
             FROM industry_embeddings
             WHERE 1 - (embedding <=> $1::vector) > $2
             ORDER BY similarity DESC
             LIMIT $3`,
            [vectorStr, threshold, limit]
        )

        res.json({
            code: 200,
            data: {
                industries: result.rows,
            },
        })
    } catch (err: unknown) {
        console.error('[Internal] industries/semantic-search error:', errMsg(err))
        res.status(500).json({ code: 500, message: errMsg(err) })
    }
})

// =============================================================================
// Agent 报告与音频路由
// - 生成动作：internal router，供 Python Agent 调用并校验 X-Internal-Token
// - 查询/播放：publicRouter，供前端读取
// =============================================================================

import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { AzureMultiVoiceTtsProvider, parseBroadcastDialogue } from '../services/tts.service'
import { readVolcenginePodcastOptions, VolcenginePodcastProvider } from '../services/volcenginePodcast.service'

const publicRouter: Router = Router()

async function synthesizeBroadcast(lines: ReturnType<typeof parseBroadcastDialogue>): Promise<Buffer> {
    const provider = process.env.TTS_PROVIDER || 'azure'
    if (provider === 'volcengine_podcast') {
        return new VolcenginePodcastProvider(readVolcenginePodcastOptions(process.env)).synthesize(lines)
    }

    if (provider === 'azure') {
        const region = process.env.AZURE_SPEECH_REGION
        const subscriptionKey = process.env.AZURE_SPEECH_KEY
        if (!region || !subscriptionKey) throw new Error('缺少 AZURE_SPEECH_REGION 或 AZURE_SPEECH_KEY')
        return new AzureMultiVoiceTtsProvider({ region, subscriptionKey }).synthesize(lines)
    }

    throw new Error(`不支持的 TTS_PROVIDER: ${provider}`)
}

/** 清洗报告中给机器解析用的标记，避免污染用户界面 */
function cleanReportContent(content: Record<string, unknown>): Record<string, unknown> {
    if (!content || typeof content !== 'object') return content
    const cleaned = { ...content } as Record<string, unknown>

    // 清洗 text 字段
    if (typeof cleaned.text === 'string') {
        cleaned.text = cleaned.text
            .replace(/<!--SECTOR_LIST_START-->[\s\S]*?<!--SECTOR_LIST_END-->/g, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    }

    // 清洗 display_report.details
    const display = cleaned.display_report as Record<string, unknown> | undefined
    if (display && typeof display.details === 'string') {
        display.details = display.details
            .replace(/<!--SECTOR_LIST_START-->[\s\S]*?<!--SECTOR_LIST_END-->/g, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    }

    return cleaned
}

/** 查询公共分析报告（复用内部查询逻辑，user_id 为 NULL） */
async function getAnalysisReport(report_type: string, report_date: string) {
    // report_date 是本地日期 YYYY-MM-DD，数据库 report_date 是 UTC timestamp
    // 用日期范围查询：[date 00:00 UTC, date+1 00:00 UTC) 会漏掉跨时区的记录
    // 改用本地日期范围：[date-1 16:00 UTC, date+1 16:00 UTC) 覆盖 Asia/Shanghai
    const start = `${report_date}T00:00:00+08:00`
    const end = `${report_date}T23:59:59+08:00`
    const result = await pool.query(
        `SELECT id, report_type, report_date, content, data_source, status,
                generation_time_ms, model_version, created_at
         FROM agent_analysis_reports
         WHERE report_type = $1
           AND report_date >= $2::timestamptz
           AND report_date <= $3::timestamptz
           AND user_id IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [report_type, start, end]
    )
    return result.rows.length > 0 ? result.rows[0] : null
}

/**
 * POST /internal/briefing/generate-audio
 * 请求体: { date: 'YYYY-MM-DD' }。读取当天双人播报并生成完整 MP3。
 */
router.post('/briefing/generate-audio', json(), async (req: Request, res: Response) => {
    const date = typeof req.body?.date === 'string' ? req.body.date : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ code: 400, message: 'date 必须是 YYYY-MM-DD' })
        return
    }

    try {
        const report = await getAnalysisReport('broadcast', date)
        const text = (report?.content as { text?: unknown } | undefined)?.text
        if (!report || !text) {
            res.status(404).json({ code: 404, message: '播报报告不存在' })
            return
        }

        const audio = await synthesizeBroadcast(parseBroadcastDialogue(text))
        const filename = `broadcast-${date}.mp3`
        const audioDir = process.env.AGENT_AUDIO_DIR || '/home/aistock/aistock-agent-py/data/audio'
        const filePath = path.join(audioDir, filename)
        const tempPath = `${filePath}.${randomUUID()}.part`
        await fs.promises.mkdir(audioDir, { recursive: true })
        await fs.promises.writeFile(tempPath, audio)
        await fs.promises.rename(tempPath, filePath)

        const audioPath = `/api/agent/audio/${filename}`
        await pool.query(
            `UPDATE agent_analysis_reports
             SET content = jsonb_set(content, '{audio_path}', to_jsonb($2::text), true)
             WHERE id = $1`,
            [report.id, audioPath]
        )
        res.json({ code: 0, data: { audio_path: audioPath }, message: '' })
    } catch (err: unknown) {
        console.error('[Internal] briefing/generate-audio error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /api/agent/report/:intent/:date
 * 获取 Agent 分析报告（公开接口，供前端调用）
 *
 * 路径参数：
 * - intent: 报告类型 (morning/wind_leader/hot_burst/broadcast)
 * - date: 报告日期 (YYYY-MM-DD)
 *
 * 响应：
 * - 200: { code: 0, data: { report_type, report_date, content } | null }
 * - 400: { code: -1, message: "Invalid intent" }
 */
publicRouter.get('/report/:intent/:date', async (req: Request, res: Response) => {
    const intent = param(req, 'intent')
    const date = param(req, 'date')

    if (!VALID_REPORT_TYPES.includes(intent)) {
        res.status(400).json({ code: -1, message: `Invalid intent: ${intent}` })
        return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ code: -1, message: `Invalid date format: ${date}` })
        return
    }

    try {
        const result = await getAnalysisReport(intent, date)
        if (result && result.content) {
            result.content = cleanReportContent(result.content as Record<string, unknown>)
        }
        res.json({ code: 0, data: result })
    } catch (err: unknown) {
        console.error('[Public] agent/report GET error:', errMsg(err))
        res.status(500).json({ code: -1, message: 'Internal server error' })
    }
})

/**
 * GET /api/agent/audio/:filename
 * 获取播报音频文件（公开接口）
 *
 * 环境变量：
 * - AGENT_AUDIO_DIR: 音频文件目录（默认 /home/aistock/aistock-agent-py/data/audio）
 */
publicRouter.get('/audio/:filename', (req: Request, res: Response) => {
    const filename = param(req, 'filename')

    // 防止路径遍历攻击
    if (filename.includes('..') || filename.includes('/')) {
        res.status(400).json({ code: -1, message: 'Invalid filename' })
        return
    }

    const audioDir = process.env.AGENT_AUDIO_DIR || '/home/aistock/aistock-agent-py/data/audio'
    const filePath = path.join(audioDir, filename)

    if (!fs.existsSync(filePath)) {
        res.status(404).json({ code: -1, message: 'Audio file not found' })
        return
    }

    res.setHeader('Content-Type', 'audio/mpeg')
    const stream = fs.createReadStream(filePath)
    stream.pipe(res)
})

/**
 * GET /api/agent/event/list
 * 事件传导报告列表（公开接口，供前端调用）
 *
 * Query: page=1, pageSize=10
 * 返回最小可展示元数据：eventId, title, source, publishTime, 摘要/结论
 */
publicRouter.get('/event/list', async (req: Request, res: Response) => {
    const page = Math.max(1, queryInt(req, 'page', 1))
    const pageSize = Math.min(Math.max(1, queryInt(req, 'pageSize', 10)), 100)
    const offset = (page - 1) * pageSize

    try {
        const [dataResult, countResult] = await Promise.all([
            pool.query(
                `SELECT id, report_date, user_id, content, created_at
                 FROM (
                   SELECT DISTINCT ON (user_id)
                     id, report_date, user_id, content, created_at
                   FROM agent_analysis_reports
                   WHERE report_type = 'event_conduction'
                   ORDER BY user_id, created_at DESC
                 ) AS deduped
                 ORDER BY created_at DESC
                 LIMIT $1 OFFSET $2`,
                [pageSize, offset]
            ),
            pool.query(
                `SELECT COUNT(DISTINCT user_id) AS total
                 FROM agent_analysis_reports
                 WHERE report_type = 'event_conduction'`
            ),
        ])

        const items = dataResult.rows.map((row: Record<string, unknown>) => {
            const content = (row['content'] as Record<string, unknown>) || {}
            const ar = (content['analysis_reports'] as Record<string, unknown>) || {}
            const eu = (ar['event_understanding'] as Record<string, unknown>) || {}
            const ei = (ar['event_investment'] as Record<string, unknown>) || {}
            return {
                eventId: content['eventId'] || row['user_id'] || '',
                title: content['title'] || '',
                source: content['source'] || '',
                publishTime: content['publishTime'] || row['report_date'] || '',
                summary: eu['summary'] || '',
                conclusion: ei['conclusion'] || '',
            }
        })

        const totalNum = parseInt(String((countResult.rows[0] as Record<string, unknown>)?.['total'] ?? '0'))
        const hasMore = page * pageSize < totalNum

        res.json({
            code: 0,
            data: {
                events: items,
                total: totalNum,
                page,
                pageSize,
                hasMore,
            },
        })
    } catch (err: unknown) {
        console.error('[Public] agent/event/list error:', errMsg(err))
        res.status(500).json({ code: -1, message: 'Internal server error' })
    }
})

/**
 * GET /api/agent/event/:eventId
 * 事件传导报告详情（公开接口，供前端调用）
 *
 * 返回完整事件元数据和完整 analysis_reports（四模块 + event_podcast_brief）
 */
publicRouter.get('/event/:eventId', async (req: Request, res: Response) => {
    const eventId = param(req, 'eventId')
    if (!eventId) {
        res.status(400).json({ code: -1, message: 'eventId is required' })
        return
    }

    try {
        const result = await pool.query(
            `SELECT id, report_type, report_date, user_id, content, data_source, status,
                    generation_time_ms, model_version, created_at
             FROM agent_analysis_reports
             WHERE report_type = 'event_conduction' AND user_id = $1
             ORDER BY created_at DESC
             LIMIT 1`,
            [eventId]
        )

        if (result.rows.length === 0) {
            res.status(404).json({ code: -1, message: 'Event not found' })
            return
        }

        res.json({ code: 0, data: result.rows[0] })
    } catch (err: unknown) {
        console.error('[Public] agent/event/:eventId error:', errMsg(err))
        res.status(500).json({ code: -1, message: 'Internal server error' })
    }
})

export { publicRouter }

/**
 * POST /internal/push/market-event
 * 市场事件推送 — Python morning_agent 生成晨报后触发。
 *
 * 接受结构化 payload { market, direction, indices, change_pct, cause,
 * evidence_url, evidence_summary, title, event_time }，
 * 通过 WechatPushService + MessagePushService 分别推送到微信和飞书。
 *
 * 需 X-Internal-Token 鉴权。
 *
 * 测试注入点：设置 __marketEventHandlers 可替换推送实现，避免 require.cache hack。
 */
export const __marketEventHandlers: {
    dispatchWechat?: (payload: Record<string, unknown>) => Promise<{ sent: number; failed: number; skipped?: number; matched_users?: number; logs?: unknown[] }>;
    dispatchFeishu?: (payload: Record<string, unknown>) => Promise<{ sent: number; failed: number }>;
} = {};

router.post('/push/market-event', json(), async (req: Request, res: Response) => {
    const {
        market, direction, indices, change_pct,
        cause, evidence_url, evidence_summary,
        title, event_time,
    } = req.body || {}

    if (!market || !title || !cause) {
        res.status(400).json({ code: 400, message: '缺少必填字段: market, title, cause' })
        return
    }

    try {
        const payload = {
            market: String(market),
            direction: String(direction || ''),
            indices: String(indices || ''),
            change_pct: Number(change_pct || 0),
            cause: String(cause),
            evidence_url: String(evidence_url || ''),
            evidence_summary: String(evidence_summary || ''),
            title: String(title),
            event_time: String(event_time || ''),
        }

        const handlers = __marketEventHandlers ?? {}

        // 并行执行微信和飞书推送（任一失败不影响另一方）
        // 测试可通过 __marketEventHandlers 注入 mock，避免 require.cache hack
        const [wxResult, feishuResult] = await Promise.allSettled([
            handlers?.dispatchWechat
                ? handlers.dispatchWechat(payload)
                : (await import('../../modules/push/WechatPushService')).WechatPushService.dispatchMarketEventPush(payload as any),
            handlers?.dispatchFeishu
                ? handlers.dispatchFeishu(payload)
                : (await import('../../modules/push/MessagePushService')).MessagePushService.dispatchMarketEventToFeishu(payload as any),
        ])

        const wxSent = wxResult.status === 'fulfilled' ? (wxResult.value?.sent ?? 0) : 0
        const feishuSent = feishuResult.status === 'fulfilled' ? (feishuResult.value?.sent ?? 0) : 0
        const anySucceeded = wxSent > 0 || feishuSent > 0

        console.log(
            `[Internal] market-event push: ${title}, ` +
            `wx=${wxResult.status === 'fulfilled' ? `sent=${wxSent}` : 'failed'}, ` +
            `feishu=${feishuResult.status === 'fulfilled' ? `sent=${feishuSent}` : 'failed'}`
        )

        res.json({
            code: 0,
            data: { ok: anySucceeded, wx_sent: wxSent, feishu_sent: feishuSent },
            message: anySucceeded ? '' : 'both channels failed to deliver',
        })
    } catch (err: unknown) {
        console.error('[Internal] market-event push error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

export default router
