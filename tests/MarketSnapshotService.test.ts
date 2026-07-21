/**
 * MarketSnapshotService + getCompleteDailyByDate 单元测试
 *
 * 设计要点：
 * - getCompleteDailyByDate 的 tushareRequest 经由 TushareService 导出的
 *   __completeDailyDependencies 注入，避免真实 Tushare 调用。
 * - MarketSnapshotService 的全部 Tushare 依赖经由 __marketSnapshotDependencies
 *   注入，单测替换字段并在 finally 中恢复。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
    getCompleteDailyByDate,
    __completeDailyDependencies,
    type DailyPriceRow,
    type IndexDailyRow,
    type LimitListThsRow,
    type LimitStepRow,
    type MoneyflowCntThsRow,
    type MoneyflowThsRow,
    type CompleteDailyResult,
} from '../src/modules/quote/TushareService'

import {
    getTodayCloseSnapshot,
    __marketSnapshotDependencies,
    MarketSnapshotUnavailableError,
} from '../src/modules/quote/MarketSnapshotService'

import { TradingCalendarService } from '../src/shared/utils/TradingCalendarService'

test('rejects malformed and non-existent calendar dates', () => {
    assert.equal(TradingCalendarService.isTradingDayYyyymmdd('20260230'), false)
    assert.equal(TradingCalendarService.isTradingDayYyyymmdd('2026023'), false)
})

test('isTradingDay uses the Asia/Shanghai calendar date across a UTC day boundary', () => {
    assert.equal(
        TradingCalendarService.isTradingDay(new Date('2026-05-05T16:30:00.000Z')),
        true,
    )
})

test('isTradingDay rejects an invalid Date', () => {
    assert.equal(TradingCalendarService.isTradingDay(new Date('invalid')), false)
})

test('getRecentTradingDay fails closed after calendar coverage in Asia/Shanghai', () => {
    assert.throws(
        () => TradingCalendarService.getRecentTradingDay(new Date('2026-12-31T16:30:00.000Z')),
        /Trading calendar is not available for 2027/,
    )
})

test('getRecentTradingDay fails closed before calendar coverage', () => {
    assert.throws(
        () => TradingCalendarService.getRecentTradingDay(new Date(2025, 0, 2, 16)),
        /Trading calendar is not available for 2025/,
    )
})

// ============================================================================
// Step 1 helpers
// ============================================================================

function makeDailyPriceRow(partial: Partial<DailyPriceRow> & Pick<DailyPriceRow, 'ts_code' | 'trade_date'>): DailyPriceRow {
    return {
        open: 10,
        high: 11,
        low: 9,
        close: 10,
        pre_close: 10,
        change: 0,
        pct_chg: 0,
        vol: 100,
        amount: 100,
        ...partial,
    }
}

function makeDailyRows(count: number, offset: number): DailyPriceRow[] {
    const rows: DailyPriceRow[] = []
    for (let i = 0; i < count; i += 1) {
        const codeNum = offset + i
        rows.push(makeDailyPriceRow({
            ts_code: `${String(codeNum).padStart(6, '0')}.SZ`,
            trade_date: '20260720',
        }))
    }
    return rows
}

let restoreTushare: (() => void) | null = null

/**
 * 替换 getCompleteDailyByDate 内部使用的 tushareRequest，
 * 按调用顺序依次返回 pages 中的每一页。
 */
function mockDailyPages(pages: DailyPriceRow[][]): void {
    let i = 0
    const deps = __completeDailyDependencies
    const original = deps.tushareRequest
    deps.tushareRequest = (async () => pages[i++] ?? []) as typeof original
    restoreTushare = () => {
        deps.tushareRequest = original
    }
}

// ============================================================================
// Step 4 fixtures + helpers
// ============================================================================

function makeIndexRow(partial: Partial<IndexDailyRow> & Pick<IndexDailyRow, 'ts_code' | 'trade_date'>): IndexDailyRow {
    return {
        close: 3000,
        pre_close: 2980,
        change: 20,
        pct_chg: 0.67,
        vol: 1000000,
        amount: 50000000,
        open: 2990,
        high: 3010,
        low: 2985,
        ...partial,
    }
}

