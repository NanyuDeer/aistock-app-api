/**
 * TencentSnapshotService — 15:30 收盘后基于腾讯实时行情构建简版收盘快照。
 *
 * 设计要点：
 * - 核心数据（6 大指数）严格失败，非核心（宽度/概念流）宽松失败
 * - 批量拉取 50 只/批，10 批并发
 * - 涨跌停为近似值（阈值判断），标记 limit_count_approximate=true
 * - 使用 QuickCloseMarketSnapshot 契约，snapshot_kind='quick'
 */

import { TencentQuoteService } from './TencentQuoteService'
import { EmSnapshotService } from './EmSnapshotService'
import {
    getStockBasicBulk,
    getCompleteDailyByDate,
} from './TushareService'
import {
    isAtOrAfterClose,
    toCoverageSummary,
    sumAmountYuan,
    type CloseIndexFact,
    type SectorFact,
    type QuickCloseMarketSnapshot,
    type QuickDataAvailability,
    type MarketBreadth,
    type DailyCoverageSummary,
    type QuickSnapshotCoverage,
    type QuickSnapshotDataAvailability,
} from './MarketSnapshotService'
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService'
import { shanghaiDateStr } from '../../shared/utils/shanghaiTime'

// 概念板块 Top N（领涨/领跌），与 full 版 selectTopSectors 的 TOP_SECTOR_COUNT 保持一致
const TOP_SECTOR_COUNT = 5

/** 腾讯行情中心板块排行接口（rank/pt/getRank，实时数据，15:30 收盘后立即可用）。 */
const BOARD_RANK_URL = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank'
const BOARD_RANK_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    Referer: 'https://stockapp.finance.qq.com/',
}

/** 腾讯板块排行返回的单条板块记录（仅声明用到的最小字段）。 */
export interface TencentBoardRankItem {
    code?: string
    name?: string
    zdf?: string // 今日涨跌幅 %
    zljlr?: string // 主力净流入（万元）
    lzg?: { name?: string; zdf?: string } // 领涨股
}

/** 板块排行拉取结果（含可用性标注，宽松失败不抛异常）。 */
export interface TencentBoardRankingResult {
    gainers: SectorFact[]
    losers: SectorFact[]
    availability: QuickDataAvailability
}

/** 主力资金（腾讯行业板块 zljlr 求和近似）拉取结果。 */
export interface TencentMainForceResult {
    large_and_extra_large_net_yuan: number | null
    availability: QuickDataAvailability
}

// 6 大指数代码（腾讯格式）
const INDEX_CODES = [
    'sh000001', // 上证指数
    'sh000300', // 沪深300
    'sh000016', // 上证50
    'sz399001', // 深证成指
    'sz399006', // 创业板指
    'sz399303', // 国证2000
]

// 指数名称映射
const INDEX_NAMES: Record<string, string> = {
    'sh000001': '上证指数',
    'sh000300': '沪深300',
    'sh000016': '上证50',
    'sz399001': '深证成指',
    'sz399006': '创业板指',
    'sz399303': '国证2000',
}

/** 腾讯指数代码到 Tushare 标准 ts_code 的映射。 */
const INDEX_TS_CODES: Record<string, string> = {
    'sh000001': '000001.SH',
    'sh000300': '000300.SH',
    'sh000016': '000016.SH',
    'sz399001': '399001.SZ',
    'sz399006': '399006.SZ',
    'sz399303': '399303.SZ',
}

const BATCH_SIZE = 50
const BATCH_CONCURRENCY = 10
const MAX_RETRIES = 3

/** 涨跌停阈值：主板 ±10%，创业板/科创板 ±20% */
function getLimitThreshold(code: string): number {
    if (code.startsWith('sz300') || code.startsWith('sh688')) return 20
    return 10
}

/** 腾讯行情行（中文键名，与 TencentQuoteService.getBatchQuotes 返回一致） */
type TencentQuoteRow = Record<string, unknown>

