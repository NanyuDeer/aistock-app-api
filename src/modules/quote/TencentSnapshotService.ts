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
import {
    getMoneyflowCntThs,
    getMoneyflowThsByDate,
    getStockBasicBulk,
    type MoneyflowCntThsRow,
    type MoneyflowThsRow,
} from './TushareService'
import {
    isAtOrAfterClose,
    type CloseIndexFact,
    computeMainForceNetYuan,
    hasCompleteMainForceFields,
    type QuickCloseMarketSnapshot,
    type QuickDataAvailability,
    type MarketBreadth,
    type QuickSnapshotCoverage,
    type QuickSnapshotDataAvailability,
} from './MarketSnapshotService'
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService'

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

        const tradeDate = formatShanghaiDate(now)
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

        // 2. 非核心数据：全市场宽度、概念板块、主力资金（宽松失败）
        // 每项独立 settled，任何单项缺失都必须显式标注，不得用中性数值伪造事实。
        const [breadthResult, conceptFlowResult, mainForceResult] = await Promise.allSettled([
            this.fetchMarketBreadth(),
            this.fetchConceptFlow(tushareTradeDate),
            __tencentSnapshotDeps.getMoneyflowThsByDate(tushareTradeDate),
        ])

        const marketBreadth: MarketBreadth | undefined =
            breadthResult.status === 'fulfilled' ? breadthResult.value.breadth : undefined

        const conceptFlow: MoneyflowCntThsRow[] =
            conceptFlowResult.status === 'fulfilled' ? conceptFlowResult.value : []

        const mainForceRows: MoneyflowThsRow[] | undefined =
            mainForceResult.status === 'fulfilled' && mainForceResult.value.length > 0
                ? mainForceResult.value
                : undefined
        // hasMainForce 需同时满足「有数据」且「大单/特大单字段完整」。
        // Tushare moneyflow_ths 收盘后分批发回，可能出现 buy_lg_amount 有值、
        // 但 buy_elg_amount/sell_lg_amount/sell_elg_amount 为 undefined 的部分数据，
        // 此时直接用 computeMainForceNetYuan 会得到 NaN（JSON 序列化为 null），
        // 必须降级到概念板块近似（partial）或标记 unavailable，不能返回 available+null。
        const hasMainForce = mainForceRows !== undefined && hasCompleteMainForceFields(mainForceRows)
        const hasConceptFlow = conceptFlowResult.status === 'fulfilled' && conceptFlow.length > 0

        const coverage: QuickSnapshotCoverage = {
            has_limit_pool: false,
            has_moneyflow: hasMainForce,
            has_concept_flow: hasConceptFlow,
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
            limits: marketBreadth !== undefined
                ? {
                    state: 'partial',
                    available_fields: ['up_count', 'down_count'],
                    approximate: true,
                }
                : { state: 'unavailable', reason: 'Tencent breadth unavailable; limit counts cannot be estimated' },
            sectors: hasConceptFlow
                ? { state: 'available' }
                : conceptFlowResult.status === 'fulfilled'
                    ? { state: 'unavailable', reason: 'Concept-flow fetch returned no sector rows' }
                    : { state: 'unavailable', reason: 'Tencent quick concept-flow fetch failed' },
            main_force: hasMainForce
                ? { state: 'available' }
                : hasConceptFlow
                    ? {
                        state: 'partial',
                        available_fields: ['large_and_extra_large_net_yuan'],
                        approximate: true,
                        reason: 'moneyflow_ths unavailable; approximated from concept-flow net_amount',
                    }
                    : { state: 'unavailable', reason: 'After-close main-force moneyflow is unavailable or empty' },
        }

        return this.assembleSnapshot(
            tradeDate,
            capturedAt,
            indexes,
            marketBreadth,
            coverage,
            conceptFlow,
            mainForceRows,
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

    /** 概念板块资金流（复用 TushareService；失败由 settled 调用方显式标注）。 */
    static async fetchConceptFlow(tradeDate: string): Promise<MoneyflowCntThsRow[]> {
        return getMoneyflowCntThs(tradeDate)
    }

    /** 组装最终 snapshot。 */
    static assembleSnapshot(
        tradeDate: string,
        capturedAt: string,
        indexes: CloseIndexFact[],
        marketBreadth: MarketBreadth | undefined,
        coverage: QuickSnapshotCoverage,
        conceptFlow: MoneyflowCntThsRow[] = [],
        mainForceRows: MoneyflowThsRow[] | undefined,
        quickDataAvailability: QuickSnapshotDataAvailability,
    ): QuickCloseMarketSnapshot {
        // 填充 indexes 的 trade_date
        const filledIndexes = indexes.map((idx) => ({ ...idx, trade_date: tradeDate.replace(/-/g, '') }))

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
                    previous_amount_yuan: null,
                    change_pct: null,
                    source: 'tencent:quote',
                    approximate: true,
                }
                : { amount_yuan: null, previous_amount_yuan: null, change_pct: null, source: 'tushare:daily' },
            limits: {
                up_count: marketBreadth?.limit_up_count ?? null,
                down_count: marketBreadth?.limit_down_count ?? null,
                broken_count: null,
                highest_board: null,
            },
            sectors: selectQuickSectors(conceptFlow),
            main_force: mainForceRows && hasCompleteMainForceFields(mainForceRows)
                ? {
                    large_and_extra_large_net_yuan: computeMainForceNetYuan(mainForceRows),
                    source: 'tushare:moneyflow_ths',
                }
                : conceptFlow.length > 0
                    ? {
                        // moneyflow_ths 收盘前不可用时，用概念板块净流入合计近似主力净额
                        // （net_amount 单位亿元 → 元；概念板块互有重叠，仅作方向性参考）。
                        large_and_extra_large_net_yuan: conceptFlow.reduce(
                            (sum, row) => sum + (Number(row.net_amount) || 0), 0,
                        ) * 1e8,
                        source: 'tushare:moneyflow_cnt_ths',
                        approximate: true,
                    }
                    : { large_and_extra_large_net_yuan: null, source: 'tushare:moneyflow_ths' },
            coverage: {
                current_daily: { complete: false, reason: 'empty' as const, page_count: 0, row_count: 0 },
                previous_daily: { complete: false, reason: 'empty' as const, page_count: 0, row_count: 0 },
            },
            // quick snapshot 扩展字段
            snapshot_kind: 'quick',
            coverage_info: coverage,
            quick_data_availability: quickDataAvailability,
            market_breadth: marketBreadth,
        }
    }
}