function makeSectorRow(partial: Partial<MoneyflowCntThsRow> & Pick<MoneyflowCntThsRow, 'ts_code' | 'name' | 'pct_change' | 'net_amount'>): MoneyflowCntThsRow {
    return {
        trade_date: '20260720',
        lead_stock: '领涨股',
        close_price: 1000,
        industry_index: 1000,
        company_num: 20,
        pct_change_stock: 10,
        net_buy_amount: 1,
        net_sell_amount: 1,
        ...partial,
    }
}

function makeMoneyflowRow(partial: Partial<MoneyflowThsRow> & Pick<MoneyflowThsRow, 'ts_code' | 'trade_date'>): MoneyflowThsRow {
    return {
        buy_sm_amount: 0,
        buy_md_amount: 0,
        buy_lg_amount: 0,
        buy_elg_amount: 0,
        sell_sm_amount: 0,
        sell_md_amount: 0,
        sell_lg_amount: 0,
        sell_elg_amount: 0,
        net_mf_amount: 0,
        net_mf_vol: 0,
        buy_sm_ratio: 0,
        buy_md_ratio: 0,
        buy_lg_ratio: 0,
        buy_elg_ratio: 0,
        sell_sm_ratio: 0,
        sell_md_ratio: 0,
        sell_lg_ratio: 0,
        sell_elg_ratio: 0,
        net_mf_ratio: 0,
        mf_5day: 0,
        ...partial,
    }
}

/** 000001.SH 序列：用于识别当前(20260720)与前一日(20260717)交易日。 */
const SH_INDEX_ROWS: IndexDailyRow[] = [
    makeIndexRow({ ts_code: '000001.SH', trade_date: '20260720', close: 3200, pct_chg: 0.6, amount: 60000000 }),
    makeIndexRow({ ts_code: '000001.SH', trade_date: '20260717', close: 3180, pct_chg: 0.3, amount: 58000000 }),
]

/** 其余 5 个指数各自包含 20260720 当日行。 */
const INDEX_ROWS_BY_CODE: Record<string, IndexDailyRow[]> = {
    '399001.SZ': [makeIndexRow({ ts_code: '399001.SZ', trade_date: '20260720', close: 10500, pct_chg: 0.8 })],
    '399006.SZ': [makeIndexRow({ ts_code: '399006.SZ', trade_date: '20260720', close: 2100, pct_chg: 1.1 })],
    '000300.SH': [makeIndexRow({ ts_code: '000300.SH', trade_date: '20260720', close: 4200, pct_chg: 0.5 })],
    '000905.SH': [makeIndexRow({ ts_code: '000905.SH', trade_date: '20260720', close: 5500, pct_chg: 0.7 })],
    '000852.SH': [makeIndexRow({ ts_code: '000852.SH', trade_date: '20260720', close: 6200, pct_chg: 0.9 })],
}

/** 当日全市场日线：3 涨 + 1 跌 + 1 平；amount(千元)合计 6000 → 6,000,000 元。 */
const CURRENT_DAILY_ROWS: DailyPriceRow[] = [
    makeDailyPriceRow({ ts_code: '000001.SZ', trade_date: '20260720', pct_chg: 1.5, amount: 2000 }),
    makeDailyPriceRow({ ts_code: '000002.SZ', trade_date: '20260720', pct_chg: 2.0, amount: 2000 }),
    makeDailyPriceRow({ ts_code: '600000.SH', trade_date: '20260720', pct_chg: 0.8, amount: 2000 }),
    makeDailyPriceRow({ ts_code: '600001.SH', trade_date: '20260720', pct_chg: -1.0, amount: 0 }),
    makeDailyPriceRow({ ts_code: '600002.SH', trade_date: '20260720', pct_chg: 0, amount: 0 }),
]

const PREVIOUS_DAILY_ROWS: DailyPriceRow[] = [
    makeDailyPriceRow({ ts_code: '000001.SZ', trade_date: '20260717', pct_chg: 0.5, amount: 1000 }),
    makeDailyPriceRow({ ts_code: '000002.SZ', trade_date: '20260717', pct_chg: -0.5, amount: 1000 }),
]