function toNumber(val: unknown): number {
    const n = Number(val)
    return Number.isFinite(n) ? n : 0
}

function toFiniteNumber(val: unknown): number | undefined {
    if (val === null || (typeof val === 'string' && val.trim() === '')) return undefined
    const n = Number(val)
    return Number.isFinite(n) ? n : undefined
}

export interface TencentBreadthFetchResult {
    breadth?: MarketBreadth
    availability: QuickDataAvailability
}

export class TencentSnapshotService {
    /**
     * 构建 quick snapshot（15:30 收盘后立即可用）。
     *
     * 核心数据（指数）失败 → 整体抛出。
     * 非核心数据（宽度/概念流）失败 → partial snapshot，coverage 标记 false。
     */
    static async buildQuickSnapshot(nowOverride?: Date): Promise<QuickCloseMarketSnapshot> {
        const now = nowOverride ?? new Date()

        const tradeDate = shanghaiDateStr(now)
        const tushareTradeDate = tradeDate.replace(/-/g, '')

        // 非交易日（周末/节假日）即使已过 15:30 也不得返回快照：腾讯返回最近收盘，
        // 若以当天日期标注会冒充"今日已收盘"（红线）。必须先于时钟门禁校验交易日。
        if (!TradingCalendarService.isTradingDayYyyymmdd(tushareTradeDate)) {
            const err = new Error('market_not_closed: not an A-share trading day')
            err.name = 'MarketSnapshotUnavailable'
            throw err
        }

        if (!isAtOrAfterClose(now)) {
            const err = new Error('market_not_closed: before 15:30 Shanghai time')
            err.name = 'MarketSnapshotUnavailable'
            throw err
        }

        const capturedAt = now.toISOString()

        // 1. 核心数据：6 大指数（严格失败）
        const indexes = await this.fetchIndexes()

        // 2. 非核心数据（宽松失败，每项独立 settled，任何单项缺失都必须显式标注，不得用中性数值伪造事实）。
        //
        // 数据源策略（design: 2026-08-20-ths-snapshot-source-swap-design.md）：
        // - limits 主源=东财 push2ex 涨跌停/炸板池（精确 count + 连板），腾讯阈值近似仅兜底；
        // - sectors/main_force 主源=东财 push2 板块资金流，腾讯行情中心板块排行（rank/pt/getRank）兜底；
        // - breadth/turnover（全市场宽度/成交额）固定保留腾讯（无免逆向全市场逐股替代源）。
        const [breadthResult, emLimitsResult, emSectorsResult, emMainForceResult, tSectorsResult, tMainForceResult] =
            await Promise.allSettled([
                this.fetchMarketBreadth(),
                EmSnapshotService.getLimitPools(tushareTradeDate),
                EmSnapshotService.getConceptFlow(),
                EmSnapshotService.getIndustryMainForce(),
                this.fetchTencentSectors(),
                this.fetchTencentMainForce(),
            ])

        const marketBreadth: MarketBreadth | undefined =
            breadthResult.status === 'fulfilled' ? breadthResult.value.breadth : undefined

        // ---- limits：东财精确池为主，腾讯阈值近似兜底 ----
        const emLimits = emLimitsResult.status === 'fulfilled' ? emLimitsResult.value : null
        let limits: QuickCloseMarketSnapshot['limits'] = {
            up_count: null,
            down_count: null,
            broken_count: null,
            highest_board: null,
        }
        let limitsAvailability: QuickDataAvailability
        if (emLimits && emLimits.availability.state !== 'unavailable') {
            // 东财池精确 count（含连板 lbc）；任一子池失败时字段保持 null，availability 如实标注 partial
            limits = {
                up_count: emLimits.up_count,
                down_count: emLimits.down_count,
                broken_count: emLimits.broken_count,
                highest_board: emLimits.highest_board,
            }
            limitsAvailability = emLimits.availability
        } else if (marketBreadth !== undefined) {
            // 兜底：腾讯阈值近似（±10%/±20%），炸板/连板无近似值，保持 null
            limits = {
                up_count: marketBreadth.limit_up_count,
                down_count: marketBreadth.limit_down_count,
                broken_count: null,
                highest_board: null,
            }
            limitsAvailability = {
                state: 'partial',
                available_fields: ['up_count', 'down_count'],
                approximate: true,
            }
        } else {
            limitsAvailability = { state: 'unavailable', reason: 'both eastmoney pools and Tencent breadth unavailable; limit counts cannot be estimated' }
        }

        // ---- sectors：东财概念资金流为主（含涨跌+净额排序），腾讯板块排行兜底（仅涨跌） ----
        const emSectors = emSectorsResult.status === 'fulfilled' ? emSectorsResult.value : null
        const tencentSectors: TencentBoardRankingResult = tSectorsResult.status === 'fulfilled'
            ? tSectorsResult.value
            : { gainers: [], losers: [], availability: { state: 'unavailable', reason: 'Tencent board rank fetch failed' } }

        const emSectorsHaveData = emSectors !== null
            && (emSectors.gainers.length > 0 || emSectors.losers.length > 0
                || emSectors.inflows.length > 0 || emSectors.outflows.length > 0)
        const tencentSectorsHaveData = tencentSectors.gainers.length > 0 || tencentSectors.losers.length > 0

        let sectors: QuickCloseMarketSnapshot['sectors'] = {
            top_gainers: [],
            top_losers: [],
            top_inflows: [],
            top_outflows: [],
        }
        let sectorsAvailability: QuickDataAvailability
        if (emSectorsHaveData) {
            sectors = {
                top_gainers: emSectors!.gainers,
                top_losers: emSectors!.losers,
                top_inflows: emSectors!.inflows,
                top_outflows: emSectors!.outflows,
            }
            sectorsAvailability = emSectors!.availability
        } else if (tencentSectorsHaveData) {
            sectors = {
                top_gainers: tencentSectors.gainers,
                top_losers: tencentSectors.losers,
                top_inflows: [],
                top_outflows: [],
            }
            sectorsAvailability = tencentSectors.availability
        } else {
            sectorsAvailability = { state: 'unavailable', reason: 'both eastmoney concept flow and Tencent board rank returned no sectors' }
        }

        // ---- main_force：东财行业主力净额为主，腾讯行业板块求和近似兜底 ----
        const emMainForce = emMainForceResult.status === 'fulfilled' ? emMainForceResult.value : null
        const tencentMainForce: TencentMainForceResult = tMainForceResult.status === 'fulfilled'
            ? tMainForceResult.value
            : { large_and_extra_large_net_yuan: null, availability: { state: 'unavailable', reason: 'Tencent main-force fetch failed' } }

        let mainForce: QuickCloseMarketSnapshot['main_force']
        let mainForceAvailability: QuickDataAvailability
        if (emMainForce && emMainForce.large_and_extra_large_net_yuan !== null) {
            mainForce = {
                large_and_extra_large_net_yuan: emMainForce.large_and_extra_large_net_yuan,
                source: 'eastmoney:industry_main_force',
            }
            mainForceAvailability = { state: 'available' }
        } else if (tencentMainForce.large_and_extra_large_net_yuan !== null) {
            mainForce = {
                large_and_extra_large_net_yuan: tencentMainForce.large_and_extra_large_net_yuan,
                source: 'tencent:board_main_flow',
                approximate: true,
            }
            mainForceAvailability = { state: 'available' }
        } else {
            // 双源均不可用：值保持 null，source 标记腾讯兜底路由（与旧 quick 一致，null 值无精确口径）。
            mainForce = {
                large_and_extra_large_net_yuan: null,
                source: 'tencent:board_main_flow',
            }
            mainForceAvailability = emMainForce?.availability
                ?? { state: 'unavailable', reason: 'both eastmoney and Tencent main-force unavailable' }
        }

        const hasSectors = sectors.top_gainers.length > 0 || sectors.top_losers.length > 0
            || sectors.top_inflows.length > 0 || sectors.top_outflows.length > 0
        const hasMainForce = mainForce.large_and_extra_large_net_yuan !== null

        const coverage: QuickSnapshotCoverage = {
            // limits 主源为东财精确池；available/partial 均视为已具备涨跌停池（partial 时字段部分为 null）
            has_limit_pool: emLimits !== null && emLimits.availability.state !== 'unavailable',
            has_moneyflow: hasMainForce,
            has_concept_flow: hasSectors,
        }

        const quickDataAvailability: QuickSnapshotDataAvailability = {
            breadth: breadthResult.status === 'fulfilled'
                ? breadthResult.value.availability
                : { state: 'unavailable', reason: 'Tencent market breadth fetch failed' },
            // 成交额：由全市场行情行“成交额”聚合（万元→元），腾讯源近似，非 Tushare 精确口径。
            turnover: breadthResult.status === 'fulfilled'
                && breadthResult.value.breadth !== undefined
                && breadthResult.value.breadth.total_amount_yuan > 0
                ? { state: 'partial', available_fields: ['amount_yuan'], approximate: true }
                : { state: 'unavailable', reason: 'Tencent quick rows do not establish a yuan-denominated aggregate turnover amount' },
            limits: limitsAvailability,
            sectors: sectorsAvailability,
            main_force: mainForceAvailability,
        }

        // 3. previous_daily：前日完整日线来自 Tushare（前日已收盘就绪，不受 16 点即时性限制）。
        //    为什么在此强取并 fail-loud：quick 改进版欲替代 full，需与 full 同样满足
        //    coverage.previous_daily.complete==True 的硬门槛（编排缺口 #3）。前日数据缺失即抛错，
        //    由上层按 502/market_not_closed 语义处理，不伪造"已收盘"。
        const previousTradeDate = TradingCalendarService.getPreviousTradingDay(now)
        const prevYyyymmdd = shanghaiDateStr(previousTradeDate).replace(/-/g, '')
        const previousDaily = await __tencentSnapshotDeps.getCompleteDailyByDate(prevYyyymmdd)
        if (!previousDaily.complete) {
            throw new Error(
                `market_not_closed: previous daily coverage incomplete (${previousDaily.reason})`,
            )
        }
        const previousCoverage: DailyCoverageSummary = toCoverageSummary(previousDaily)
        const previousAmountYuan = sumAmountYuan(previousDaily.rows)

        return this.assembleSnapshot(
            tradeDate,
            capturedAt,
            indexes,
            marketBreadth,
            limits,
            coverage,
            previousCoverage,
            previousAmountYuan,
            sectors,
            mainForce,
            quickDataAvailability,
        )
    }

