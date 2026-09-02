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
import { TushareKlineService } from '../../modules/quote/TushareKlineService'
import { TushareTagLeaderService } from '../../modules/quote/TushareTagLeaderService'
import { ClsStockNewsService } from '../../modules/monitor/ClsStockNewsService'
import { ThsService } from '../../modules/monitor/ThsService'
import { WindLeaderService } from '../../modules/monitor/WindLeaderService'
import { loadStockNameMap, resolveStockName } from '../../modules/monitor/HotKeywordDetectorService'
import { StockMonitorService } from '../../modules/monitor/service'
import { TrendScoreService } from '../../modules/monitor/TrendScoreService'
import { IndustryKGService, INDUSTRY_GRAPH_VERSION } from '../../modules/monitor/IndustryKGService'
import { HotBurstService } from '../../modules/monitor/HotBurstService'
import { isValidAShareSymbol } from '../../shared/utils/validator'
import { isValidTagCode } from '../../shared/utils/validator'
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService'
import { verifyJwt } from '../../shared/utils/jwt'
import { isTokenRevoked, REVOKED_MESSAGE, extractTokenFromRequest } from '../../shared/utils/tokenBlacklist'
// MarketSnapshotService 通过 namespace 导入：路由调用 MarketSnapshotService.getTodayCloseSnapshot()，
// 与 brief 中 verbatim 路由代码一致；MarketSnapshotUnavailableError 用 instanceof 判别 409 分支。
import * as MarketSnapshotService from '../../modules/quote/MarketSnapshotService'
import { MarketSnapshotUnavailableError } from '../../modules/quote/MarketSnapshotService'
import { MAX_SYMBOLS } from '../../modules/quote/indexController'
import { getIndexMap, resolveBoardName, getBoardDailyRange } from '../../modules/quote/ThsBoardService'
import { fearGreedInternalRouter } from '../../modules/fear-greed/internalMirror'
import { EmailService } from '../email/EmailService'

// Agent 报告类型枚举
export const VALID_REPORT_TYPES = [
    'morning', 'wind_leader', 'stock', 'alert', 'hot_burst', 'review', 'iterate',
    'broadcast', 'event_conduction', 'market_snapshot', 'trend_score', 'global_importance',
    'brief_morning', 'brief_evening', 'broadcast_morning', 'broadcast_evening',
    'chat_analysis', 'event_scrape', 'midday', 'rhythm_master',
    'sector_trace',
]

/** 报告保留期（design-debate A4/U1 裁决）：rhythm_master 需支撑 60 交易日日历热力图
 *  聚合窗口，TTL 延长至 90 天；其余 report_type 维持建表默认 7 天，避免 03:00 清理过早删除。 */
export function getReportTtlDays(report_type: string): number {
    return report_type === 'rhythm_master' ? 90 : 7
}

interface ChainSummaryItem {
    industry: string
    direction: string
    impactStrength: number
    reason: string
}

/**
 * 从事件报告 content 中提取前端展示专用 chain_summary。
 *
 * 来源：content.analysis_reports.event_transmission.chain
 * 规则：
 *  - chain 缺失 / 非数组 → 返回 []
 *  - 过滤 industry 为空的节点
 *  - 按 impactStrength 降序
 *  - 最多返回 5 条
 *  - 不修改原 chain 结构
 *
 * 示例输出：
 *  [ { industry: '石油石化', direction: 'bullish', impactStrength: 0.92, reason: '...' } ]
 */
function extractChainSummary(content: unknown): ChainSummaryItem[] {
    if (!content || typeof content !== 'object') return []

    const contentObj = content as Record<string, unknown>
    const analysisReports = contentObj['analysis_reports']
    if (!analysisReports || typeof analysisReports !== 'object') return []

    const transmission = (analysisReports as Record<string, unknown>)['event_transmission']
    if (!transmission || typeof transmission !== 'object') return []

    const chain = (transmission as Record<string, unknown>)['chain']
    if (!Array.isArray(chain)) return []

    const items: ChainSummaryItem[] = []
    for (const node of chain) {
        if (!node || typeof node !== 'object') continue
        const item = node as Record<string, unknown>
        const industry = typeof item['industry'] === 'string' ? item['industry'].trim() : ''
        // 过滤无效行业（industry 为空不返回）
        if (!industry) continue
        items.push({
            industry,
            direction: typeof item['direction'] === 'string' ? item['direction'] : 'neutral',
            impactStrength: typeof item['impactStrength'] === 'number' ? item['impactStrength'] : 0,
            reason: typeof item['reason'] === 'string' ? item['reason'] : '',
        })
    }

    // 按 impactStrength 降序，最多 5 条
    return items
        .sort((a, b) => b.impactStrength - a.impactStrength)
        .slice(0, 5)
}

/**
 * 事件卡片展示过滤条件（展示层，仅用于 GET /api/agent/event/list，不删除任何数据）。
 *
 * 判断"事件整体结论"而非 chain 是否含 bullish/bearish：
 * 1. transmission.chain 非空（chain 为空 = 未形成明确行业传导 → 不展示）
 * 2. event_investment.rating != 'neutral'（rating 为系统定义的"事件整体方向"：
 *    positive=整体偏积极/看好、negative=整体偏谨慎/看空、neutral=中性）
 *    - rating 缺失（event_investment 为 null，如旧数据/LLM Call4 失败）视为非中性，
 *      避免误杀 chain 有明确方向的正常事件
 *    - chain 中存在 neutral/bearish 节点不影响展示，只要整体结论非中性即可
 * 说明：不通过 investment.focusIndustries 是否为空判断；不影响详情接口与落库数据。
 */
const EVENT_LIST_DISPLAY_FILTER_SQL = `
  AND jsonb_typeof(content->'analysis_reports'->'event_transmission'->'chain') = 'array'
  AND jsonb_array_length(content->'analysis_reports'->'event_transmission'->'chain') > 0
  AND (content->'analysis_reports'->'event_investment'->>'rating') IS DISTINCT FROM 'neutral'`;

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
 * 安全解析 jsonb/json 字段：pg 驱动已将 json 解析为 JS 对象/数组，
 * 对已是数组的值直接返回，字符串才 JSON.parse，异常时回退空数组。
 * 避免裸 JSON.parse 在值为数组对象时（先 toString 成 "47,85,65,49"）抛 502。
 */