const COMPLETE_CURRENT_DAILY: CompleteDailyResult = {
    rows: CURRENT_DAILY_ROWS,
    complete: true,
    reason: 'complete',
    page_count: 1,
}

const COMPLETE_PREVIOUS_DAILY: CompleteDailyResult = {
    rows: PREVIOUS_DAILY_ROWS,
    complete: true,
    reason: 'complete',
    page_count: 1,
}

const INCOMPLETE_CURRENT_DAILY: CompleteDailyResult = {
    rows: [],
    complete: false,
    reason: 'duplicate_page',
    page_count: 2,
}

/** 12 个概念板块，pct_change 与 net_amount 排序互相独立。 */
const SECTOR_ROWS: MoneyflowCntThsRow[] = [
    makeSectorRow({ ts_code: '881101', name: '板块A', pct_change: 3.0, net_amount: 500 }),
    makeSectorRow({ ts_code: '881102', name: '板块B', pct_change: 2.5, net_amount: 9000 }),
    makeSectorRow({ ts_code: '881103', name: '板块C', pct_change: 2.0, net_amount: 8000 }),
    makeSectorRow({ ts_code: '881104', name: '板块D', pct_change: 1.5, net_amount: 7000 }),
    makeSectorRow({ ts_code: '881105', name: '板块E', pct_change: 1.0, net_amount: 6000 }),
    makeSectorRow({ ts_code: '881106', name: '板块F', pct_change: 0.5, net_amount: -500 }),
    makeSectorRow({ ts_code: '881107', name: '板块G', pct_change: -0.5, net_amount: -1500 }),
    makeSectorRow({ ts_code: '881108', name: '板块H', pct_change: -1.0, net_amount: -2500 }),
    makeSectorRow({ ts_code: '881109', name: '板块I', pct_change: -1.5, net_amount: -3500 }),
    makeSectorRow({ ts_code: '881110', name: '板块J', pct_change: -2.0, net_amount: -4500 }),
    makeSectorRow({ ts_code: '881111', name: '板块K', pct_change: -2.5, net_amount: -5500 }),
    makeSectorRow({ ts_code: '881112', name: '板块L', pct_change: -3.0, net_amount: -6500 }),
]

/** 大单+特大单净额 = (30+50-0-0) 万元 = 80 万元 → 800,000 元。 */
const MONEYFLOW_ROWS: MoneyflowThsRow[] = [
    makeMoneyflowRow({
        ts_code: '000001.SZ',
        trade_date: '20260720',
        buy_lg_amount: 30,
        buy_elg_amount: 50,
        sell_lg_amount: 0,
        sell_elg_amount: 0,
    }),
]

interface CloseMockOverrides {
    currentDaily?: CompleteDailyResult
    previousDaily?: CompleteDailyResult
    dailyResultsByDate?: Record<string, CompleteDailyResult>
    shIndexRows?: IndexDailyRow[]
    indexRowsByCode?: Record<string, IndexDailyRow[]>
    sectorRows?: MoneyflowCntThsRow[]
    moneyflowRows?: MoneyflowThsRow[]
    limitList?: LimitListThsRow[]
    limitStep?: LimitStepRow[]
}

let recordedLimitPoolArgs: string[] = []
let recordedMarketDataCalls: string[] = []
let restoreDeps: (() => void) | null = null

function makeCompleteDailyResult(tradeDate: string): CompleteDailyResult {
    return {
        rows: [makeDailyPriceRow({ ts_code: '000001.SZ', trade_date: tradeDate, pct_chg: 1, amount: 1000 })],
        complete: true,
        reason: 'complete',
        page_count: 1,
    }
}