    /** 拉 6 大指数（一次批量请求）。失败抛异常。 */
    static async fetchIndexes(): Promise<CloseIndexFact[]> {
        const quotes = await TencentQuoteService.getBatchQuotes(INDEX_CODES, 'activity')
        const indexes: CloseIndexFact[] = []

        for (const code of INDEX_CODES) {
            const row = quotes.find((q) => q['股票代码'] === code)
            if (!row || Object.prototype.hasOwnProperty.call(row, '错误')) {
                throw new Error(`index ${code} quote failed`)
            }
            indexes.push({
                ts_code: INDEX_TS_CODES[code],
                name: String(row['股票简称'] ?? INDEX_NAMES[code] ?? code),
                trade_date: '', // 由 assembleSnapshot 填充
                close: toNumber(row['最新价']),
                pct_chg: toNumber(row['涨跌幅']),
                amount: toNumber(row['成交额']),
                source: 'tushare:index_daily',
            })
        }

        return indexes
    }

    /**
     * 拉全市场宽度（分批并发）。
     * 从活跃 SH/SZ stock_basic 列表映射腾讯代码后调用 getBatchQuotes。
     */
    static async fetchMarketBreadth(): Promise<TencentBreadthFetchResult> {
        const stockBasics = await __tencentSnapshotDeps.getStockBasicBulk()
        const allCodes = stockBasics.flatMap(({ ts_code }) => {
            const match = ts_code.match(/^(\d{6})\.(SH|SZ)$/)
            if (!match) return []
            return [`${match[2] === 'SH' ? 'sh' : 'sz'}${match[1]}`]
        })
        const quotes: TencentQuoteRow[] = []

        // 分批拉取，BATCH_CONCURRENCY 批并发
        for (let i = 0; i < allCodes.length; i += BATCH_SIZE * BATCH_CONCURRENCY) {
            const batchGroup: Promise<Record<string, any>[]>[] = []
            for (let j = 0; j < BATCH_CONCURRENCY && i + j * BATCH_SIZE < allCodes.length; j++) {
                const batch = allCodes.slice(i + j * BATCH_SIZE, i + (j + 1) * BATCH_SIZE)
                batchGroup.push(TencentQuoteService.getBatchQuotes(batch, 'activity'))
            }
            const results = await Promise.all(batchGroup)
            for (const batch of results) {
                for (const row of batch) {
                    quotes.push(row as TencentQuoteRow)
                }
            }
        }

        const quoteByCode = new Map<string, TencentQuoteRow>()
        for (const quote of quotes) {
            const code = String(quote['股票代码'] ?? '')
            if (allCodes.includes(code) && !quoteByCode.has(code)) quoteByCode.set(code, quote)
        }
        if (allCodes.length === 0 || allCodes.some((code) => {
            const quote = quoteByCode.get(code)
            return !quote || Object.prototype.hasOwnProperty.call(quote, '错误')
        })) {
            return {
                availability: {
                    state: 'unavailable',
                    reason: 'Tencent activity quote batch coverage is incomplete',
                },
            }
        }
        if (allCodes.some((code) => {
            const quote = quoteByCode.get(code)!
            return toFiniteNumber(quote['涨跌幅']) === undefined || toFiniteNumber(quote['成交量']) === undefined
        })) {
            return {
                availability: {
                    state: 'partial',
                    available_fields: [],
                    reason: allCodes.some((code) => toFiniteNumber(quoteByCode.get(code)!['涨跌幅']) === undefined)
                        ? 'Tencent activity rows contain missing or non-numeric 涨跌幅'
                        : 'Tencent activity rows contain missing or non-numeric 成交量',
                },
            }
        }
        return {
            breadth: this.calculateBreadth(allCodes.map((code) => quoteByCode.get(code)!)),
            availability: { state: 'available' },
        }
    }