/** 依赖注入接口（测试可替换 stock_basic 数据源）。 */
export interface TencentSnapshotDeps {
    getStockBasicBulk: typeof getStockBasicBulk
    getMoneyflowThsByDate: typeof getMoneyflowThsByDate
}

/** 生产环境默认实现：复用 Tushare 活跃股票列表。 */
export const __tencentSnapshotDeps: TencentSnapshotDeps = {
    getStockBasicBulk,
    getMoneyflowThsByDate,
}

const TOP_SECTOR_COUNT = 5

function toQuickSectorFact(row: MoneyflowCntThsRow): QuickCloseMarketSnapshot['sectors']['top_gainers'][number] {
    return {
        ts_code: row.ts_code,
        name: row.name,
        pct_change: row.pct_change,
        net_amount: row.net_amount,
        lead_stock: row.lead_stock,
        company_num: row.company_num,
        trade_date: row.trade_date,
    }
}

/** 保留成功获取的概念资金流，并按涨跌与净流入分别排序。 */
function selectQuickSectors(rows: MoneyflowCntThsRow[]): QuickCloseMarketSnapshot['sectors'] {
    const byPctDesc = [...rows].sort((a, b) => b.pct_change - a.pct_change)
    const byPctAsc = [...rows].sort((a, b) => a.pct_change - b.pct_change)
    const byNetDesc = [...rows].sort((a, b) => b.net_amount - a.net_amount)
    const byNetAsc = [...rows].sort((a, b) => a.net_amount - b.net_amount)
    return {
        top_gainers: byPctDesc.slice(0, TOP_SECTOR_COUNT).map(toQuickSectorFact),
        top_losers: byPctAsc.slice(0, TOP_SECTOR_COUNT).map(toQuickSectorFact),
        top_inflows: byNetDesc.slice(0, TOP_SECTOR_COUNT).map(toQuickSectorFact),
        top_outflows: byNetAsc.slice(0, TOP_SECTOR_COUNT).map(toQuickSectorFact),
    }
}

/** 格式化上海时区日期为 YYYY-MM-DD。 */
function formatShanghaiDate(now: Date): string {
    const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    const y = shanghai.getUTCFullYear()
    const m = String(shanghai.getUTCMonth() + 1).padStart(2, '0')
    const d = String(shanghai.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}