/** 为指定交易日期注入完整指数和日线数据，用于验证非交易日仍须优先拒绝。 */
function makeCompleteDataOverrides(currentTradeDate: string, previousTradeDate: string): CloseMockOverrides {
    return {
        shIndexRows: [
            makeIndexRow({ ts_code: '000001.SH', trade_date: currentTradeDate }),
            makeIndexRow({ ts_code: '000001.SH', trade_date: previousTradeDate }),
        ],
        indexRowsByCode: {
            '399001.SZ': [makeIndexRow({ ts_code: '399001.SZ', trade_date: currentTradeDate })],
            '399006.SZ': [makeIndexRow({ ts_code: '399006.SZ', trade_date: currentTradeDate })],
            '000300.SH': [makeIndexRow({ ts_code: '000300.SH', trade_date: currentTradeDate })],
            '000905.SH': [makeIndexRow({ ts_code: '000905.SH', trade_date: currentTradeDate })],
            '000852.SH': [makeIndexRow({ ts_code: '000852.SH', trade_date: currentTradeDate })],
        },
        dailyResultsByDate: {
            [currentTradeDate]: makeCompleteDailyResult(currentTradeDate),
            [previousTradeDate]: makeCompleteDailyResult(previousTradeDate),
        },
    }
}

/** 安装 MarketSnapshotService 依赖 mock；可选 override 任何子项。 */
function applyCloseMocks(overrides: CloseMockOverrides = {}): void {
    recordedLimitPoolArgs = []
    recordedMarketDataCalls = []
    const deps = __marketSnapshotDependencies
    const orig = {
        getIndexDaily: deps.getIndexDaily,
        getCompleteDailyByDate: deps.getCompleteDailyByDate,
        getLimitListThs: deps.getLimitListThs,
        getLimitStep: deps.getLimitStep,
        getMoneyflowCntThs: deps.getMoneyflowCntThs,
        getMoneyflowThsByDate: deps.getMoneyflowThsByDate,
        now: deps.now,
    }
    const shIndexRows = overrides.shIndexRows ?? SH_INDEX_ROWS
    const indexRowsByCode = overrides.indexRowsByCode ?? INDEX_ROWS_BY_CODE
    const dailyResultsByDate = overrides.dailyResultsByDate ?? {
        '20260720': overrides.currentDaily ?? COMPLETE_CURRENT_DAILY,
        '20260717': overrides.previousDaily ?? COMPLETE_PREVIOUS_DAILY,
    }

    deps.getIndexDaily = (async (code: string) => {
        recordedMarketDataCalls.push(`index:${code}`)
        return code === '000001.SH' ? shIndexRows : (indexRowsByCode[code] ?? [])
    }) as typeof orig.getIndexDaily
    deps.getCompleteDailyByDate = (async (date: string) => {
        recordedMarketDataCalls.push(`daily:${date}`)
        return dailyResultsByDate[date] ?? (overrides.previousDaily ?? COMPLETE_PREVIOUS_DAILY)
    }) as typeof orig.getCompleteDailyByDate
    deps.getLimitListThs = (async (_tradeDate: string, limitType?: string) => {
        recordedMarketDataCalls.push(`limit:${limitType ?? ''}`)
        if (limitType) recordedLimitPoolArgs.push(limitType)
        return overrides.limitList ?? ([] as LimitListThsRow[])
    }) as typeof orig.getLimitListThs
    deps.getLimitStep = (async () => {
        recordedMarketDataCalls.push('limit-step')
        return overrides.limitStep ?? ([] as LimitStepRow[])
    }) as typeof orig.getLimitStep
    deps.getMoneyflowCntThs = (async () => {
        recordedMarketDataCalls.push('sector')
        return overrides.sectorRows ?? SECTOR_ROWS
    }) as typeof orig.getMoneyflowCntThs
    deps.getMoneyflowThsByDate = (async () => {
        recordedMarketDataCalls.push('moneyflow')
        return overrides.moneyflowRows ?? MONEYFLOW_ROWS
    }) as typeof orig.getMoneyflowThsByDate

    restoreDeps = () => {
        deps.getIndexDaily = orig.getIndexDaily
        deps.getCompleteDailyByDate = orig.getCompleteDailyByDate
        deps.getLimitListThs = orig.getLimitListThs
        deps.getLimitStep = orig.getLimitStep
        deps.getMoneyflowCntThs = orig.getMoneyflowCntThs
        deps.getMoneyflowThsByDate = orig.getMoneyflowThsByDate
        deps.now = orig.now
    }
}