    /** 从行情行计算全市场宽度。 */
    static calculateBreadth(quotes: TencentQuoteRow[]): MarketBreadth {
        let advance = 0, decline = 0, flat = 0
        let limitUp = 0, limitDown = 0
        let totalVolume = 0
        let totalChangePct = 0
        let totalAmountYuan = 0
        let validCount = 0

        for (const q of quotes) {
            if (Object.prototype.hasOwnProperty.call(q, '错误')) continue
            const code = String(q['股票代码'] ?? '')
            if (!code) continue
            const changePct = toFiniteNumber(q['涨跌幅'])
            if (changePct === undefined) {
                throw new Error('Tencent activity row has missing or non-numeric 涨跌幅')
            }
            const volume = toFiniteNumber(q['成交量'])
            if (volume === undefined) {
                throw new Error('Tencent activity row has missing or non-numeric 成交量')
            }

            if (changePct > 0) advance++
            else if (changePct < 0) decline++
            else flat++

            const threshold = getLimitThreshold(code)
            if (changePct >= threshold) limitUp++
            if (changePct <= -threshold) limitDown++

            totalVolume += volume
            totalChangePct += changePct
            totalAmountYuan += toFiniteNumber(q['成交额']) ?? 0
            validCount++
        }

        return {
            total_count: validCount,
            advance_count: advance,
            decline_count: decline,
            flat_count: flat,
            limit_up_count: limitUp,
            limit_down_count: limitDown,
            limit_count_approximate: true,
            total_volume: totalVolume,
            avg_change_pct: validCount > 0 ? totalChangePct / validCount : 0,
            total_amount_yuan: totalAmountYuan,
        }
    }

