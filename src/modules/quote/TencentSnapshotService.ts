/**
 * TencentSnapshotService — 15:30 收盘后基于腾讯实时行情构建简版收盘快照。
 *
 * 设计要点：
 * - 核心数据（6 大指数）严格失败，非核心（宽度/概念流）宽松失败
 * - 批量拉取 50 只/批，10 批并发
 * - 涨跌停为近似值（阈值判断），标记 limit_count_approximate=true
 * - 复用 CloseMarketSnapshot schema，snapshot_kind='quick'
 */

import { TencentQuoteService } from './TencentQuoteService'
import { getMoneyflowCntThs, getStockBasicBulk, type MoneyflowCntThsRow } from './TushareService'
import {
    isAtOrAfterClose,
    type CloseIndexFact,
    type CloseMarketSnapshot,
    type MarketBreadth,
    type QuickSnapshotCoverage,
} from './MarketSnapshotService'

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

export class TencentSnapshotService {
    /**
     * 构建 quick snapshot（15:30 收盘后立即可用）。
     *
     * 核心数据（指数）失败 → 整体抛出。
     * 非核心数据（宽度/概念流）失败 → partial snapshot，coverage 标记 false。
     */
    static async buildQuickSnapshot(nowOverride?: Date): Promise<CloseMarketSnapshot> {
        const now = nowOverride ?? new Date()

        if (!isAtOrAfterClose(now)) {
            const err = new Error('market_not_closed: before 15:30 Shanghai time')
            err.name = 'MarketSnapshotUnavailable'
            throw err
        }

        const tradeDate = formatShanghaiDate(now)
        const capturedAt = now.toISOString()

        // 1. 核心数据：6 大指数（严格失败）
        const indexes = await this.fetchIndexes()

        // 2. 非核心数据：全市场宽度 + 概念板块资金流（宽松失败）
        const [breadthResult, conceptFlowResult] = await Promise.allSettled([
            this.fetchMarketBreadth(),
            this.fetchConceptFlow(tradeDate),
        ])

        const marketBreadth: MarketBreadth | undefined =
            breadthResult.status === 'fulfilled' ? breadthResult.value : undefined

        const conceptFlow: MoneyflowCntThsRow[] =
            conceptFlowResult.status === 'fulfilled' ? conceptFlowResult.value : []

        const coverage: QuickSnapshotCoverage = {
            has_limit_pool: false,
            has_moneyflow: false,
            has_concept_flow: conceptFlow.length > 0,
        }

        return this.assembleSnapshot(tradeDate, capturedAt, indexes, marketBreadth, coverage)
    }

    /** 拉 6 大指数（一次批量请求）。失败抛异常。 */
    static async fetchIndexes(): Promise<CloseIndexFact[]> {
        const quotes = await TencentQuoteService.getBatchQuotes(INDEX_CODES)
        const indexes: CloseIndexFact[] = []

        for (const code of INDEX_CODES) {
            const row = quotes.find((q) => q['股票代码'] === code)
            if (!row) {
                throw new Error(`index ${code} not found in batch quotes`)
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
    static async fetchMarketBreadth(): Promise<MarketBreadth> {
        let allCodes: string[] = []
        try {
            const stockBasics = await __tencentSnapshotDeps.getStockBasicBulk()
            allCodes = stockBasics.flatMap(({ ts_code }) => {
                const match = ts_code.match(/^(\d{6})\.(SH|SZ)$/)
                if (!match) return []
                return [`${match[2] === 'SH' ? 'sh' : 'sz'}${match[1]}`]
            })
        } catch {
            // 宽度数据为非核心，股票池获取失败时安全降级为空列表。
        }
        const quotes: TencentQuoteRow[] = []

        // 分批拉取，BATCH_CONCURRENCY 批并发
        for (let i = 0; i < allCodes.length; i += BATCH_SIZE * BATCH_CONCURRENCY) {
            const batchGroup: Promise<Record<string, any>[]>[] = []
            for (let j = 0; j < BATCH_CONCURRENCY && i + j * BATCH_SIZE < allCodes.length; j++) {
                const batch = allCodes.slice(i + j * BATCH_SIZE, i + (j + 1) * BATCH_SIZE)
                batchGroup.push(TencentQuoteService.getBatchQuotes(batch))
            }
            const results = await Promise.all(batchGroup)
            for (const batch of results) {
                for (const row of batch) {
                    quotes.push(row as TencentQuoteRow)
                }
            }
        }

        return this.calculateBreadth(quotes)
    }

    /** 从行情行计算全市场宽度。 */
    static calculateBreadth(quotes: TencentQuoteRow[]): MarketBreadth {
        let advance = 0, decline = 0, flat = 0
        let limitUp = 0, limitDown = 0
        let totalVolume = 0
        let totalChangePct = 0
        let validCount = 0

        for (const q of quotes) {
            const code = String(q['股票代码'] ?? '')
            if (!code) continue
            const changePct = toNumber(q['涨跌幅'])

            if (changePct > 0) advance++
            else if (changePct < 0) decline++
            else flat++

            const threshold = getLimitThreshold(code)
            if (changePct >= threshold) limitUp++
            if (changePct <= -threshold) limitDown++

            totalVolume += toNumber(q['成交量'])
            totalChangePct += changePct
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
        }
    }

    /** 概念板块资金流（复用 TushareService，失败时降级返回空数组）。 */
    static async fetchConceptFlow(tradeDate: string): Promise<MoneyflowCntThsRow[]> {
        try {
            return await getMoneyflowCntThs(tradeDate)
        } catch (e) {
            return []
        }
    }

    /** 组装最终 snapshot。 */
    static assembleSnapshot(
        tradeDate: string,
        capturedAt: string,
        indexes: CloseIndexFact[],
        marketBreadth: MarketBreadth | undefined,
        coverage: QuickSnapshotCoverage,
    ): CloseMarketSnapshot {
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
                total_count: marketBreadth?.total_count ?? 0,
                advance_count: marketBreadth?.advance_count ?? 0,
                decline_count: marketBreadth?.decline_count ?? 0,
                flat_count: marketBreadth?.flat_count ?? 0,
                advance_ratio: 0,
                source: 'tushare:daily',
            },
            turnover: { amount_yuan: 0, previous_amount_yuan: 0, change_pct: 0, source: 'tushare:daily' },
            limits: { up_count: 0, down_count: 0, broken_count: 0, highest_board: 0 },
            sectors: { top_gainers: [], top_losers: [], top_inflows: [], top_outflows: [] },
            main_force: { large_and_extra_large_net_yuan: 0, source: 'tushare:moneyflow_ths' },
            coverage: {
                current_daily: { complete: false, reason: 'empty' as const, page_count: 0, row_count: 0 },
                previous_daily: { complete: false, reason: 'empty' as const, page_count: 0, row_count: 0 },
            },
            // quick snapshot 扩展字段
            snapshot_kind: 'quick',
            coverage_info: coverage,
            market_breadth: marketBreadth,
        }
    }
}

/** 依赖注入接口（测试可替换 stock_basic 数据源）。 */
export interface TencentSnapshotDeps {
    getStockBasicBulk: typeof getStockBasicBulk
}

/** 生产环境默认实现：复用 Tushare 活跃股票列表。 */
export const __tencentSnapshotDeps: TencentSnapshotDeps = {
    getStockBasicBulk,
}

/** 格式化上海时区日期为 YYYY-MM-DD。 */
function formatShanghaiDate(now: Date): string {
    const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    const y = shanghai.getUTCFullYear()
    const m = String(shanghai.getUTCMonth() + 1).padStart(2, '0')
    const d = String(shanghai.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}