function limitPoolArguments(): string[] {
    return recordedLimitPoolArgs
}

function marketDataCalls(): string[] {
    return recordedMarketDataCalls
}

// ============================================================================
// Step 1: getCompleteDailyByDate 分页与重复页保护
// ============================================================================

test('getCompleteDailyByDate returns all unique pages', async () => {
    mockDailyPages([
        makeDailyRows(5000, 0),
        makeDailyRows(25, 5000),
    ])
    try {
        const result = await getCompleteDailyByDate('20260720')
        assert.equal(result.complete, true)
        assert.equal(result.rows.length, 5025)
    } finally {
        restoreTushare?.()
        restoreTushare = null
    }
})

test('getCompleteDailyByDate rejects a repeated full page', async () => {
    const page = makeDailyRows(5000, 0)
    mockDailyPages([page, page])
    try {
        const result = await getCompleteDailyByDate('20260720')
        assert.equal(result.complete, false)
        assert.equal(result.reason, 'duplicate_page')
    } finally {
        restoreTushare?.()
        restoreTushare = null
    }
})

// ============================================================================
// Step 4: MarketSnapshotService 收盘事实聚合
// ============================================================================

test('builds a complete close snapshot with normalized monetary units', async () => {
    applyCloseMocks()
    try {
        const snapshot = await getTodayCloseSnapshot(new Date('2026-07-20T15:31:00+08:00'))
        assert.equal(snapshot.status, 'complete')
        assert.equal(snapshot.breadth.advance_count, 3)
        assert.equal(snapshot.turnover.amount_yuan, 6000000)
        assert.equal(snapshot.main_force.large_and_extra_large_net_yuan, 800000)
        assert.deepEqual(limitPoolArguments(), ['涨停池', '跌停池', '炸板池'])
    } finally {
        restoreDeps?.()
        restoreDeps = null
    }
})

test('sectors are sorted independently by pct_change and net_amount', async () => {
    applyCloseMocks()
    try {
        const snapshot = await getTodayCloseSnapshot(new Date('2026-07-20T15:31:00+08:00'))
        // top_gainers: pct_change 降序前 5
        assert.deepEqual(
            snapshot.sectors.top_gainers.map(s => s.name),
            ['板块A', '板块B', '板块C', '板块D', '板块E'],
        )
        // top_losers: pct_change 升序前 5（最负在前）
        assert.deepEqual(
            snapshot.sectors.top_losers.map(s => s.name),
            ['板块L', '板块K', '板块J', '板块I', '板块H'],
        )
        // top_inflows: net_amount 降序前 5（与涨跌排序独立）
        assert.deepEqual(
            snapshot.sectors.top_inflows.map(s => s.name),
            ['板块B', '板块C', '板块D', '板块E', '板块A'],
        )
        // top_outflows: net_amount 升序前 5（最负在前）
        assert.deepEqual(
            snapshot.sectors.top_outflows.map(s => s.name),
            ['板块L', '板块K', '板块J', '板块I', '板块H'],
        )
        // 独立性：涨幅第一(板块A)与净流入第一(板块B)不同
        assert.notEqual(
            snapshot.sectors.top_gainers[0].name,
            snapshot.sectors.top_inflows[0].name,
        )
    } finally {
        restoreDeps?.()
        restoreDeps = null
    }
})

test('throws incomplete_daily_coverage when daily coverage incomplete', async () => {
    applyCloseMocks({ currentDaily: INCOMPLETE_CURRENT_DAILY })
    try {
        await assert.rejects(
            getTodayCloseSnapshot(new Date('2026-07-20T15:31:00+08:00')),
            (err: unknown) => {
                assert.ok(err instanceof MarketSnapshotUnavailableError)
                assert.equal(err.reason, 'incomplete_daily_coverage')
                // daily 覆盖不完整属于"已收盘但数据残缺"，与"未收盘"语义不同；
                // 路由层据此区分 409 响应体 status 字段，便于上层（Python 侧）按需重试
                assert.equal(err.status, 'incomplete')
                return true
            },
        )
    } finally {
        restoreDeps?.()
        restoreDeps = null
    }
})