    /** 拉取腾讯行情中心板块排行（rank/pt/getRank）。失败抛异常，由调用方 settled 兜底。 */
    static async fetchTencentBoardRank(
        boardType: 'gn' | 'hy' | 'hy2',
        direct: 'down' | 'up',
        count: number,
    ): Promise<TencentBoardRankItem[]> {
        const params = new URLSearchParams({
            board_type: boardType,
            sort_type: 'priceRatio',
            direct,
            offset: '0',
            count: String(count),
        })
        const res = await fetch(`${BOARD_RANK_URL}?${params.toString()}`, { headers: BOARD_RANK_HEADERS })
        if (!res.ok) throw new Error(`Tencent board rank HTTP ${res.status}`)
        const body = (await res.json()) as { code: number; data?: { rank_list?: TencentBoardRankItem[] } }
        if (body.code !== 0 || !Array.isArray(body.data?.rank_list)) {
            throw new Error(`Tencent board rank failed: code=${body.code}`)
        }
        return body.data.rank_list
    }

    /** 把腾讯板块行映射为 SectorFact（zdf→pct_change、zljlr 万元→元）。 */
    static toSectorFact(item: TencentBoardRankItem): SectorFact {
        return {
            ts_code: String(item.code ?? ''),
            name: String(item.name ?? ''),
            pct_change: toNumber(item.zdf),
            net_amount: Math.round(toNumber(item.zljlr) * 10000),
            lead_stock: String(item.lzg?.name ?? ''),
            company_num: 0,
            trade_date: '',
        }
    }