function parseJsonSafe(val: unknown): unknown[] {
    if (Array.isArray(val)) return val
    if (typeof val === 'string') {
        try { return JSON.parse(val) } catch { return [] }
    }
    return []
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

// GET /internal/fear-greed 只读镜像（恐贪指数；契约：无数据 → 200 + 空字段）
router.use('/fear-greed', fearGreedInternalRouter)

/**
 * GET /internal/ths/index-map
 * 同花顺 885/886 板块指数全表（板块名 → ts_code 映射，进程缓存 + 6h TTL）。
 *
 * 供 Python Agent 预测验证器（M2 roadmap）板块名匹配用。
 *
 * - 200: { code: 200, data: { ts_codes: [{ ts_code, name, count, exchange, list_date, type }], updated_at } }
 * - 502: 取数失败
 */
router.get('/ths/index-map', async (_req: Request, res: Response) => {
    try {
        const data = await getIndexMap()
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error(`[Internal] ths/index-map error:`, errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/ths/resolve
 * 板块名 → ts_code 三级匹配（归一化精确 → 归一化双向包含 → 未命中 null）。
 * 归一化：去空格/全角括号、剥「概念/板块/行业/产业链」后缀、小写。
 *
 * - 200: { code: 200, data: { matched: { ts_code, name } | null } }（未命中 matched: null，非 404）
 * - 400: name 缺失或为空
 * - 502: 服务异常
 */
router.get('/ths/resolve', async (req: Request, res: Response) => {
    const name = String(req.query.name || '').trim()
    if (!name) return res.status(400).json({ code: 400, message: 'name 必填' })
    try {
        const matched = await resolveBoardName(name)
        res.json({ code: 200, data: { matched } })
    } catch (err: unknown) {
        console.error(`[Internal] ths/resolve error:`, errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

const CODE_RE = /^\d{6}\.TI$/i

/**
 * GET /internal/ths/:code/daily
 * 同花顺板块指数区间日 K（供预测验证器评分窗口拉取板块涨幅序列）。
 *
 * - 200: { code: 200, data: { ts_code, days, rows: [{ trade_date, pct_chg }] } }
 *   rows 按 trade_date 升序；pct_change → pct_chg 契约键（Tushare 缺失保行为 null，不静默丢行）
 * - 400: code 非 6位.TI / start / end 非 YYYYMMDD
 * - 502: 服务异常
 */
router.get('/ths/:code/daily', async (req: Request, res: Response) => {
    const code = String(req.params.code || '').toUpperCase()
    const start = String(req.query.start || '')
    const end = String(req.query.end || '')
    const YM = /^\d{8}$/
    if (!CODE_RE.test(code) || !YM.test(start) || !YM.test(end)) {
        return res.status(400).json({ code: 400, message: 'code 须为 6位.TI，start/end 须为 YYYYMMDD' })
    }
    try {
        const rows = await getBoardDailyRange(code, start, end)
        res.json({ code: 200, data: { ts_code: code, days: rows.length, rows } })
    } catch (err: unknown) {
        console.error(`[Internal] ths/${code}/daily error:`, errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

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
 * GET /internal/quote/:symbol/kline
 * 个股日 K 线（P5 D41，复用 TushareKlineService，与公开 /api/cn/stock/quotes/kline 同源）
 *
 * - 200: { code: 200, data: { symbol, klt, days, rows } }
 * - 400: symbol 非 6 位 / klt≠101 / days∉[1,120] / fqt∉[0,2]
 * - 502: 服务异常
 */
router.get('/quote/:symbol/kline', async (req: Request, res: Response) => {
    const symbol = param(req, 'symbol')
    if (!isValidAShareSymbol(symbol)) {
        return res.status(400).json({ code: 400, message: 'Invalid symbol — A股代码必须是6位数字' })
    }
    const days = queryInt(req, 'days', 30)
    if (!Number.isInteger(days) || days < 1 || days > 120) {
        return res.status(400).json({ code: 400, message: 'Invalid days — days 必须是 1-120 的整数' })
    }
    const klt = queryInt(req, 'klt', 101)
    if (klt !== 101) {
        return res.status(400).json({ code: 400, message: 'Invalid klt — 对话场景仅支持日线 (101)' })
    }
    const fqt = queryInt(req, 'fqt', 1)
    if (fqt !== 0 && fqt !== 1 && fqt !== 2) {
        return res.status(400).json({ code: 400, message: 'Invalid fqt — fqt 仅支持 0/1/2' })
    }
    // 可选区间参数 start_date/end_date（YYYYMMDD）：存在时按区间过滤 rows，days 忽略；均缺省时保持原 days 语义（对齐 index 端点 H9）
    const startDate = String(req.query.start_date || '')
    const endDate = String(req.query.end_date || '')
    const YMD = /^\d{8}$/
    if ((startDate && !YMD.test(startDate)) || (endDate && !YMD.test(endDate))) {
        return res.status(400).json({ code: 400, message: 'start_date/end_date 须为 YYYYMMDD' })
    }
    try {
        // 指定 start_date 时拉全量（limit=0 不切片，getKLine 语义）后按区间过滤，否则原 days 语义
        const rows = await TushareKlineService.getKLine({ symbol, klt: 101, fqt, limit: startDate ? 0 : days })
        // TushareKlineService.getKLine 返回的是中文键行（时间/开盘价/收盘价/最高价/最低价/涨跌幅），
        // 这里统一映射为契约英文键 trade_date/open/high/low/close/pct_chg；
        // 同时兼容 trade_date/tradeDate 键（测试 mock 数据与潜在直通行），保证真实服务与 mock 均正确。
        const clean = rows.map((r) => ({
            trade_date: r.trade_date ?? r.tradeDate ?? r['时间'] ?? '',
            open: r.open ?? r['开盘价'] ?? null,
            high: r.high ?? r['最高价'] ?? null,
            low: r.low ?? r['最低价'] ?? null,
            close: r.close ?? r['收盘价'] ?? null,
            pct_chg: r.pct_chg ?? r['涨跌幅'] ?? null,
            vol: r.vol ?? r['成交量'] ?? null,
            amount: r.amount ?? r['成交额'] ?? null,
        }))
        // 有任一边界时按区间过滤；每个边界仅当其存在时生效，避免单边参数导致空结果
        const filtered =
            startDate || endDate
                ? clean.filter((r) => {
                      const d = String(r.trade_date).replace(/-/g, '')
                      return (!startDate || d >= startDate) && (!endDate || d <= endDate)
                  })
                : clean
        res.json({ code: 200, data: { symbol, klt: 101, days: filtered.length, rows: filtered } })
    } catch (err: unknown) {
        console.error(`[Internal] quote/${symbol}/kline error:`, errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/** 指数日 K 线（P0 预测验证 v2 历史窗口数据源）。
 * 指数必须走 index_daily（Tushare），且不经 getStockIdentity——000001 会被误判为深市个股。
 * - 200: { code: 200, data: { code, klt: 101, days, rows } }
 * - 400: code 不在指数映射 / days 非 1-200 整数
 * - 502: 服务异常
 */
const INDEX_CODE_TO_TS: Record<string, string> = {
    '000001': '000001.SH', // 上证指数
    '000300': '000300.SH', // 沪深300
    '000688': '000688.SH', // 科创50
    '399001': '399001.SZ', // 深证成指
    '399006': '399006.SZ', // 创业板指
}

router.get('/index/:code/kline', async (req: Request, res: Response) => {
    const code = param(req, 'code')
    const tsCode = INDEX_CODE_TO_TS[code]
    if (!tsCode) {
        return res.status(400).json({ code: 400, message: 'Invalid index code — 支持: 000001/000300/000688/399001/399006' })
    }
    const days = queryInt(req, 'days', 30)
    if (!Number.isInteger(days) || days < 1 || days > 200) {
        return res.status(400).json({ code: 400, message: 'Invalid days — days 必须是 1-200 的整数' })
    }
    // 可选区间参数 start_date/end_date（YYYYMMDD）：存在时按区间过滤 rows，days 忽略；均缺省时保持原 days 语义（H9 向后兼容）
    const startDate = String(req.query.start_date || '')
    const endDate = String(req.query.end_date || '')
    const YMD = /^\d{8}$/
    if ((startDate && !YMD.test(startDate)) || (endDate && !YMD.test(endDate))) {
        return res.status(400).json({ code: 400, message: 'start_date/end_date 须为 YYYYMMDD' })
    }
    try {
        // 指定 start_date 时拉大窗口全量后过滤（index_daily 一次全量返回，成本不变）；否则原 days 语义
        const rows = await TushareKlineService.getIndexKLine(tsCode, startDate ? 5000 : days)
        // 加性透传 vol/amount（Tushare index_daily 已有字段；技术分支成交额条件数据源）
        const clean = rows.map((r) => ({
            trade_date: r.trade_date ?? r.tradeDate ?? r['时间'] ?? '',
            open: r.open ?? r['开盘价'] ?? null,
            high: r.high ?? r['最高价'] ?? null,
            low: r.low ?? r['最低价'] ?? null,
            close: r.close ?? r['收盘价'] ?? null,
            pct_chg: r.pct_chg ?? r['涨跌幅'] ?? null,
            vol: r.vol ?? r['成交量'] ?? null,
            amount: r.amount ?? r['成交额'] ?? null,
        }))
        // 有任一边界时按区间过滤；每个边界仅当其存在时生效，避免单边参数导致空结果
        const filtered =
            startDate || endDate
                ? clean.filter((r) => {
                      const d = String(r.trade_date).replace(/-/g, '')
                      return (!startDate || d >= startDate) && (!endDate || d <= endDate)
                  })
                : clean
        res.json({ code: 200, data: { code, klt: 101, days: filtered.length, rows: filtered } })
    } catch (err: unknown) {
        console.error(`[Internal] index/${code}/kline error:`, errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
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
 * GET /internal/news/telegraph
 * 财联社当日全量电报流（溯源用，按日期分页拉取）
 *
 * 注册在 /news/fulltext/:id 等参数化路由之前，避免 "telegraph" 被 :param 匹配。
 */
router.get('/news/telegraph', async (req: Request, res: Response) => {
    const date = req.query.date as string
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ code: 400, message: 'Invalid date — 必须是 YYYY-MM-DD' })
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 200, 500)

    try {
        const data = await ClsStockNewsService.fetchTelegraphByDate(date, { limit })
        res.json({ code: 200, data })
    } catch (err: any) {
        console.error('[Internal] news/telegraph error:', err.message)
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

/**
 * GET /internal/performance-report/:symbol
 * 个股业绩报告（正式报告 + 业绩快报，按报告期倒序最近 6 期）
 *
 * 供 Python Agent 在 AI 对话中回答"XX 公司的业绩报告/财报/快报"类问题。
 */
router.get('/performance-report/:symbol', async (req: Request, res: Response) => {
    const symbol = param(req, 'symbol')
    if (!isValidAShareSymbol(symbol)) {
        return res.status(400).json({ code: 400, message: 'Invalid symbol — A股代码必须是6位数字' })
    }

    try {
        const result = await pool.query(
            `SELECT symbol, stock_name, report_type, ann_date, end_date,
                    total_revenue, n_income, n_income_attr_p, basic_eps, summary, ai_tag
             FROM performance_reports
             WHERE symbol = $1 AND report_type IN ('formal', 'express')
             ORDER BY end_date DESC, ann_date DESC
             LIMIT 6`,
            [symbol]
        )
        if (result.rows.length === 0) {
            return res.status(404).json({ code: 404, message: '未找到该股票的业绩报告数据' })
        }

        const reports = result.rows.map((row: Record<string, unknown>) => ({
            report_type: row.report_type,
            report_type_label: row.report_type === 'formal' ? '正式报告' : '业绩快报',
            ann_date: row.ann_date,
            end_date: row.end_date,
            total_revenue: row.total_revenue,          // 元
            n_income: row.n_income,                    // 元
            n_income_attr_p: row.n_income_attr_p,      // 元（归母净利润）
            basic_eps: row.basic_eps,
            summary: row.summary || '',
            ai_tag: row.ai_tag || '',
        }))

        res.json({
            code: 200,
            data: {
                symbol,
                stock_name: result.rows[0].stock_name || '',
                reports,
            },
        })
    } catch (err: unknown) {
        console.error(`[Internal] performance-report/${symbol} error:`, errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/stock/resolve
 * 中文股票名称 → 6 位代码（复用 HotKeywordDetectorService 的 A 股名称映射，stocks 表/Tushare stock_basic）
 *
 * - 200：{ code: 200, data: { name: "贵州茅台", symbol: "600519" } }
 * - 400：name 参数缺失或为空
 * - 404：未找到匹配股票
 * - 502：服务异常
 */
router.get('/stock/resolve', async (req: Request, res: Response) => {
    const name = (queryStr(req, 'name') || '').trim()
    if (!name) {
        return res.status(400).json({ code: 400, message: 'name 参数缺失或为空' })
    }

    try {
        await loadStockNameMap()
        const hit = resolveStockName(name)
        if (!hit) {
            return res.status(404).json({ code: 404, message: '未找到匹配股票' })
        }
        res.json({ code: 200, data: { name: hit.name, symbol: hit.symbol } })
    } catch (err: unknown) {
        console.error('[Internal] stock/resolve error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/performance-reports/latest
 * 最新披露业绩报告列表（默认正式报告，按公告日倒序）
 *
 * 参数：
 * - reportType: formal（默认）/ express / all
 * - limit: 返回条数，默认 10，最大 30
 *
 * 供 Python Agent 在 AI 对话中回答"最新业绩报告/最新快报有哪些"类问题。
 */
router.get('/performance-reports/latest', async (req: Request, res: Response) => {
    const reportType = queryStr(req, 'reportType') || 'formal'
    if (!['formal', 'express', 'all'].includes(reportType)) {
        return res.status(400).json({ code: 400, message: 'Invalid reportType — 仅支持 formal / express / all' })
    }
    const limit = Math.min(queryInt(req, 'limit', 10), 30)

    try {
        const result = await pool.query(
            `WITH latest AS (
                SELECT p.symbol, p.stock_name, p.report_type, p.ann_date, p.end_date,
                       p.total_revenue, p.n_income_attr_p, p.basic_eps, p.summary, p.ai_tag,
                       CASE WHEN p.total_revenue IS NOT NULL
                                 AND prev.total_revenue IS NOT NULL AND prev.total_revenue <> 0
                            THEN ((p.total_revenue - prev.total_revenue) / ABS(prev.total_revenue) * 100)::float8
                            ELSE NULL END AS revenue_yoy,
                       CASE WHEN p.n_income_attr_p IS NOT NULL
                                 AND prev.n_income_attr_p IS NOT NULL AND prev.n_income_attr_p <> 0
                            THEN ((p.n_income_attr_p - prev.n_income_attr_p) / ABS(prev.n_income_attr_p) * 100)::float8
                            ELSE NULL END AS profit_yoy
                FROM performance_reports p
                INNER JOIN (
                    SELECT symbol, report_type, MAX(ann_date) AS latest_ann_date
                    FROM performance_reports
                    GROUP BY symbol, report_type
                ) m ON p.symbol = m.symbol AND p.report_type = m.report_type AND p.ann_date = m.latest_ann_date
                LEFT JOIN LATERAL (
                    SELECT total_revenue, n_income_attr_p
                    FROM performance_reports
                    WHERE symbol = p.symbol
                      AND report_type IN ('formal', 'express')
                      AND end_date IS NOT NULL AND end_date != ''
                      AND end_date < p.end_date
                    ORDER BY end_date DESC, report_type DESC
                    LIMIT 1
                ) prev ON true
                WHERE p.report_type IN ('formal', 'express')
                  AND ($1 = 'all' OR p.report_type = $1)
            )
            SELECT l.* FROM latest l
            ORDER BY l.ann_date DESC NULLS LAST, l.symbol ASC
            LIMIT $2`,
            [reportType, limit]
        )

        const reports = result.rows.map((row: Record<string, unknown>) => ({
            symbol: row.symbol,
            stock_name: row.stock_name || '',
            report_type: row.report_type,
            report_type_label: row.report_type === 'formal' ? '正式报告' : '业绩快报',
            ann_date: row.ann_date,
            end_date: row.end_date,
            total_revenue: row.total_revenue,          // 元
            n_income_attr_p: row.n_income_attr_p,      // 元（归母净利润）
            basic_eps: row.basic_eps,
            revenue_yoy: row.revenue_yoy,
            profit_yoy: row.profit_yoy,
            summary: row.summary || '',
            ai_tag: row.ai_tag || '',
        }))

        res.json({ code: 200, data: { reports } })
    } catch (err: unknown) {
        console.error('[Internal] performance-reports/latest error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

// ==================== 个股事件识别：股票基础信息接口 ====================
// GET /internal/stocks/basic — 全量 A 股基础信息，供 Python 股票名称实体匹配
// （stock_event_detector.company_event_rule）。只读 + verifyInternalToken 鉴权 +
// 内存 TTL 缓存，避免 Python 侧每次事件归一化重复拉取。数据复用 stocks 表
// （symbol/name/industry，Tushare stock_basic 同步，与 /api/cn/stocks 同源）。

interface StockBasicItem {
    symbol: string;
    name: string;
    industry: string;
}

let stockBasicCache: StockBasicItem[] | null = null;
let stockBasicCacheAt = 0;
const STOCK_BASIC_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function getStockBasicList(): Promise<StockBasicItem[]> {
    const now = Date.now();
    if (stockBasicCache && now - stockBasicCacheAt < STOCK_BASIC_CACHE_TTL_MS) {
        return stockBasicCache;
    }
    const result = await pool.query(
        `SELECT symbol, name, industry FROM stocks WHERE name IS NOT NULL AND name <> ''`
    );
    stockBasicCache = (result.rows as StockBasicItem[]).map((row) => ({
        symbol: String(row.symbol ?? ''),
        name: String(row.name ?? ''),
        industry: String(row.industry ?? ''),
    }));
    stockBasicCacheAt = now;
    return stockBasicCache;
}

/**
 * GET /internal/stocks/basic
 * 全量 A 股基础信息（symbol/name/industry），供 Python 股票名称实体匹配。
 *
 * - 200：{ code: 200, data: [{ symbol, name, industry }, ...] }
 * - 502：服务异常
 */
router.get('/stocks/basic', async (req: Request, res: Response) => {
    try {
        const data = await getStockBasicList();
        res.json({ code: 200, data });
    } catch (err: unknown) {
        console.error('[Internal] stocks/basic error:', errMsg(err));
        res.status(502).json({ code: 502, message: errMsg(err) });
    }
});

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
            dateFrom: queryStr(req, 'dateFrom') || undefined,
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
            dimScores: parseJsonSafe(r.dim_scores),
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
 * - graphVersion: 图谱版本（稳定常量，供 Agent 侧缓存边界校验）
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

    const rawQuery = req.originalUrl.includes('?') ? req.originalUrl.split('?', 2)[1] : ''
    const rawDepthParams = rawQuery.split('&').filter((part) => {
        const rawKey = part.split('=', 1)[0]
        try {
            return decodeURIComponent(rawKey).toLowerCase().startsWith('depth')
        } catch {
            return rawKey.toLowerCase().startsWith('depth')
        }
    })
    const rawDepth = req.query.depth
    if (
        (rawDepthParams.length > 0
            && (rawDepthParams.length !== 1 || rawDepthParams[0] !== 'depth=1'))
        || (rawDepth !== undefined && (typeof rawDepth !== 'string' || rawDepth !== '1'))
    ) {
        return res.status(400).json({
            code: 400,
            message: 'depth must be omitted or exactly "1" (one-hop only)',
        })
    }
    const depth = 1

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
                source: 'IndustryKGService',
                upstream,
                downstream,
                graphVersion: INDUSTRY_GRAPH_VERSION,  // 稳定图谱版本，Agent 缓存边界校验依赖非空字符串
                updatedAt: graph.updateTime,
            },
        })
    } catch (err: unknown) {
        console.error(`[Internal] industry/${name}/chain error:`, errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/industry/graph
 * 读取 IndustryKG 全图快照（B-5，裁决书 B 论题）。
 * 供 Python build_iterate_cases 产片时采集 window_before.industry_graph
 * （get_industry_graph_full）：返回 chains（上下游边）+ graph_update_time。
 * 注意：必须在 /industry/:name/chain 之后注册不冲突（路径段数不同）；
 * 图谱未初始化 → 502，采集侧降级 None 不阻断产片。
 */
router.get('/industry/graph', async (_req: Request, res: Response) => {
    try {
        const graph = IndustryKGService.getFullGraph()
        res.json({
            code: 200,
            data: {
                chains: graph.edges.map((edge) => ({
                    source: edge.source,
                    target: edge.target,
                    confidence: edge.confidence,
                })),
                graph_update_time: graph.updateTime,
                industry_count: graph.industryCount,
                edge_count: graph.edgeCount,
                concept_count: graph.conceptCount,
            },
        })
    } catch (err: unknown) {
        console.error('[Internal] industry/graph error:', errMsg(err))
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
        const rawMinResonance = queryStr(req, 'min_resonance')
        const minResonance = rawMinResonance === undefined
            ? undefined
            : Math.min(Math.max(queryInt(req, 'min_resonance', 2), 2), 4)
        const data = await HotBurstService.getHotBurstHistory({
            limit: queryInt(req, 'limit', 50),
            offset: queryInt(req, 'offset', 0),
            minResonanceOnly: queryStr(req, 'min_resonance_only') !== 'false',
            days: queryInt(req, 'days', 30),
            minResonance,
        })
        res.json({ code: 200, data })
    } catch (err: unknown) {
        console.error('[Internal] institution-research/history error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/institution-research
 * 机构调研推荐热门股检测结果（三信号源共振模型）
 */
router.get('/institution-research', async (req: Request, res: Response) => {
    try {
        const rawMinResonanceCount = queryInt(req, 'min_resonance_count', 0)
        const data = await HotBurstService.getHotBurst({
            hours: queryInt(req, 'hours', 6),
            minResonanceCount: rawMinResonanceCount === 0
                ? 0
                : Math.min(Math.max(rawMinResonanceCount, 2), 4),
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
 * 可选 query 参数：?date=YYYY-MM-DD（历史交易日回补；缺省 = 当日）。
 *
 * - 200：data 为完整 CloseMarketSnapshot（status: 'complete'）
 * - 409：服务未就绪，data 含 status 与 reason：
 *   - status='not_ready' + reason='market_not_closed'：未收盘 / 非交易日 / date 格式非法 / 指数数据延迟
 *   - status='incomplete' + reason='incomplete_daily_coverage'：已收盘但 daily 覆盖残缺
 * - 502：其它意外异常（沿用既有 502 约定）
 */
router.get('/market/close-snapshot', async (req: Request, res: Response) => {
    const dateParam = queryStr(req, 'date')
    try {
        const data = dateParam
            ? await MarketSnapshotService.getCloseSnapshotByDate(dateParam)
            : await MarketSnapshotService.getTodayCloseSnapshot()
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

/**
 * GET /internal/market/last-close-snapshot
 * 最近一个已完成交易日的收盘快照（跳过 15:30 时钟门禁）。
 *
 * 用途：在盘中或开盘前（如凌晨）需要昨日收盘数据时调用。Python review_full
 * 链路在 close-snapshot 返回 409 时降级到此接口。
 *
 * - 200：data 为完整 CloseMarketSnapshot（status: 'complete'）
 * - 409：数据不可用（非交易日连续回溯失败等）
 * - 502：其它意外异常
 */
router.get('/market/last-close-snapshot', async (_req: Request, res: Response) => {
    try {
        const data = await MarketSnapshotService.getLastCloseSnapshot()
        res.json({ code: 200, data })
    } catch (err: unknown) {
        if (err instanceof MarketSnapshotUnavailableError) {
            res.status(409).json({
                code: 409,
                data: { status: err.status, reason: err.reason },
            })
            return
        }
        console.error('[Internal] market/last-close-snapshot error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

/**
 * GET /internal/market/quick-snapshot
 * 15:30 收盘后基于腾讯实时行情的简版收盘快照。
 *
 * - 200：data 为 CloseMarketSnapshot（snapshot_kind='quick'）
 * - 409：未收盘（status='not_ready'）
 * - 502：其它意外异常
 */
router.get('/market/quick-snapshot', async (_req: Request, res: Response) => {
    try {
        const { TencentSnapshotService } = await import('../../modules/quote/TencentSnapshotService')
        const data = await TencentSnapshotService.buildQuickSnapshot()
        res.json({ code: 200, data })
    } catch (err: unknown) {
        const msg = errMsg(err)
        if (msg.includes('market_not_closed')) {
            res.status(409).json({
                code: 409,
                data: { status: 'not_ready', reason: 'market_not_closed' },
            })
            return
        }
        console.error('[Internal] market/quick-snapshot error:', msg)
        res.status(502).json({ code: 502, message: msg })
    }
})

/**
 * GET /internal/index/quotes
 * A 股指数快照（P5 工作线 B：对话快速指数源，复用 IndexQuoteController 缓存+腾讯源）
 *
 * - 200: { code: 200, data: { indices: [{ index, name, price, changePercent, changeAmount }] } }
 * - 400: symbols 缺失 / 非 6 位数字 / 超 MAX_SYMBOLS
 * - 502: 服务异常
 */
router.get('/index/quotes', async (req: Request, res: Response) => {
    const symbolsParam = queryStr(req, 'symbols')
    if (!symbolsParam) {
        return res.status(400).json({ code: 400, message: '缺少 symbols 参数，示例: ?symbols=000001,399001,399006' })
    }
    const symbols = [...new Set(symbolsParam.split(',').map((s) => s.trim()).filter(Boolean))]
    if (symbols.length === 0) {
        return res.status(400).json({ code: 400, message: '缺少 symbols 参数' })
    }
    if (symbols.length > MAX_SYMBOLS) {
        return res.status(400).json({ code: 400, message: `单次最多查询 ${MAX_SYMBOLS} 只指数` })
    }
    if (symbols.some((s) => !isValidAShareSymbol(s))) {
        return res.status(400).json({ code: 400, message: '指数代码必须是6位数字（不带 sh/sz 前缀）' })
    }
    try {
        const { IndexQuoteController } = await import('../../modules/quote/indexController')
        const indices = await IndexQuoteController.fetchCnIndexQuotesData(symbols)
        res.json({ code: 200, data: { indices } })
    } catch (err: unknown) {
        console.error('[Internal] index/quotes error:', errMsg(err))
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
    // 报告保留期按类型参数化（design-debate A4/U1）：rhythm_master=90 天，其余 7 天
    const ttlDays = getReportTtlDays(report_type)

    try {
        // upsert：COALESCE 处理 NULL user_id（公共报告）
        const result = await pool.query(
            `INSERT INTO agent_analysis_reports
                (report_type, report_date, user_id, content, data_source, status,
                 generation_time_ms, model_version, error_message, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + make_interval(days => $10))
             ON CONFLICT (report_type, report_date, COALESCE(user_id, ''))
             DO UPDATE SET
                content = EXCLUDED.content,
                data_source = EXCLUDED.data_source,
                status = EXCLUDED.status,
                generation_time_ms = EXCLUDED.generation_time_ms,
                model_version = EXCLUDED.model_version,
                error_message = EXCLUDED.error_message,
                expires_at = NOW() + make_interval(days => $10),
                created_at = NOW()
             RETURNING id, report_type, report_date, created_at`,
            [report_type, report_date, user_id, JSON.stringify(content),
             data_source, status, generation_time_ms, model_version, error_message, ttlDays]
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
        `SELECT id, report_type, report_date::text AS report_date, content, data_source, status,
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
 * GET /internal/analysis-reports/:type/:date/list
 * 查询同一类型、同一日期的全部报告。事件传导会以 event_id 写入 user_id，
 * 因此 Brief 构建需要该只读列表而不是公共报告的单条读取接口。
 */
router.get('/analysis-reports/:type/:date/list', async (req: Request, res: Response) => {
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
            `SELECT id, report_type, report_date::text AS report_date, user_id, content, data_source, status,
                    generation_time_ms, model_version, created_at
             FROM agent_analysis_reports
             WHERE report_type = $1 AND report_date = $2
             ORDER BY created_at DESC`,
            [report_type, report_date]
        )
        res.json({ code: 200, data: result.rows })
    } catch (err: unknown) {
        console.error('[Internal] analysis-reports list GET error:', errMsg(err))
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

// ==================== Chat token 用量计费接口（P10 线 2） ====================

/**
 * POST /internal/usage/records
 * 记录一次对话 token 用量（Python ws.py 计费回调）
 *
 * 请求体: { user_id(必填非空), session_id?, prompt_tokens, completion_tokens, total_tokens, question? }
 * 成功: { code: 200, data: { id } }
 * 400: user_id 空 / token 字段非非负整数（含 total_tokens<0）
 */
router.post('/usage/records', async (req: Request, res: Response) => {
    const user_id = req.body.user_id ?? '';
    const session_id = req.body.session_id ?? null;
    const prompt_tokens = req.body.prompt_tokens ?? 0;
    const completion_tokens = req.body.completion_tokens ?? 0;
    const total_tokens = req.body.total_tokens ?? 0;
    const question = req.body.question ?? null;

    if (typeof user_id !== 'string' || user_id.trim() === '') {
        return res.status(400).json({ code: 400, message: 'user_id is required' });
    }
    if (
        !Number.isInteger(prompt_tokens) || prompt_tokens < 0 ||
        !Number.isInteger(completion_tokens) || completion_tokens < 0 ||
        !Number.isInteger(total_tokens) || total_tokens < 0
    ) {
        return res.status(400).json({ code: 400, message: 'token 字段必须是非负整数' });
    }

    try {
        const result = await pool.query(
            `INSERT INTO chat_token_usage
                (user_id, session_id, prompt_tokens, completion_tokens, total_tokens, question)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [user_id, session_id, prompt_tokens, completion_tokens, total_tokens, question]
        );
        res.json({ code: 200, data: { id: result.rows[0]?.id ?? null } });
    } catch (err: unknown) {
        console.error('[Internal] usage/records POST error:', errMsg(err));
        res.status(500).json({ code: 500, message: errMsg(err) });
    }
});

/**
 * GET /internal/usage/summary?user_id=xxx
 * 按 user_id 累计 token 用量（无记录全 0）
 *
 * 成功: { code: 200, data: { user_id, prompt_tokens, completion_tokens, total_tokens, turn_count } }
 * 400: user_id 缺失
 */
router.get('/usage/summary', async (req: Request, res: Response) => {
    const user_id = queryStr(req, 'user_id');
    if (!user_id || user_id.trim() === '') {
        return res.status(400).json({ code: 400, message: 'user_id is required' });
    }

    try {
        const result = await pool.query(
            `SELECT
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COUNT(*) AS turn_count
             FROM chat_token_usage
             WHERE user_id = $1`,
            [user_id]
        );
        const row = result.rows[0] ?? {};
        res.json({
            code: 200,
            data: {
                user_id,
                prompt_tokens: Number(row.prompt_tokens ?? 0),
                completion_tokens: Number(row.completion_tokens ?? 0),
                total_tokens: Number(row.total_tokens ?? 0),
                turn_count: Number(row.turn_count ?? 0),
            },
        });
    } catch (err: unknown) {
        console.error('[Internal] usage/summary GET error:', errMsg(err));
        res.status(500).json({ code: 500, message: errMsg(err) });
    }
});

/**
 * GET /internal/usage/sessions?user_id=xxx
 * 会话维度 token 用量聚合（P10 线 4：会话列表 + 历史用量查询）。
 *
 * 只读聚合 chat_token_usage（session_id 由计划 B 的 ws.py 每轮写入），
 * 按 session_id GROUP BY；pg 对 SUM(...)::bigint 返回 string，统一 Number() 数值化。
 *
 * 成功: { code: 200, data: { user_id, items: [{ session_id, turn_count,
 *          total_tokens, prompt_tokens, completion_tokens, last_used_at }] } }
 * 400: user_id 缺失或为空
 */
router.get('/usage/sessions', async (req: Request, res: Response) => {
    const user_id = queryStr(req, 'user_id');
    if (!user_id || user_id.trim() === '') {
        return res.status(400).json({ code: 400, message: 'user_id is required' });
    }

    try {
        const result = await pool.query(
            `SELECT
                session_id,
                COUNT(*)::int AS turn_count,
                SUM(total_tokens)::bigint AS total_tokens,
                SUM(prompt_tokens)::bigint AS prompt_tokens,
                SUM(completion_tokens)::bigint AS completion_tokens,
                MAX(created_at) AS last_used_at
             FROM chat_token_usage
             WHERE user_id = $1 AND session_id IS NOT NULL
             GROUP BY session_id
             ORDER BY last_used_at DESC`,
            [user_id]
        );
        const items = result.rows.map((row: Record<string, unknown>) => ({
            session_id: row.session_id,
            turn_count: Number(row.turn_count ?? 0),
            total_tokens: Number(row.total_tokens ?? 0),
            prompt_tokens: Number(row.prompt_tokens ?? 0),
            completion_tokens: Number(row.completion_tokens ?? 0),
            last_used_at: row.last_used_at ?? null,
        }));
        res.json({ code: 200, data: { user_id, items } });
    } catch (err: unknown) {
        console.error('[Internal] usage/sessions GET error:', errMsg(err));
        res.status(500).json({ code: 500, message: errMsg(err) });
    }
});

// ==================== 用户画像（Phase 4-3 全局用户记忆） ====================

/**
 * GET /internal/user-profile/:user_id
 * 按 user_id 拉取用户画像（agent-py 对话入口注入用）
 *
 * - 200：{ code: 200, data: profile }（user_id/nickname/investment_preferences/risk_tolerance/updated_at）
 * - 200 + {}：无记录（空画像，不 404——agent-py 无 profile 时零行为变化）
 * - 400：user_id 缺失
 * - 502：服务异常
 */
router.get('/user-profile/:userId', async (req: Request, res: Response) => {
    const user_id = param(req, 'userId')
    if (!user_id) {
        return res.status(400).json({ code: 400, message: 'userId is required' })
    }
    try {
        const result = await pool.query(
            `SELECT user_id, nickname, investment_preferences, risk_tolerance, updated_at
             FROM user_profiles
             WHERE user_id = $1`,
            [user_id]
        )
        const row = result.rows[0]
        res.json({ code: 200, data: row ?? {} })
    } catch (err: unknown) {
        console.error('[Internal] user-profile GET error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
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
import { AzureMultiVoiceTtsProvider, type DialogueLine } from '../services/tts.service'
import { readVolcenginePodcastAccounts, VolcenginePodcastPool } from '../services/volcenginePodcast.service'
import { parseSingleByteRange } from '../services/audioRange.service'

const publicRouter: Router = Router()

async function synthesizeBroadcast(lines: DialogueLine[]): Promise<Buffer> {
    const provider = process.env.TTS_PROVIDER || 'azure'
    if (provider === 'volcengine_podcast') {
        const accounts = readVolcenginePodcastAccounts(process.env)
        const pool = new VolcenginePodcastPool(accounts)
        return pool.synthesize(lines)
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
        `SELECT id, report_type, report_date::text AS report_date, content, data_source, status,
                generation_time_ms, model_version,
                created_at AT TIME ZONE 'UTC' AS created_at
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
 * 查询最近一份公共分析报告（降级用：指定日期无报告时返回最近一份）。
 * 用于周末/节假日 Agent 未生成新报告时，前端仍可展示上一份报告。
 */
async function getLatestAnalysisReport(report_type: string) {
    const result = await pool.query(
        `SELECT id, report_type, report_date::text AS report_date, content, data_source, status,
                generation_time_ms, model_version,
                created_at AT TIME ZONE 'UTC' AS created_at
         FROM agent_analysis_reports
         WHERE report_type = $1
           AND user_id IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [report_type]
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

    const requestedBriefType = req.body?.brief_type
    if (requestedBriefType !== 'morning' && requestedBriefType !== 'evening') {
        res.status(400).json({ code: 400, message: 'brief_type must be morning or evening' })
        return
    }
    const briefType: 'morning' | 'evening' = requestedBriefType
    const reportType = BROADCAST_REPORT_TYPES[briefType]
    const filename = `broadcast-${briefType}-${date}.mp3`

    try {
        const [report, sourceBrief] = await Promise.all([
            getAnalysisReport(reportType, date),
            getAnalysisReport(BRIEF_REPORT_TYPES[briefType], date),
        ])
        if (!isInternalBroadcastReadyForAudio(report, briefType, reportType, date, sourceBrief)) {
            res.status(404).json({ code: 404, message: '播报报告不存在' })
            return
        }

        const audio = await synthesizeBroadcast(report.content.dialogue as DialogueLine[])
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
            [(report as Record<string, unknown>).id, audioPath]
        )
        res.json({ code: 0, data: { audio_path: audioPath }, message: '' })
    } catch (err: unknown) {
        console.error('[Internal] briefing/generate-audio error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

const BRIEF_REPORT_TYPES = {
    morning: 'brief_morning',
    evening: 'brief_evening',
} as const

/**
 * POST /internal/midday/generate-audio
 * 请求体: { date: 'YYYY-MM-DD', dialogue: DialogueLine[] }。
 * 接收午报播报双人对话（midday_broadcast agent 生成），合成完整 MP3，并回填
 * 到当日 midday 报告 content.audio_path（同一份报告，方案 A）。
 * 文件名约定 `midday-<date>.mp3`，与前端 parseMiddayReport.isMiddayAudioPath 期望一致。
 */
router.post('/midday/generate-audio', json(), async (req: Request, res: Response) => {
    const date = typeof req.body?.date === 'string' ? req.body.date : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ code: 400, message: 'date 必须是 YYYY-MM-DD' })
        return
    }
    const rawDialogue: unknown[] = Array.isArray(req.body?.dialogue) ? req.body.dialogue : []
    if (!rawDialogue.length) {
        res.status(400).json({ code: 400, message: 'dialogue 必须是非空数组' })
        return
    }

    try {
        const report = await getAnalysisReport('midday', date)
        if (!report) {
            res.status(404).json({ code: 404, message: 'midday 报告不存在' })
            return
        }

        // 清洗对话行为 DialogueLine[]（仅 host/analyst + 非空 content），复用现有 TTS 合成
        const lines: DialogueLine[] = rawDialogue.flatMap((item): DialogueLine[] => {
            if (!item || typeof item !== 'object') return []
            const { role, content } = item as Record<string, unknown>
            if ((role !== 'host' && role !== 'analyst') || typeof content !== 'string' || !content.trim()) return []
            return [{ role, content: content.trim() }]
        })
        if (!lines.length) {
            res.status(400).json({ code: 400, message: 'dialogue 没有有效台词' })
            return
        }

        const audio = await synthesizeBroadcast(lines)
        const filename = `midday-${date}.mp3`
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
            [(report as Record<string, unknown>).id, audioPath]
        )
        res.json({ code: 0, data: { audio_path: audioPath }, message: '' })
    } catch (err: unknown) {
        console.error('[Internal] midday/generate-audio error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

const BROADCAST_REPORT_TYPES = {
    morning: 'broadcast_morning',
    evening: 'broadcast_evening',
} as const

const BRIEF_SOURCE_REPORT_TYPES = new Set<string>([
    'morning', 'wind_leader', 'alert', 'hot_burst', 'review', 'iterate',
    'event_conduction', 'trend_score', 'market_snapshot',
])

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
}

function isNonEmptyTimestamp(value: unknown): boolean {
    return (isNonEmptyString(value) && !Number.isNaN(Date.parse(value)))
        || (value instanceof Date && !Number.isNaN(value.getTime()))
}

function isCalendarDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function reportDateMatches(value: unknown, expectedDate: string): boolean {
    if (!isCalendarDate(expectedDate)) return false
    if (typeof value === 'string') return isCalendarDate(value) && value === expectedDate
    return value instanceof Date && !Number.isNaN(value.getTime())
        && value.toISOString().slice(0, 10) === expectedDate
}

/**
 * 校验 missing_sources 元素是否合法。支持两种形式：
 * 1. 纯 report_type：如 "review"（briefing.py morning 分支）
 * 2. 变体后缀：如 "review.sectors"（briefing.py evening 分支按 review 展示维度
 *    细分缺失来源）。校验时取 "." 前缀做白名单判断，避免整份 Brief 因某个
 *    展示维度缺失而被公开接口拒绝（防复发缺陷）。
 */
function isKnownBriefSourceType(source: string): boolean {
    if (BRIEF_SOURCE_REPORT_TYPES.has(source)) return true
    const dotIndex = source.indexOf('.')
    return dotIndex > 0 && BRIEF_SOURCE_REPORT_TYPES.has(source.slice(0, dotIndex))
}

function hasValidDegradation(content: Record<string, unknown>): boolean {
    if (typeof content.degraded !== 'boolean' || !Array.isArray(content.missing_sources)) return false
    const missingSources = content.missing_sources
    return missingSources.every(
        (source) => isNonEmptyString(source) && isKnownBriefSourceType(source),
    )
        && new Set(missingSources).size === missingSources.length
        && (content.degraded ? missingSources.length > 0 : missingSources.length === 0)
}

function looksLikeRawJson(text: unknown): boolean {
    if (typeof text !== 'string') return false
    const stripped = text.trimStart()
    if (!stripped.startsWith('{') && !stripped.startsWith('[')) return false
    try {
        JSON.parse(stripped)
    } catch {
        return false
    }
    return true
}

function isBriefEvidence(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const evidence = value as Record<string, unknown>
    return ['id', 'report_type', 'data_source', 'created_at'].every(
        (key) => isNonEmptyString(evidence[key]),
    ) && BRIEF_SOURCE_REPORT_TYPES.has(evidence.report_type as string)
        && isNonEmptyTimestamp(evidence.created_at)
}

function isBriefItem(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const item = value as Record<string, unknown>
    const uncertainty = item.uncertainty
    const hasUncertainty = isNonEmptyString(uncertainty)
        || (Array.isArray(uncertainty) && uncertainty.length > 0 && uncertainty.every(isNonEmptyString))
    return ['title', 'conclusion', 'as_of', 'confidence'].every((key) => isNonEmptyString(item[key]))
        && hasUncertainty
        && !looksLikeRawJson(item.conclusion)
        && Array.isArray(item.evidence)
        && item.evidence.length > 0
        && item.evidence.every(isBriefEvidence)
}

function isPublicBriefReport(
    value: unknown,
    expectedBriefType: 'morning' | 'evening',
    expectedReportType: string,
    expectedDate: string,
): value is { id: number; content: Record<string, unknown> } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const report = value as Record<string, unknown>
    if (typeof report.id !== 'number' || !Number.isInteger(report.id) || report.id <= 0
        || report.report_type !== expectedReportType
        || !reportDateMatches(report.report_date, expectedDate)
        || report.status !== 'completed'
        || !isNonEmptyString(report.data_source)
        || !isNonEmptyTimestamp(report.created_at)
        || !report.content || typeof report.content !== 'object' || Array.isArray(report.content)) return false

    const content = report.content as Record<string, unknown>
    return content.schema_version === 'brief.v1'
        && content.brief_type === expectedBriefType
        && isNonEmptyTimestamp(content.as_of)
        && hasValidDegradation(content)
        && Array.isArray(content.items)
        && content.items.length <= 5
        && content.items.every(isBriefItem)
        && (content.degraded === true || content.items.length >= 3)
}

function publicBriefProjection(content: Record<string, unknown>): Record<string, unknown> {
    return {
        schema_version: content.schema_version,
        brief_type: content.brief_type,
        as_of: content.as_of,
        items: (content.items as Record<string, unknown>[]).map((item) => ({
            title: item.title,
            conclusion: item.conclusion,
            evidence: (item.evidence as Record<string, unknown>[]).map((evidence) => ({
                report_type: evidence.report_type,
                id: evidence.id,
                data_source: evidence.data_source,
                created_at: evidence.created_at,
            })),
            as_of: item.as_of,
            confidence: item.confidence,
            uncertainty: item.uncertainty,
        })),
        degraded: content.degraded,
        missing_sources: content.missing_sources,
    }
}

function isValidatedBroadcastReport(
    value: unknown,
    expectedBriefType: 'morning' | 'evening',
    expectedReportType: string,
    expectedDate: string,
    sourceBrief: unknown,
    expectedAudioPath: string | null,
): value is { id: number; content: Record<string, unknown> } {
    if (!isPublicBriefReport(sourceBrief, expectedBriefType, BRIEF_REPORT_TYPES[expectedBriefType], expectedDate)
        || !value || typeof value !== 'object' || Array.isArray(value)) return false
    const report = value as Record<string, unknown>
    const content = report.content as Record<string, unknown>
    if (typeof report.id !== 'number' || !Number.isInteger(report.id) || report.id <= 0
        || report.report_type !== expectedReportType
        || !reportDateMatches(report.report_date, expectedDate)
        || report.status !== 'completed'
        || !isNonEmptyString(report.data_source)
        || !isNonEmptyTimestamp(report.created_at)
        || !content || typeof content !== 'object' || Array.isArray(content)
        || content.schema_version !== 'broadcast.v1'
        || content.brief_type !== expectedBriefType
        || !hasValidDegradation(content)
        || !Array.isArray(content.dialogue)
        || content.dialogue.length === 0
        || !content.dialogue.every((line) => {
            if (!line || typeof line !== 'object' || Array.isArray(line)) return false
            const dialogue = line as Record<string, unknown>
            return (dialogue.role === 'host' || dialogue.role === 'analyst')
                && isNonEmptyString(dialogue.content)
                && !looksLikeRawJson(dialogue.content)
        })) return false

    const source = content.source_brief
    const sourceBriefContent = sourceBrief.content
    if (!source || typeof source !== 'object' || Array.isArray(source)) return false
    const sourceRecord = source as Record<string, unknown>
    if (String(sourceRecord.id) !== String(sourceBrief.id)
        || sourceRecord.report_type !== BRIEF_REPORT_TYPES[expectedBriefType]
        || !reportDateMatches(sourceRecord.report_date, expectedDate)
        || !isNonEmptyTimestamp(sourceRecord.as_of)
        || sourceRecord.as_of !== sourceBriefContent.as_of
        || content.degraded !== sourceBriefContent.degraded
        || JSON.stringify(content.missing_sources) !== JSON.stringify(sourceBriefContent.missing_sources)) return false

    return content.audio_path === expectedAudioPath
}

function publicBroadcastProjection(content: Record<string, unknown>): Record<string, unknown> {
    const sourceBrief = content.source_brief as Record<string, unknown>
    return {
        schema_version: content.schema_version,
        brief_type: content.brief_type,
        source_brief: {
            id: sourceBrief.id,
            report_type: sourceBrief.report_type,
            report_date: sourceBrief.report_date,
            as_of: sourceBrief.as_of,
        },
        degraded: content.degraded,
        missing_sources: [...(content.missing_sources as string[])],
        dialogue: (content.dialogue as Record<string, unknown>[]).map((line) => ({
            role: line.role,
            content: line.content,
        })),
        audio_path: content.audio_path,
    }
}

function isInternalBroadcastReadyForAudio(
    value: unknown,
    briefType: 'morning' | 'evening',
    reportType: string,
    date: string,
    sourceBrief: unknown,
): value is { id: number; content: Record<string, unknown> } {
    return isValidatedBroadcastReport(value, briefType, reportType, date, sourceBrief, null)
}

async function serveBrief(req: Request, res: Response): Promise<void> {
    const briefType = param(req, 'briefType')
    const date = param(req, 'date')
    if (briefType !== 'morning' && briefType !== 'evening') {
        res.status(400).json({ code: -1, message: `Invalid brief_type: ${briefType}` })
        return
    }
    if (!isCalendarDate(date)) {
        res.status(400).json({ code: -1, message: `Invalid date format: ${date}` })
        return
    }
    try {
        const result = await getAnalysisReport(BRIEF_REPORT_TYPES[briefType], date)
        res.json({
            code: 0,
            data: isPublicBriefReport(result, briefType, BRIEF_REPORT_TYPES[briefType], date)
                ? publicBriefProjection(result.content)
                : null,
        })
    } catch (err: unknown) {
        console.error('[Public] brief artifact GET error:', errMsg(err))
        res.status(500).json({ code: -1, message: 'Internal server error' })
    }
}

publicRouter.get('/brief/:briefType/:date', async (req: Request, res: Response) => {
    await serveBrief(req, res)
})

publicRouter.get('/broadcast/:briefType/:date', async (req: Request, res: Response) => {
    const briefType = param(req, 'briefType')
    const date = param(req, 'date')
    if (briefType !== 'morning' && briefType !== 'evening') {
        res.status(400).json({ code: -1, message: `Invalid brief_type: ${briefType}` })
        return
    }
    if (!isCalendarDate(date)) {
        res.status(400).json({ code: -1, message: `Invalid date format: ${date}` })
        return
    }
    try {
        const [broadcast, sourceBrief] = await Promise.all([
            getAnalysisReport(BROADCAST_REPORT_TYPES[briefType], date),
            getAnalysisReport(BRIEF_REPORT_TYPES[briefType], date),
        ])
        res.json({
            code: 0,
            data: isValidatedBroadcastReport(
                broadcast, briefType, BROADCAST_REPORT_TYPES[briefType], date, sourceBrief,
                `/api/agent/audio/broadcast-${briefType}-${date}.mp3`,
            ) ? publicBroadcastProjection(broadcast.content) : null,
        })
    } catch (err: unknown) {
        console.error('[Public] broadcast artifact GET error:', errMsg(err))
        res.status(500).json({ code: -1, message: 'Internal server error' })
    }
})

/**
 * GET /api/agent/report/chat/:reportId
 * 深度分析报告详情（公开接口，需 JWT Bearer 鉴权）
 *
 * chat_analysis 是私密对话内容（非 alert 等公开数据），report_id 自增主键可枚举，
 * 必须服务端验签：user_id 取 token 的 openid（绝不信客户端参数，硬约束 6）。
 * 不存在/非本人/过期（7 天 TTL）→ data: null，不泄露存在性。
 *
 * 注意：必须注册在 /report/:intent/:date 通用端点之前（Express 按注册顺序匹配，
 * 否则 /report/chat/5 会被通用端点捕获 → intent='chat'、date='5' → 400）。
 */
publicRouter.get('/report/chat/:reportId', async (req: Request, res: Response) => {
    // 鉴权：Bearer 优先、Cookie token= 兜底（与 requireAuth 提取逻辑同源，tokenBlacklist.extractTokenFromRequest）
    const token = extractTokenFromRequest(req)
    if (!token) {
        res.status(401).json({ code: 401, message: '未登录' })
        return
    }
    const payload = verifyJwt(token, process.env.JWT_SECRET!)
    if (!payload) {
        res.status(401).json({ code: 401, message: 'token 无效或已过期' })
        return
    }
    // token-revocation Step 2：验签通过后查黑名单（命中即拒绝）
    if (await isTokenRevoked(payload.jti)) {
        res.status(401).json({ code: 401, message: REVOKED_MESSAGE })
        return
    }

    const reportId = param(req, 'reportId')
    if (!/^\d+$/.test(reportId)) {
        res.status(400).json({ code: -1, message: `Invalid report_id: ${reportId}` })
        return
    }

    try {
        const result = await pool.query(
            `SELECT id, report_type, report_date::text AS report_date, content, data_source, status,
                    generation_time_ms, model_version,
                    created_at AT TIME ZONE 'UTC' AS created_at
             FROM agent_analysis_reports
             WHERE id = $1
               AND report_type = 'chat_analysis'
               AND user_id = $2
               AND (expires_at IS NULL OR expires_at > NOW())
             LIMIT 1`,
            [reportId, payload.openid]
        )
        const row = result.rows.length > 0 ? result.rows[0] : null
        // 不存在/非本人/过期 → data: null（不泄露存在性）
        let data: unknown = null
        if (row) {
            if (row.content) {
                row.content = cleanReportContent(row.content as Record<string, unknown>)
            }
            // id 为 BIGSERIAL，pg 返回 string，归一为 Number（repo 既有约定，见 usage 聚合注释）
            data = { ...row, id: Number(row.id) }
        }
        res.json({ code: 0, data })
    } catch (err: unknown) {
        console.error('[Public] agent/report/chat GET error:', errMsg(err))
        res.status(500).json({ code: -1, message: 'Internal server error' })
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

    if (intent === 'stock' || intent === 'market_snapshot' || intent === 'iterate'
        || intent === 'broadcast'
        || intent.startsWith('brief_') || intent.startsWith('broadcast_')
        || !VALID_REPORT_TYPES.includes(intent)) {
        res.status(400).json({ code: -1, message: `Invalid intent: ${intent}` })
        return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ code: -1, message: `Invalid date format: ${date}` })
        return
    }

    try {
        let result = await getAnalysisReport(intent, date)
        // 降级：指定日期无报告（周末/节假日 Agent 未生成）时，返回最近一份报告
        if (!result) {
            result = await getLatestAnalysisReport(intent)
        }
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
 * GET /api/agent/report/alert/:symbol/:date
 * 查询指定股票的异动分析报告（公开接口）
 *
 * alert 报告写入 DB 时 user_id = symbol，与通用 /report/:intent/:date 端点
 * （过滤 user_id IS NULL）不兼容，故单独提供按 symbol 查询的端点。
 *
 * 路径参数：
 * - symbol: 6位A股代码，如 603601
 * - date: 报告日期 YYYY-MM-DD
 *
 * 响应：{ code: 0, data: { report_type, report_date, content: { symbol, display_report, podcast_brief } } | null }
 */
publicRouter.get('/report/alert/:symbol/:date', async (req: Request, res: Response) => {
    const symbol = param(req, 'symbol')
    const date = param(req, 'date')

    if (!isValidAShareSymbol(symbol)) {
        res.status(400).json({ code: -1, message: `Invalid symbol: ${symbol}` })
        return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ code: -1, message: `Invalid date format: ${date}` })
        return
    }

    try {
        // alert 报告 user_id = symbol，按 symbol + date 精确查询
        // 时区处理与 getAnalysisReport 一致：覆盖 Asia/Shanghai 当日
        const start = `${date}T00:00:00+08:00`
        const end = `${date}T23:59:59+08:00`
        const result = await pool.query(
            `SELECT id, report_type, report_date::text AS report_date, content, data_source, status,
                    generation_time_ms, model_version,
                    created_at AT TIME ZONE 'UTC' AS created_at
             FROM agent_analysis_reports
             WHERE report_type = 'alert'
               AND user_id = $1
               AND report_date >= $2::timestamptz
               AND report_date <= $3::timestamptz
             ORDER BY created_at DESC
             LIMIT 1`,
            [symbol, start, end]
        )
        const row = result.rows.length > 0 ? result.rows[0] : null
        if (row && row.content) {
            row.content = cleanReportContent(row.content as Record<string, unknown>)
        }
        res.json({ code: 0, data: row })
    } catch (err: unknown) {
        console.error('[Public] agent/report/alert GET error:', errMsg(err))
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

    const fileSize = fs.statSync(filePath).size
    const rangeHeader = req.headers.range
    const range = parseSingleByteRange(rangeHeader, fileSize)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', 'audio/mpeg')

    if (rangeHeader && !range) {
        res.setHeader('Content-Range', `bytes */${fileSize}`)
        res.status(416).end()
        return
    }

    const stream = range
        ? fs.createReadStream(filePath, range)
        : fs.createReadStream(filePath)
    if (range) {
        res.status(206)
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${fileSize}`)
        res.setHeader('Content-Length', String(range.end - range.start + 1))
    } else {
        res.setHeader('Content-Length', String(fileSize))
    }
    stream.on('error', () => res.destroy())
    stream.pipe(res)
})

/**
 * POST /api/agent/brief/generate-podcast
 * 通用播报生成（公开接口，单主播朗读文本）
 *
 * 请求体: { text: string, key: string }
 * - text: 播报文本（podcast_brief，1-250字，约1分钟播报时长）
 * - key: 缓存键（如 alert_603601_2026-08-01），用于文本落库和音频文件幂等
 *
 * 响应: { code: 0, data: { audio_url: string, cached: boolean } }
 * - 文本先生成存库（podcast_cache 表），音频文件已存在时直接返回（cached: true），不重复合成
 */
publicRouter.post('/brief/generate-podcast', json(), async (req: Request, res: Response) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : ''

    if (!text) {
        res.status(400).json({ code: -1, message: 'text 不能为空' })
        return
    }
    if (text.length > 250) {
        res.status(400).json({ code: -1, message: 'text 长度不能超过 250 字（约1分钟播报时长）' })
        return
    }
    if (!key) {
        res.status(400).json({ code: -1, message: 'key 不能为空' })
        return
    }

    // sanitize key：仅保留字母数字下划线连字符，防止路径遍历
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_')
    if (!safeKey) {
        res.status(400).json({ code: -1, message: 'key 无效' })
        return
    }

    const filename = `podcast-${safeKey}.mp3`
    const audioDir = process.env.AGENT_AUDIO_DIR || '/home/aistock/aistock-agent-py/data/audio'
    const filePath = path.join(audioDir, filename)
    const audioUrl = `/api/agent/audio/${filename}`

    try {
        // 文本先生成存库：按 key upsert 播报文本（幂等），避免每次依赖前端实时传参，7 天过期随清理任务删除
        await pool.query(
            `INSERT INTO podcast_cache (cache_key, text, status, audio_path)
             VALUES ($1, $2, 'pending', '')
             ON CONFLICT (cache_key) DO UPDATE SET
                text = EXCLUDED.text,
                status = 'pending',
                error_message = NULL,
                expires_at = NOW() + INTERVAL '7 days'`,
            [safeKey, text]
        )

        // 缓存命中：音频文件已存在直接返回（cached: true）
        if (fs.existsSync(filePath)) {
            await pool.query(
                `UPDATE podcast_cache SET status = 'completed', audio_path = $2 WHERE cache_key = $1`,
                [safeKey, audioUrl]
            )
            res.json({ code: 0, data: { audio_url: audioUrl, cached: true } })
            return
        }

        // 单主播朗读：包装为单条 host 对话行，复用现有 synthesizeBroadcast
        const lines: DialogueLine[] = [{ role: 'host', content: text }]
        const audioBuffer = await synthesizeBroadcast(lines)

        await fs.promises.mkdir(audioDir, { recursive: true })
        const tempPath = `${filePath}.${randomUUID()}.part`
        await fs.promises.writeFile(tempPath, audioBuffer)
        await fs.promises.rename(tempPath, filePath)

        // 生成成功：回填音频路径与状态
        await pool.query(
            `UPDATE podcast_cache SET status = 'completed', audio_path = $2 WHERE cache_key = $1`,
            [safeKey, audioUrl]
        )

        res.json({ code: 0, data: { audio_url: audioUrl, cached: false } })
    } catch (err: unknown) {
        // 生成失败：标记 failed 并保留文本，前端可重试
        await pool.query(
            `UPDATE podcast_cache SET status = 'failed', error_message = $2 WHERE cache_key = $1`,
            [safeKey, errMsg(err).slice(0, 500)]
        ).catch(() => undefined)
        console.error('[Public] generate-podcast error:', errMsg(err))
        res.status(502).json({ code: -1, message: errMsg(err) })
    }
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
    // 可选事件类型筛选（2026-08-14，方案A：服务端筛选 + 服务端分页）：
    // eventType 有值时在 WHERE 增加 content->>'event_type' = eventType，
    // 先筛选再 ORDER BY / LIMIT / OFFSET；SELECT 与 COUNT 使用同一条件。
    // 不传 eventType 时保持原行为（不追加条件、不追加参数）。
    const eventType = (queryStr(req, 'eventType') || '').trim()
    const eventTypeCond = (placeholder: string): string =>
        eventType ? ` AND content->>'event_type' = ${placeholder}` : ''

    try {
        const [dataResult, countResult, giResult] = await Promise.all([
            pool.query(
                `SELECT id, report_date, user_id, content, created_at
                 FROM (
                   SELECT DISTINCT ON (user_id)
                     id, report_date, user_id, content, created_at
                   FROM agent_analysis_reports
                   WHERE report_type = 'event_conduction'${EVENT_LIST_DISPLAY_FILTER_SQL}${eventTypeCond('$3')}
                   ORDER BY user_id, created_at DESC
                 ) AS deduped
                 ORDER BY created_at DESC
                 LIMIT $1 OFFSET $2`,
                eventType ? [pageSize, offset, eventType] : [pageSize, offset]
            ),
            pool.query(
                `SELECT COUNT(DISTINCT user_id) AS total
                 FROM agent_analysis_reports
                 WHERE report_type = 'event_conduction'${EVENT_LIST_DISPLAY_FILTER_SQL}${eventTypeCond('$1')}`,
                eventType ? [eventType] : []
            ),
            // 查询最新的 global_importance 报告
            pool.query(
                `SELECT content
                 FROM agent_analysis_reports
                 WHERE report_type = 'global_importance' AND status = 'completed'
                 ORDER BY created_at DESC
                 LIMIT 1`
            ),
        ])

        // 构建 event_id → rank / direction / level 的映射
        // 读取优先级（历史兼容三级回退）：
        //   ① top_bullish_event / top_bearish_event（新 Schema）
        //   ② current_focus_event / ongoing_significant_event（旧 Schema）
        //   ③ events[]（最旧格式）
        const giRankMap = new Map<string, number>()
        const giDirectionMap = new Map<string, string>()
        const giLevelMap = new Map<string, string>()
        if (giResult.rows.length > 0) {
            const giContent = (giResult.rows[0]['content'] as Record<string, unknown>) || {}

            const applyGiEvent = (ev: Record<string, unknown> | undefined, rank: number): void => {
                if (!ev) return
                const eventId = String(ev['event_id'] || '')
                if (eventId) {
                    giRankMap.set(eventId, rank)
                    giDirectionMap.set(eventId, String(ev['direction'] || ''))
                    giLevelMap.set(eventId, String(ev['importance_level'] || ''))
                }
            }

            const topBullish = giContent['top_bullish_event'] as Record<string, unknown> | undefined
            const topBearish = giContent['top_bearish_event'] as Record<string, unknown> | undefined
            if (topBullish || topBearish) {
                // 新 Schema：最大利好 → rank=1，最大利空 → rank=2
                applyGiEvent(topBullish, 1)
                applyGiEvent(topBearish, 2)
            } else {
                const focus = giContent['current_focus_event'] as Record<string, unknown> | undefined
                const ongoing = giContent['ongoing_significant_event'] as Record<string, unknown> | undefined
                if (focus || ongoing) {
                    // 旧 Schema 双事件：焦点 → rank=1，持续 → rank=2
                    applyGiEvent(focus, 1)
                    applyGiEvent(ongoing, 2)
                } else {
                    // 最旧格式 events[]（含 rank 字段）
                    const legacyEvents = (giContent['events'] as Array<Record<string, unknown>>) || []
                    legacyEvents.forEach((ev) => {
                        const eventId = String(ev['event_id'] || '')
                        const rank = Number(ev['rank']) || 0
                        if (eventId && rank > 0) {
                            giRankMap.set(eventId, rank)
                            giDirectionMap.set(eventId, String(ev['direction'] || ''))
                            giLevelMap.set(eventId, String(ev['importance_level'] || ''))
                        }
                    })
                }
            }
        }

        const items = dataResult.rows.map((row: Record<string, unknown>) => {
            const content = (row['content'] as Record<string, unknown>) || {}
            const ar = (content['analysis_reports'] as Record<string, unknown>) || {}
            const eu = (ar['event_understanding'] as Record<string, unknown>) || {}
            const ei = (ar['event_investment'] as Record<string, unknown>) || {}
            const eventId = String(content['eventId'] || row['user_id'] || '')

            return {
                eventId,
                title: content['title'] || '',
                source: content['source'] || '',
                source_name: content['source_name'] || '',
                event_type: content['event_type'] || '',
                publishTime: content['publishTime'] || row['report_date'] || '',
                summary: eu['summary'] || '',
                conclusion: ei['conclusion'] || '',
                // 轻量字段：仅返回 rank / direction / level（如果存在）
                globalImportanceRank: giRankMap.get(eventId) || null,
                globalImportanceDirection: giDirectionMap.get(eventId) || null,
                globalImportanceLevel: giLevelMap.get(eventId) || null,
                // 前端展示专用：行业影响摘要（降序 Top5，旧数据无 chain 返回 []）
                chain_summary: extractChainSummary(content),
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

        const row = result.rows[0] as Record<string, unknown>
        const content = (row['content'] as Record<string, unknown>) || {}

        res.json({
            code: 0,
            data: {
                ...row,
                // 顶层补充前端展示专用行业摘要（旧数据无 chain 返回 []，禁止 undefined）
                chain_summary: extractChainSummary(content),
            },
        })
    } catch (err: unknown) {
        console.error('[Public] agent/event/:eventId error:', errMsg(err))
        res.status(500).json({ code: -1, message: 'Internal server error' })
    }
})

// =============================================================================
// 交易日历查询（公开）
// 供前端在"前一天/后一天"跳档时跳过非交易日，以及首页"市场洞见"取最近交易日。
// 工作日历以服务端 TradingCalendarService 为权威（周末 + 官方休市日历），
// 避免前端各自维护节假日表导致不一致。挂 /api/agent/*，与报告查询等公开接口同源。
// =============================================================================

function tradingCalendarDateParam(req: Request): string | undefined {
    const date = queryStr(req, 'date')
    return date && isCalendarDate(date) ? date : undefined
}

/** GET /api/agent/trading-calendar/previous?date=YYYY-MM-DD → 严格早于 date 的前一个交易日 */
publicRouter.get('/trading-calendar/previous', (req: Request, res: Response) => {
    const date = tradingCalendarDateParam(req)
    if (!date) {
        res.status(400).json({ code: -1, message: 'Invalid date parameter' })
        return
    }
    try {
        const prev = TradingCalendarService.getPreviousTradingDay(new Date(`${date}T00:00:00.000Z`))
        res.json({ code: 0, data: prev.toISOString().slice(0, 10) })
    } catch (err: unknown) {
        console.error('[Public] trading-calendar/previous error:', errMsg(err))
        res.status(500).json({ code: -1, message: 'Trading calendar unavailable for this year' })
    }
})

/** GET /api/agent/trading-calendar/next?date=YYYY-MM-DD → 严格晚于 date 的下一个交易日 */
publicRouter.get('/trading-calendar/next', (req: Request, res: Response) => {
    const date = tradingCalendarDateParam(req)
    if (!date) {
        res.status(400).json({ code: -1, message: 'Invalid date parameter' })
        return
    }
    try {
        const next = TradingCalendarService.getNextTradingDay(new Date(`${date}T00:00:00.000Z`))
        res.json({ code: 0, data: next.toISOString().slice(0, 10) })
    } catch (err: unknown) {
        console.error('[Public] trading-calendar/next error:', errMsg(err))
        res.status(500).json({ code: -1, message: 'Trading calendar unavailable for this year' })
    }
})

/** GET /api/agent/trading-calendar/recent?date=YYYY-MM-DD&count=N → 截至 date 最近 N 个交易日（含当天，若当天为交易日） */
publicRouter.get('/trading-calendar/recent', (req: Request, res: Response) => {
    const date = tradingCalendarDateParam(req)
    if (!date) {
        res.status(400).json({ code: -1, message: 'Invalid date parameter' })
        return
    }
    const count = Math.min(Math.max(queryInt(req, 'count', 3), 1), 10)
    try {
        const days = TradingCalendarService.getRecentTradingDays(new Date(`${date}T00:00:00.000Z`), count)
        res.json({ code: 0, data: days.map(d => d.toISOString().slice(0, 10)) })
    } catch (err: unknown) {
        console.error('[Public] trading-calendar/recent error:', errMsg(err))
        res.status(500).json({ code: -1, message: 'Trading calendar unavailable for this year' })
    }
})

/** 标题归一化：去首尾空白 + 去全部空白字符，容忍"标题略有差异"。 */
function normArticleTitle(s: unknown): string {
    return String(s ?? '').replace(/\s+/g, '').trim()
}

/** 将多种日期输入统一规范化为 YYYY-MM-DD；无法解析时返回 ''（绝不抛异常）。
 *
 * 兼容输入：
 *   - node-postgres 对 PG DATE 列默认返回的 JS Date 对象
 *   - "2026-08-25"
 *   - "2026-08-25T08:49:08.719676+08:00"（ISO / 带时区）
 *   - String(Date)：如 "Tue Aug 25 2026 08:00:00 GMT+0800 (中国标准时间)"
 */
function normalizeArticleDate(value: unknown): string {
    if (!value) return ''

    // Date 对象：node-postgres 对 PG DATE 列以本地时区构造（new Date(y, m-1, d)），
    // 必须取本地日期分量，不能用 toISOString()（UTC+8 时区会整体差一天）
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return ''
        const y = value.getFullYear()
        const m = String(value.getMonth() + 1).padStart(2, '0')
        const d = String(value.getDate()).padStart(2, '0')
        return `${y}-${m}-${d}`
    }

    const str = String(value).trim()
    if (!str) return ''

    // 已含 YYYY-MM-DD 前缀（覆盖纯日期 / ISO / 带时区时间戳）
    const dateMatch = str.match(/^(\d{4}-\d{2}-\d{2})/)
    if (dateMatch) return dateMatch[1]

    // 兜底：尝试用 Date 解析（覆盖 String(Date) 等实现相关格式）
    const parsed = new Date(str)
    if (Number.isNaN(parsed.getTime())) return ''
    return parsed.toISOString().slice(0, 10)
}

/**
 * ISO 日期（YYYY-MM-DD）偏移 n 天。
 * 入参非法（无法规范化）时返回 ''，绝不生成 Invalid Date、绝不抛异常。
 */
function shiftArticleDate(isoDate: string, days: number): string {
    const normalized = normalizeArticleDate(isoDate)
    if (!normalized) return ''

    const [y, m, d] = normalized.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d))
    dt.setUTCDate(dt.getUTCDate() + days)

    if (Number.isNaN(dt.getTime())) return ''
    return dt.toISOString().slice(0, 10)
}

/**
 * GET /api/agent/event/:eventId/article
 * 事件原文 — 前端 APP 内展示的源网页正文。
 *
 * 优先级（关键路径改为读库，减少对第三方网页结构的依赖）：
 *   1. 按 eventId 查询 event_conduction 报告，取 content（source 原文 URL 等）。
 *   2. 在 event_scrape 报告中匹配同一事件（匹配窗口：report_date ±1 天），
 *      优先读取 event_scrape.payload.content 已有正文。
 *      - 规则1：source URL 解析 newsId → 匹配 payload.id（财联社 detail/{id}）。
 *      - 规则2：source URL 精确匹配 events[].url。
 *      - 规则3：title 归一化后相等/互相包含（模糊兜底）。
 *      命中但正文为空 → 返回 { code:0, hasContent:false }，不再实时抓取。
 *   3. 仅 event_scrape 完全未命中时，才调 ClsStockNewsService.getNewsFulltext(newsId)
 *      实时兜底；实时失败不影响接口（同样返回 hasContent:false）。
 *   返回统一结构 { title, source, sourceName, publishTime, content, sourceUrl, hasContent }。
 *
 * 无 source 时不渲染正文（422 仅事件级缺失），正文缺失统一走 hasContent:false。
 */
publicRouter.get('/event/:eventId/article', async (req: Request, res: Response) => {
    const eventId = param(req, 'eventId')
    if (!eventId) {
        res.status(400).json({ code: -1, message: 'eventId is required' })
        return
    }

    try {
        const result = await pool.query(
            `SELECT content, report_date, created_at
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

        const content = (result.rows[0]['content'] as Record<string, unknown>) || {}
        const source = String(content['source'] || '').trim()
        // report_date 为 event_conduction 落库日期（必填），仅作兜底偏移计算输入。
        // node-postgres 对 PG DATE 列默认返回 JS Date 对象，必须统一规范化为 YYYY-MM-DD，
        // 否则 String(Date) 形如 "Tue Aug 25 2026 ..." 会让 shiftArticleDate 解析失败抛 RangeError。
        const reportDate = normalizeArticleDate(result.rows[0]['report_date'])
        const hasSource = Boolean(source)

        // 统一正文缺失响应（code:0 + hasContent:false → 前端展示"暂无原文内容"）
        const respondNoContent = (title: unknown) =>
            res.json({
                code: 0,
                data: {
                    title: String(title || content['title'] || ''),
                    source: hasSource ? source : '',
                    sourceName: String(content['source_name'] || ''),
                    publishTime: String(content['publishTime'] || reportDate),
                    content: '',
                    sourceUrl: hasSource ? source : '',
                    hasContent: false,
                },
            })

        // ---- 步骤1：匹配 event_scrape 已有正文 ----
        let matched: { title: string; payloadContent: string } | null = null
        if (hasSource && reportDate) {
            // 日期窗口（report_date ±1 天）；shiftArticleDate 对非法输入返回 ''，需过滤
            const scrapeDates = [
                reportDate,
                shiftArticleDate(reportDate, -1),
                shiftArticleDate(reportDate, 1),
            ].filter((d): d is string => Boolean(d))
            // 日期窗口为空（report_date 异常无法解析）时不构造非法日期查询，安全跳过 event_scrape 匹配
            // PostgreSQL 42P18 修复：node-postgres 把 JS 字符串数组作为单个参数传给 `= ANY($n)` 时，
            // 服务端无法推断参数类型（could not determine data type of parameter），必然抛错导致 500。
            // 改为 IN 标量参数展开（$1,$2,...）——每个日期是独立标量参数，类型由 date 列推断为 date。
            // 同时移除无用的 eventId 参数：event_scrape 按 report_date 分区，SQL 仅需 scrapeDates。
            const placeholders = scrapeDates.map((_, i) => `$${i + 1}`).join(',')
            const scrapeResult =
                placeholders.length > 0
                    ? await pool.query(
                          `SELECT content
                           FROM agent_analysis_reports
                           WHERE report_type = 'event_scrape' AND report_date IN (${placeholders})
                           ORDER BY created_at DESC`,
                          scrapeDates
                      )
                    : { rows: [] as Array<Record<string, unknown>> }

            // 从所有命中行收集 events（不 LIMIT，覆盖跨日窗口内的合并结果）
            const events: Array<Record<string, unknown>> = []
            for (const row of scrapeResult.rows) {
                const c = (row['content'] as Record<string, unknown>) || {}
                const evs = c['events']
                if (!Array.isArray(evs)) continue
                for (const e of evs) {
                    if (e && typeof e === 'object') events.push(e as Record<string, unknown>)
                }
            }

            const newsId = source.match(/cls\.cn\/detail\/(\d+)/)?.[1] ?? null
            const normSourceTitle = normArticleTitle(content['title'])

            // 规则1：newsId 匹配 payload.id（精确，优先级最高）
            if (!matched && newsId) {
                const hit = events.find(
                    (e) =>
                        e['payload'] &&
                        typeof e['payload'] === 'object' &&
                        String((e['payload'] as Record<string, unknown>)['id'] ?? '') === newsId
                )
                if (hit) {
                    matched = {
                        title: String(hit['title'] ?? ''),
                        payloadContent: String(
                            (hit['payload'] && typeof hit['payload'] === 'object'
                                ? (hit['payload'] as Record<string, unknown>)['content']
                                : '') ?? ''
                        ),
                    }
                }
            }

            // 规则2：source 精确匹配 events[].url
            if (!matched) {
                const hit = events.find((e) => String(e['url'] ?? '').trim() === source)
                if (hit) {
                    matched = {
                        title: String(hit['title'] ?? ''),
                        payloadContent: String(
                            (hit['payload'] && typeof hit['payload'] === 'object'
                                ? (hit['payload'] as Record<string, unknown>)['content']
                                : '') ?? ''
                        ),
                    }
                }
            }

            // 规则3：title 归一化模糊匹配（相等或互相包含）
            if (!matched && normSourceTitle) {
                const hit = events.find((e) => {
                    const nEv = normArticleTitle(e['title'])
                    return Boolean(nEv && (nEv === normSourceTitle || nEv.includes(normSourceTitle) || normSourceTitle.includes(nEv)))
                })
                if (hit) {
                    matched = {
                        title: String(hit['title'] ?? ''),
                        payloadContent: String(
                            (hit['payload'] && typeof hit['payload'] === 'object'
                                ? (hit['payload'] as Record<string, unknown>)['content']
                                : '') ?? ''
                        ),
                    }
                }
            }

            // 命中 event_scrape：优先返回已有正文；正文为空则不实时抓取，直接降级
            if (matched) {
                const body = matched.payloadContent.trim()
                res.json({
                    code: 0,
                    data: {
                        title: matched.title || String(content['title'] || ''),
                        source,
                        sourceName: String(content['source_name'] || ''),
                        publishTime: String(content['publishTime'] || reportDate),
                        content: body,
                        sourceUrl: source,
                        hasContent: Boolean(body),
                    },
                })
                return
            }
        }

        // ---- 步骤2：event_scrape 未命中 → 实时抓取兜底（仅财联社 newsId） ----
        if (!hasSource) {
            respondNoContent('')
            return
        }
        const newsId = source.match(/cls\.cn\/detail\/(\d+)/)?.[1]
        if (!newsId) {
            // 非财联社且 event_scrape 无命中 → 暂无原文
            respondNoContent('')
            return
        }
        try {
            const fulltext = await ClsStockNewsService.getNewsFulltext(newsId)
            if (fulltext && fulltext.content) {
                res.json({
                    code: 0,
                    data: {
                        title: fulltext.title || String(content['title'] || ''),
                        source,
                        sourceName: String(content['source_name'] || ''),
                        publishTime: String(content['publishTime'] || reportDate),
                        content: fulltext.content,
                        sourceUrl: source,
                        hasContent: true,
                    },
                })
                return
            }
        } catch (err: unknown) {
            // 实时抓取失败不影响接口正常返回
            console.error(`[Public] agent/event/:eventId/article fulltext error:`, errMsg(err))
        }
        respondNoContent('')
    } catch (err: unknown) {
        console.error('[Public] agent/event/:eventId/article error:', errMsg(err))
        res.status(500).json({ code: -1, message: 'Internal server error' })
    }
})

export { publicRouter, getAnalysisReport }

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

/**
 * POST /internal/mail/notify
 * 迭代完成通知邮件（2026-09-02）：agent-py 在 iterate 报告持久化后调用。
 * SMTP：优先独立 QQ 通道（ITERATE_SMTP_*，收件 ITERATE_MAIL_TO），否则回退 EMAIL_SMTP_* 与 EMAIL_FROM。
 * 未配置收件/发件不抛错 → 返回 sent:false（agent 侧仅记日志，不阻断迭代链路）。
 * body: { report_type?, report_date?, summary? }
 */
router.post('/mail/notify', async (req: Request, res: Response) => {
    try {
        const body = (req.body ?? {}) as Record<string, unknown>
        const reportType = typeof body.report_type === 'string' && body.report_type ? body.report_type : 'iterate'
        const reportDate = typeof body.report_date === 'string' ? body.report_date : ''
        const summary = typeof body.summary === 'string' ? body.summary : ''
        const to = (process.env.ITERATE_MAIL_TO ?? process.env.EMAIL_FROM ?? '').trim()
        const subject = `【AI迭代完成】${reportType}${reportDate ? ` ${reportDate}` : ''}`
        const text = [
            `${reportType} 迭代报告已生成。`,
            reportDate ? `日期：${reportDate}` : '',
            summary ? `\n摘要：\n${summary}` : '',
            `\n详情请前往 App 查看。`,
        ].filter(Boolean).join('\n')

        if (!to) {
            console.log('[Internal] mail/notify skipped: ITERATE_MAIL_TO / EMAIL_FROM 未配置')
            return res.json({ code: 0, data: { sent: false, reason: 'recipient not configured' } })
        }
        const smtpPort = Number(process.env.ITERATE_SMTP_PORT ?? 0)
        const overrides = process.env.ITERATE_SMTP_USER
            ? {
                  host: process.env.ITERATE_SMTP_HOST || 'smtp.qq.com',
                  port: smtpPort || 465,
                  user: process.env.ITERATE_SMTP_USER,
                  pass: process.env.ITERATE_SMTP_PASS ?? '',
                  from: process.env.ITERATE_SMTP_USER,
              }
            : undefined
        await EmailService.sendPlain(subject, text, to, overrides)
        res.json({ code: 0, data: { sent: true, to } })
    } catch (err: unknown) {
        console.error('[Internal] mail/notify error:', errMsg(err))
        res.status(502).json({ code: 502, message: errMsg(err) })
    }
})

export default router