test('throws market_not_closed when an index lacks the current trade_date', async () => {
    // 399001.SZ 仅返回前一交易日，缺当日行
    applyCloseMocks({
        indexRowsByCode: {
            '399001.SZ': [makeIndexRow({ ts_code: '399001.SZ', trade_date: '20260717' })],
            '399006.SZ': INDEX_ROWS_BY_CODE['399006.SZ']!,
            '000300.SH': INDEX_ROWS_BY_CODE['000300.SH']!,
            '000905.SH': INDEX_ROWS_BY_CODE['000905.SH']!,
            '000852.SH': INDEX_ROWS_BY_CODE['000852.SH']!,
        },
    })
    try {
        await assert.rejects(
            getTodayCloseSnapshot(new Date('2026-07-20T15:31:00+08:00')),
            (err: unknown) => {
                assert.ok(err instanceof MarketSnapshotUnavailableError)
                assert.equal(err.reason, 'market_not_closed')
                assert.equal(err.status, 'not_ready')
                return true
            },
        )
    } finally {
        restoreDeps?.()
        restoreDeps = null
    }
})

// ============================================================================
// stale-data 拒绝：盘中 / 非交易日 / 数据延迟场景
//
// 旧实现用 `r.trade_date <= requestDate` 取 SH 序列最新一行作为"当前交易日"，
// 导致周末/节假日或盘中指数数据未到位时，会把上一交易日的事实冒充"今日已收盘"。
// 以下三个测试锁定新契约：只有当 SH 序列包含 requestDate 当日行时，才能识别为已收盘。
// ============================================================================

test('throws market_not_closed on weekend (requestDate not a trade day)', async () => {
    // requestDate=20260719（周日非交易日）。即使 6 指数、当日和前日日线均完整，
    // 也必须在任何行情调用前拒绝，不能把伪造的同日数据当作 A 股已收盘事实。
    applyCloseMocks(makeCompleteDataOverrides('20260719', '20260717'))
    try {
        await assert.rejects(
            getTodayCloseSnapshot(new Date('2026-07-19T15:31:00+08:00')),
            (err: unknown) => {
                assert.ok(err instanceof MarketSnapshotUnavailableError)
                assert.equal(err.reason, 'market_not_closed')
                assert.equal(err.status, 'not_ready')
                return true
            },
        )
        assert.deepEqual(marketDataCalls(), [])
    } finally {
        restoreDeps?.()
        restoreDeps = null
    }
})

test('throws market_not_closed on holiday with complete data', async () => {
    // 20261001 是国庆节。即使完整同日数据被错误提供，也必须在行情调用前拒绝。
    applyCloseMocks(makeCompleteDataOverrides('20261001', '20260930'))
    try {
        await assert.rejects(
            getTodayCloseSnapshot(new Date('2026-10-01T15:31:00+08:00')),
            (err: unknown) => {
                assert.ok(err instanceof MarketSnapshotUnavailableError)
                assert.equal(err.reason, 'market_not_closed')
                assert.equal(err.status, 'not_ready')
                return true
            },
        )
        assert.deepEqual(marketDataCalls(), [])
    } finally {
        restoreDeps?.()
        restoreDeps = null
    }
})

test('throws market_not_closed on 2026 Labour Day holiday with complete data', async () => {
    applyCloseMocks(makeCompleteDataOverrides('20260504', '20260430'))
    try {
        await assert.rejects(
            getTodayCloseSnapshot(new Date('2026-05-04T15:30:00+08:00')),
            (err: unknown) => {
                assert.ok(err instanceof MarketSnapshotUnavailableError)
                assert.equal(err.reason, 'market_not_closed')
                assert.equal(err.status, 'not_ready')
                return true
            },
        )
        assert.deepEqual(marketDataCalls(), [])
    } finally {
        restoreDeps?.()
        restoreDeps = null
    }
})