    /** 概念板块领涨/领跌（腾讯 rank/pt/getRank，替代 Tushare moneyflow_cnt_ths）。 */
    static async fetchTencentSectors(): Promise<TencentBoardRankingResult> {
        const [gainersResult, losersResult] = await Promise.allSettled([
            TencentSnapshotService.fetchTencentBoardRank('gn', 'down', TOP_SECTOR_COUNT),
            TencentSnapshotService.fetchTencentBoardRank('gn', 'up', TOP_SECTOR_COUNT),
        ])
        const gainers = gainersResult.status === 'fulfilled'
            ? gainersResult.value.map(TencentSnapshotService.toSectorFact)
            : []
        const losers = losersResult.status === 'fulfilled'
            ? losersResult.value.map(TencentSnapshotService.toSectorFact)
            : []
        if (gainers.length === 0 && losers.length === 0) {
            return {
                gainers,
                losers,
                availability: { state: 'unavailable', reason: 'Tencent board rank returned no sector rows' },
            }
        }
        return { gainers, losers, availability: { state: 'available' } }
    }

    /**
     * 全市场主力净额近似：腾讯行业一级板块（hy）主力净流入 zljlr 求和（万元→元）。
     * 行业一级板块对全市场个股做划分，求和结果近似全市场主力净额（与旧版
     * "概念板块净流入合计近似主力"同一思路，但改自实时腾讯源）。
     */
    static async fetchTencentMainForce(): Promise<TencentMainForceResult> {
        try {
            const boards = await TencentSnapshotService.fetchTencentBoardRank('hy', 'down', 200)
            if (boards.length === 0) {
                return {
                    large_and_extra_large_net_yuan: null,
                    availability: { state: 'unavailable', reason: 'Tencent industry board rank returned no rows' },
                }
            }
            let totalWan = 0
            for (const board of boards) {
                totalWan += toNumber(board.zljlr)
            }
            return {
                large_and_extra_large_net_yuan: Math.round(totalWan * 10000),
                availability: { state: 'available' },
            }
        } catch (e) {
            return {
                large_and_extra_large_net_yuan: null,
                availability: { state: 'unavailable', reason: 'Tencent industry board main-flow fetch failed' },
            }
        }
    }

    /** 组装最终 snapshot。 */
    static assembleSnapshot(
        tradeDate: string,
        capturedAt: string,
        indexes: CloseIndexFact[],
        marketBreadth: MarketBreadth | undefined,
        limits: QuickCloseMarketSnapshot['limits'],
        coverage: QuickSnapshotCoverage,
        previousCoverage: DailyCoverageSummary,
        previousAmountYuan: number,
        sectors: QuickCloseMarketSnapshot['sectors'],
        mainForce: QuickCloseMarketSnapshot['main_force'],
        quickDataAvailability: QuickSnapshotDataAvailability,
    ): QuickCloseMarketSnapshot {
        // 填充 indexes 的 trade_date
        const filledIndexes = indexes.map((idx) => ({ ...idx, trade_date: tradeDate.replace(/-/g, '') }))

        // 成交额环比：当日为腾讯近似（tencent:quote），前日为 Tushare 精确（tushare:daily）。
        // source 保留 tencent:quote（当日口径）；previous_amount_yuan 来自 Tushare 前日（编排缺口 #3）。
        const amountYuan = marketBreadth?.total_amount_yuan ?? 0
        const changePct = previousAmountYuan > 0
            ? Number((((amountYuan - previousAmountYuan) / previousAmountYuan) * 100).toFixed(2))
            : null

        return {
            schema_version: '1.0',
            status: 'complete',
            trade_date: tradeDate.replace(/-/g, ''),
            captured_at: capturedAt,
            indexes: filledIndexes,
            // full snapshot 的字段填默认值（quick 版不提供）
            breadth: {
                total_count: marketBreadth?.total_count ?? null,
                advance_count: marketBreadth?.advance_count ?? null,
                decline_count: marketBreadth?.decline_count ?? null,
                flat_count: marketBreadth?.flat_count ?? null,
                advance_ratio: marketBreadth && marketBreadth.total_count > 0
                    ? marketBreadth.advance_count / marketBreadth.total_count
                    : null,
                source: 'tencent:quote',
            },
            turnover: marketBreadth && marketBreadth.total_amount_yuan > 0
                ? {
                    amount_yuan: marketBreadth.total_amount_yuan,
                    previous_amount_yuan: previousAmountYuan,
                    change_pct: changePct,
                    source: 'tencent:quote',
                    approximate: true,
                }
                : { amount_yuan: null, previous_amount_yuan: null, change_pct: null, source: 'tushare:daily' },
            // limits 由调用方注入（东财精确池或腾讯近似兜底），不再从 marketBreadth 内部推导
            limits,
            sectors,
            main_force: mainForce,
            coverage: {
                current_daily: { complete: false, reason: 'empty' as const, page_count: 0, row_count: 0 },
                previous_daily: previousCoverage,
            },
            // quick snapshot 扩展字段
            snapshot_kind: 'quick',
            coverage_info: coverage,
            quick_data_availability: quickDataAvailability,
            market_breadth: marketBreadth,
        }
    }
}

/** 依赖注入接口（测试可替换 stock_basic / 前日完整日线数据源）。 */
export interface TencentSnapshotDeps {
    getStockBasicBulk: typeof getStockBasicBulk
    getCompleteDailyByDate: typeof getCompleteDailyByDate
}

/** 生产环境默认实现：复用 Tushare 活跃股票列表与前日完整日线。 */
export const __tencentSnapshotDeps: TencentSnapshotDeps = {
    getStockBasicBulk,
    getCompleteDailyByDate,
}