test('throws market_not_closed on an uncovered New Year holiday with complete data', async () => {
    applyCloseMocks(makeCompleteDataOverrides('20270101', '20261231'))
    try {
        await assert.rejects(
            getTodayCloseSnapshot(new Date('2027-01-01T15:30:00+08:00')),
            (err: unknown) => {
                assert.ok(err instanceof MarketSnapshotUnavailableError)
                assert.equal(err.reason, 'market_not_closed')
                assert.equal(err.status, 'not_ready')
                return true
            },
        )
        assert.deepEqual(marketDataCalls(), [])
    } finally {
        restoreDeps?.()
        restoreDeps = null
    }
})

test('throws market_not_closed when SH index data lags after close', async () => {
    // 数据延迟场景：requestDate=20260720（真实交易日），但 SH 序列只到 20260717，
    // 说明 Tushare 当日 index_daily 尚未推送——绝不能把 20260717 当作"今日已收盘"。
    // 关键：使用 15:31 +08:00（收盘后）调用，确保命中 SH 数据滞后校验而非 15:30 时钟门禁，
    // 保留原 SH 滞后测试意图。
    applyCloseMocks({
        shIndexRows: [
            makeIndexRow({ ts_code: '000001.SH', trade_date: '20260717', close: 3180, pct_chg: 0.3, amount: 58000000 }),
            makeIndexRow({ ts_code: '000001.SH', trade_date: '20260716', close: 3170, pct_chg: 0.2, amount: 55000000 }),
        ],
        // 其余指数同样缺 20260720 行（与 SH 一致）
        indexRowsByCode: {
            '399001.SZ': [makeIndexRow({ ts_code: '399001.SZ', trade_date: '20260717' })],
            '399006.SZ': [makeIndexRow({ ts_code: '399006.SZ', trade_date: '20260717' })],
            '000300.SH': [makeIndexRow({ ts_code: '000300.SH', trade_date: '20260717' })],
            '000905.SH': [makeIndexRow({ ts_code: '000905.SH', trade_date: '20260717' })],
            '000852.SH': [makeIndexRow({ ts_code: '000852.SH', trade_date: '20260717' })],
        },
    })
    try {
        await assert.rejects(
            getTodayCloseSnapshot(new Date('2026-07-20T15:31:00+08:00')),
            (err: unknown) => {
                assert.ok(err instanceof MarketSnapshotUnavailableError)
                assert.equal(err.reason, 'market_not_closed')
                assert.equal(err.status, 'not_ready')
                return true
            },
        )
    } finally {
        restoreDeps?.()
        restoreDeps = null
    }
})

// ============================================================================
// 收盘时钟门禁 — 15:30 +08:00 前一律拒绝，即使 6 指数和日线数据都已存在
// ============================================================================

test('throws market_not_closed at 15:29 +08:00 even with complete data', async () => {
    // 真实工作日盘中：6 指数和日线均已存在（applyCloseMocks 安装完整数据），
    // 但 Asia/Shanghai 时间 15:29 < 15:30 → 必须返回 market_not_closed。
    // 旧实现只校验 currentTradeDate === requestDate，盘中数据到位时会错误返回 complete。
    applyCloseMocks()
    try {
        await assert.rejects(
            getTodayCloseSnapshot(new Date('2026-07-20T15:29:00+08:00')),
            (err: unknown) => {
                assert.ok(err instanceof MarketSnapshotUnavailableError)
                assert.equal(err.reason, 'market_not_closed')
                assert.equal(err.status, 'not_ready')
                return true
            },
        )
    } finally {
        restoreDeps?.()
        restoreDeps = null
    }
})

test('returns complete at 15:30 +08:00 with complete data', async () => {
    // 真实工作日 15:30 +08:00（收盘时刻）+ 完整数据 → 返回 complete。
    // 与上一个测试共同锁定 15:30 时钟门禁边界：15:29 拒绝、15:30 放行。
    applyCloseMocks()
    try {
        const snapshot = await getTodayCloseSnapshot(new Date('2026-07-20T15:30:00+08:00'))
        assert.equal(snapshot.status, 'complete')
        assert.equal(snapshot.trade_date, '20260720')
    } finally {
        restoreDeps?.()
        restoreDeps = null
    }
})
