/**
 * TencentSnapshotService 单元测试
 *
 * mock TencentSnapshotService 的 fetchIndexes / fetchMarketBreadth 等静态方法，
 * 验证 buildQuickSnapshot 的核心数据构建、宽度计算、分级失败策略。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import https = require('node:https')
import test from 'node:test'
import { before, after, mock } from 'node:test'

import {
    TencentSnapshotService,
    __tencentSnapshotDeps,
} from '../src/modules/quote/TencentSnapshotService'
import { EmSnapshotService } from '../src/modules/quote/EmSnapshotService'
import { TencentQuoteService } from '../src/modules/quote/TencentQuoteService'
import type { CompleteDailyResult, DailyPriceRow } from '../src/modules/quote/TushareService'

// 前日完整日线 mock（编排缺口 #3：quick 改进版需满足 coverage.previous_daily.complete==True）
// 所有 buildQuickSnapshot 测试共用同一桩，覆盖 toCoverageSummary/sumAmountYuan 依赖。
const PREVIOUS_DAILY_ROW: DailyPriceRow = {
    ts_code: '000001.SZ', trade_date: '20260729',
    open: 10, high: 10.5, low: 9.8, close: 10.2,
    pre_close: 10, change: 0.2, pct_chg: 2, vol: 1000000, amount: 20000000,
}
const PREVIOUS_DAILY_RESULT: CompleteDailyResult = {
    rows: [PREVIOUS_DAILY_ROW],
    complete: true,
    reason: 'complete',
    page_count: 1,
}

before(() => {
    __tencentSnapshotDeps.getCompleteDailyByDate = async () => PREVIOUS_DAILY_RESULT
})
after(() => {
    // 恢复为默认实现（指向真实 Tushare），避免影响后续测试
    __tencentSnapshotDeps.getCompleteDailyByDate = require('../src/modules/quote/TushareService').getCompleteDailyByDate
})

// 东财数据源 mock 辅助：buildQuickSnapshot 会并行调用 EM 三个方法（getLimitPools/getConceptFlow/
// getIndustryMainForce），默认全部不可用，避免测试走真实网络；需测东财主源/兜底的用例再单独覆盖。
function mockEmUnavailable() {
    const pools = mock.method(EmSnapshotService, 'getLimitPools', async () => ({
        up_count: null, down_count: null, broken_count: null, highest_board: null,
        availability: { state: 'unavailable' as const, reason: 'mock' },
    }))
    const concepts = mock.method(EmSnapshotService, 'getConceptFlow', async () => ({
        gainers: [], losers: [], inflows: [], outflows: [],
        availability: { state: 'unavailable' as const, reason: 'mock' },
    }))
    const main = mock.method(EmSnapshotService, 'getIndustryMainForce', async () => ({
        large_and_extra_large_net_yuan: null,
        availability: { state: 'unavailable' as const, reason: 'mock' },
    }))
    return [pools, concepts, main]
}

// 6 大指数 mock 数据
const INDEX_FACTS = [
    { ts_code: 'sh000001', name: '上证指数', trade_date: '', close: 3200, pct_chg: 1.2, amount: 3000000000, source: 'tushare:index_daily' as const },
    { ts_code: 'sh000300', name: '沪深300', trade_date: '', close: 4000, pct_chg: 0.8, amount: 2000000000, source: 'tushare:index_daily' as const },
    { ts_code: 'sh000016', name: '上证50', trade_date: '', close: 2800, pct_chg: 0.5, amount: 1000000000, source: 'tushare:index_daily' as const },
    { ts_code: 'sz399001', name: '深证成指', trade_date: '', close: 10500, pct_chg: 1.5, amount: 3500000000, source: 'tushare:index_daily' as const },
    { ts_code: 'sz399006', name: '创业板指', trade_date: '', close: 2100, pct_chg: 2.1, amount: 1500000000, source: 'tushare:index_daily' as const },
    { ts_code: 'sz399303', name: '国证2000', trade_date: '', close: 8000, pct_chg: 0.9, amount: 800000000, source: 'tushare:index_daily' as const },
]

// 全市场个股 mock 数据（简化，含涨跌停近似判断用例）
const STOCK_QUOTES: Record<string, unknown>[] = [
    { '股票代码': 'sh600000', '涨跌幅': 9.8, '成交量': 1000000, '成交额': 10000000 },
    { '股票代码': 'sh601318', '涨跌幅': -9.5, '成交量': 800000, '成交额': 8000000 },
    { '股票代码': 'sz000001', '涨跌幅': 0.3, '成交量': 500000, '成交额': 5000000 },
    { '股票代码': 'sz300750', '涨跌幅': 20.0, '成交量': 300000, '成交额': 6000000 },
]

const AVAILABLE_BREADTH_RESULT = {
    breadth: {
        total_count: 10,
        advance_count: 8,
        decline_count: 2,
        flat_count: 0,
        limit_up_count: 1,
        limit_down_count: 0,
        limit_count_approximate: true,
        total_volume: 2600000,
        avg_change_pct: 4.9,
        total_amount_yuan: 29000000,
    },
    availability: { state: 'available' as const },
}

function buildTencentQuoteLine(code: string, name: string): string {
    const fields = Array.from({ length: 47 }, () => '')
    fields[1] = name
    fields[2] = code
    fields[3] = '10.50'
    fields[4] = '10.00'
    fields[5] = '10.10'
    fields[31] = '0.50'
    fields[32] = '5.00'
    fields[33] = '10.80'
    fields[34] = '10.00'
    fields[36] = '100'
    fields[37] = '200'
    fields[38] = '1.00'
    fields[39] = '20.00'
    fields[43] = '2.00'
    fields[46] = '1.00'
    return `v_${code}="${fields.join('~')}";`
}

test('explicit Tencent symbols are requested unchanged and retained in parsed batch quotes', async () => {
    const requestedUrls: string[] = []
    const requestMock = mock.method(https, 'request', (options, callback) => {
        requestedUrls.push(`https://${options.hostname}${options.path}`)
        const request = new EventEmitter()
        request.end = () => {
            const response = new EventEmitter() as EventEmitter & {
                headers: Record<string, string>
                statusCode: number
                statusMessage: string
            }
            response.headers = {}
            response.statusCode = 200
            response.statusMessage = 'OK'
            callback(response as any)
            queueMicrotask(() => {
                response.emit('data', Buffer.from([
                    buildTencentQuoteLine('sh000001', '上证指数'),
                    buildTencentQuoteLine('sz000001', '平安银行'),
                ].join('\n')))
                response.emit('end')
            })
        }
        return request as any
    })

    try {
        const quotes = await TencentQuoteService.getBatchQuotes(['sh000001', 'sz000001'], 'activity')

        assert.equal(requestedUrls.length, 1)
        assert.match(requestedUrls[0], /q=sh000001,sz000001/)
        assert.doesNotMatch(requestedUrls[0], /shsh000001|shsz000001/)
        assert.deepEqual(quotes.map((quote) => quote['股票代码']), ['sh000001', 'sz000001'])
    } finally {
        requestMock.mock.restore()
    }
})

test('buildQuickSnapshot exposes truthful availability for its quick facts', async () => {
    const afterClose = new Date('2026-07-30T07:30:00.000Z') // 15:30 Shanghai

    const fetchIndexesMock = mock.method(TencentSnapshotService, 'fetchIndexes', async () => INDEX_FACTS)
    const fetchBreadthMock = mock.method(TencentSnapshotService, 'fetchMarketBreadth', async () => AVAILABLE_BREADTH_RESULT)
    const fetchSectorsMock = mock.method(TencentSnapshotService, 'fetchTencentSectors', async () => ({
        gainers: [],
        losers: [],
        availability: { state: 'unavailable' as const, reason: 'Tencent board rank returned no sector rows' },
    }))
    const fetchMainForceMock = mock.method(TencentSnapshotService, 'fetchTencentMainForce', async () => ({
        large_and_extra_large_net_yuan: null,
        availability: { state: 'unavailable' as const, reason: 'Tencent industry board rank returned no rows' },
    }))
    const emMocks = mockEmUnavailable()

    try {
        const snapshot = await TencentSnapshotService.buildQuickSnapshot(afterClose)
        assert.equal(snapshot.status, 'complete')
        assert.equal(snapshot.snapshot_kind, 'quick')
        assert.equal(snapshot.indexes.length, 6)
        assert.deepEqual(snapshot.breadth, {
            total_count: 10,
            advance_count: 8,
            decline_count: 2,
            flat_count: 0,
            advance_ratio: 0.8,
            source: 'tencent:quote',
        })
        assert.deepEqual(snapshot.quick_data_availability!.breadth, { state: 'available' })
        // 成交额由全市场行情行聚合（腾讯源近似）→ partial + approximate
        assert.deepEqual(snapshot.quick_data_availability!.turnover, {
            state: 'partial',
            available_fields: ['amount_yuan'],
            approximate: true,
        })
        assert.deepEqual(snapshot.quick_data_availability!.limits, {
            state: 'partial',
            available_fields: ['up_count', 'down_count'],
            approximate: true,
        })
        assert.equal(snapshot.turnover.amount_yuan, 29000000)
        assert.equal(snapshot.turnover.source, 'tencent:quote')
        assert.equal(snapshot.turnover.approximate, true)
        // 编排缺口 #3：quick 改进版前日必须完整（Node 用 Tushare 前日填充）并回填 prior 成交额
        assert.equal(snapshot.coverage.previous_daily.complete, true)
        assert.equal(snapshot.turnover.previous_amount_yuan, 20000000000)
        assert.equal(snapshot.limits.broken_count, null)
        assert.equal(snapshot.main_force.large_and_extra_large_net_yuan, null)
        assert.equal(snapshot.main_force.source, 'tencent:board_main_flow')
        assert.ok(snapshot.market_breadth, 'market_breadth should be present')
        assert.equal(snapshot.market_breadth!.advance_count, 8)
        assert.equal(snapshot.market_breadth!.limit_up_count, 1)
        assert.equal(snapshot.market_breadth!.limit_count_approximate, true)
        assert.ok(snapshot.coverage_info)
        assert.equal(snapshot.coverage_info!.has_limit_pool, false)
        assert.equal(snapshot.coverage_info!.has_moneyflow, false)
        assert.equal(snapshot.coverage_info!.has_concept_flow, false)
        assert.deepEqual(snapshot.quick_data_availability.sectors, {
            state: 'unavailable',
            reason: 'both eastmoney concept flow and Tencent board rank returned no sectors',
        })
        assert.deepEqual(snapshot.quick_data_availability.main_force, {
            state: 'unavailable',
            reason: 'mock',
        })
    } finally {
        fetchIndexesMock.mock.restore()
        fetchBreadthMock.mock.restore()
        fetchSectorsMock.mock.restore()
        fetchMainForceMock.mock.restore()
        emMocks.forEach((m) => m.mock.restore())
    }
})

test('buildQuickSnapshot throws MarketSnapshotUnavailableError before 15:30', async () => {
    const beforeClose = new Date('2026-07-30T07:29:00.000Z') // 15:29 Shanghai
    await assert.rejects(
        () => TencentSnapshotService.buildQuickSnapshot(beforeClose),
        (err: Error) => err.message.includes('market_not_closed'),
    )
})

test('buildQuickSnapshot still succeeds when market breadth fetch fails', async () => {
    const afterClose = new Date('2026-07-30T07:30:00.000Z')
    const fetchIndexesMock = mock.method(TencentSnapshotService, 'fetchIndexes', async () => INDEX_FACTS)
    const fetchBreadthMock = mock.method(TencentSnapshotService, 'fetchMarketBreadth', async () => { throw new Error('breadth failed') })
    const fetchSectorsMock = mock.method(TencentSnapshotService, 'fetchTencentSectors', async () => ({
        gainers: [],
        losers: [],
        availability: { state: 'unavailable' as const, reason: 'Tencent board rank returned no sector rows' },
    }))
    const fetchMainForceMock = mock.method(TencentSnapshotService, 'fetchTencentMainForce', async () => ({
        large_and_extra_large_net_yuan: null,
        availability: { state: 'unavailable' as const, reason: 'Tencent industry board rank returned no rows' },
    }))
    const emMocks = mockEmUnavailable()

    try {
        const snapshot = await TencentSnapshotService.buildQuickSnapshot(afterClose)
        assert.equal(snapshot.indexes.length, 6)
        // breadth fetch failed → market_breadth is undefined, coverage marks concept_flow as false
        assert.equal(snapshot.market_breadth, undefined)
        assert.equal(snapshot.coverage_info!.has_concept_flow, false)
    } finally {
        fetchIndexesMock.mock.restore()
        fetchBreadthMock.mock.restore()
        fetchSectorsMock.mock.restore()
        fetchMainForceMock.mock.restore()
        emMocks.forEach((m) => m.mock.restore())
    }
})

test('buildQuickSnapshot keeps a malformed breadth partial and null', async () => {
    const afterClose = new Date('2026-07-30T07:30:00.000Z')
    const fetchIndexesMock = mock.method(TencentSnapshotService, 'fetchIndexes', async () => INDEX_FACTS)
    const fetchBreadthMock = mock.method(TencentSnapshotService, 'fetchMarketBreadth', async () => ({
        availability: {
            state: 'partial' as const,
            available_fields: [],
            reason: 'Tencent activity rows contain missing or non-numeric 涨跌幅',
        },
    }))
    const fetchSectorsMock = mock.method(TencentSnapshotService, 'fetchTencentSectors', async () => ({
        gainers: [],
        losers: [],
        availability: { state: 'unavailable' as const, reason: 'Tencent board rank returned no sector rows' },
    }))
    const fetchMainForceMock = mock.method(TencentSnapshotService, 'fetchTencentMainForce', async () => ({
        large_and_extra_large_net_yuan: null,
        availability: { state: 'unavailable' as const, reason: 'Tencent industry board rank returned no rows' },
    }))
    const emMocks = mockEmUnavailable()

    try {
        const snapshot = await TencentSnapshotService.buildQuickSnapshot(afterClose)
        assert.equal(snapshot.breadth.total_count, null)
        assert.equal(snapshot.market_breadth, undefined)
        assert.deepEqual(snapshot.quick_data_availability.breadth, {
            state: 'partial',
            available_fields: [],
            reason: 'Tencent activity rows contain missing or non-numeric 涨跌幅',
        })
        assert.equal(snapshot.quick_data_availability.limits.state, 'unavailable')
    } finally {
        fetchIndexesMock.mock.restore()
        fetchBreadthMock.mock.restore()
        fetchSectorsMock.mock.restore()
        fetchMainForceMock.mock.restore()
        emMocks.forEach((m) => m.mock.restore())
    }
})

test('calculateBreadth correctly counts advance/decline/limit', () => {
    const breadth = TencentSnapshotService.calculateBreadth(STOCK_QUOTES)
    assert.equal(breadth.advance_count, 3)   // sh600000, sz000001, sz300750
    assert.equal(breadth.decline_count, 1)    // sh601318
    assert.equal(breadth.flat_count, 0)
    assert.equal(breadth.limit_up_count, 1)   // sz300750 (20.0% >= 20% threshold)
    assert.equal(breadth.limit_down_count, 0) // sh601318 -9.5% 未达 -10%
    assert.equal(breadth.limit_count_approximate, true)
    assert.equal(breadth.total_amount_yuan, 29000000) // 各行情行成交额合计
})

test('fetchIndexes maps Tencent index symbols to canonical Tushare ts_codes', async () => {
    const tencentIndexQuotes = [
        { '股票代码': 'sh000001', '股票简称': '上证指数', '最新价': 3200, '涨跌幅': 1.2, '成交额': 3000000000 },
        { '股票代码': 'sh000300', '股票简称': '沪深300', '最新价': 4000, '涨跌幅': 0.8, '成交额': 2000000000 },
        { '股票代码': 'sh000016', '股票简称': '上证50', '最新价': 2800, '涨跌幅': 0.5, '成交额': 1000000000 },
        { '股票代码': 'sz399001', '股票简称': '深证成指', '最新价': 10500, '涨跌幅': 1.5, '成交额': 3500000000 },
        { '股票代码': 'sz399006', '股票简称': '创业板指', '最新价': 2100, '涨跌幅': 2.1, '成交额': 1500000000 },
        { '股票代码': 'sz399303', '股票简称': '国证2000', '最新价': 8000, '涨跌幅': 0.9, '成交额': 800000000 },
    ]
    const batchQuotesMock = mock.method(TencentQuoteService, 'getBatchQuotes', async () => tencentIndexQuotes)

    try {
        const indexes = await TencentSnapshotService.fetchIndexes()
        assert.deepEqual(indexes.map((index) => index.ts_code), [
            '000001.SH',
            '000300.SH',
            '000016.SH',
            '399001.SZ',
            '399006.SZ',
            '399303.SZ',
        ])
    } finally {
        batchQuotesMock.mock.restore()
    }
})

test('fetchIndexes rejects an error placeholder at activity level', async () => {
    const tencentIndexQuotes = [
        { '股票代码': 'sh000001', '错误': '未获取到行情数据' },
        { '股票代码': 'sh000300', '股票简称': '沪深300', '最新价': 4000, '涨跌幅': 0.8, '成交额': 2000000000 },
        { '股票代码': 'sh000016', '股票简称': '上证50', '最新价': 2800, '涨跌幅': 0.5, '成交额': 1000000000 },
        { '股票代码': 'sz399001', '股票简称': '深证成指', '最新价': 10500, '涨跌幅': 1.5, '成交额': 3500000000 },
        { '股票代码': 'sz399006', '股票简称': '创业板指', '最新价': 2100, '涨跌幅': 2.1, '成交额': 1500000000 },
        { '股票代码': 'sz399303', '股票简称': '国证2000', '最新价': 8000, '涨跌幅': 0.9, '成交额': 800000000 },
    ]
    const requestedLevels: string[] = []
    const batchQuotesMock = mock.method(TencentQuoteService, 'getBatchQuotes', async (_symbols, level) => {
        requestedLevels.push(level)
        return tencentIndexQuotes
    })

    try {
        await assert.rejects(
            () => TencentSnapshotService.fetchIndexes(),
            new Error('index sh000001 quote failed'),
        )
        assert.deepEqual(requestedLevels, ['activity'])
    } finally {
        batchQuotesMock.mock.restore()
    }
})

test('calculateBreadth skips error placeholders', () => {
    const breadth = TencentSnapshotService.calculateBreadth([
        { '股票代码': 'sh600000', '涨跌幅': 1.2, '成交量': 1000000, '成交额': 10000000 },
        { '股票代码': 'sh600000', '错误': '查询失败' },
    ])

    assert.equal(breadth.total_count, 1)
    assert.equal(breadth.advance_count, 1)
    assert.equal(breadth.flat_count, 0)
})

test('fetchMarketBreadth queries only active SH/SZ stock-basic listings', async () => {
    const originalGetStockBasicBulk = __tencentSnapshotDeps.getStockBasicBulk
    const requestedBatches: string[][] = []
    __tencentSnapshotDeps.getStockBasicBulk = async () => [
        { ts_code: '600000.SH', symbol: '600000', name: '浦发银行', industry: '银行', list_date: '19991110' },
        { ts_code: '000001.SZ', symbol: '000001', name: '平安银行', industry: '银行', list_date: '19910403' },
        { ts_code: '430001.BJ', symbol: '430001', name: '北交所股票', industry: '其他', list_date: '20211115' },
    ]
    const requestedLevels: string[] = []
    const batchQuotesMock = mock.method(TencentQuoteService, 'getBatchQuotes', async (symbols, level) => {
        requestedBatches.push(symbols)
        requestedLevels.push(level)
        return symbols.map((symbol) => ({ '股票代码': symbol, '涨跌幅': 1.2, '成交量': 1000000, '成交额': 10000000 }))
    })

    try {
        const result = await TencentSnapshotService.fetchMarketBreadth()
        assert.deepEqual(requestedBatches, [['sh600000', 'sz000001']])
        assert.deepEqual(requestedLevels, ['activity'])
        assert.equal(result.availability.state, 'available')
        assert.equal(result.breadth!.total_count, 2)
    } finally {
        __tencentSnapshotDeps.getStockBasicBulk = originalGetStockBasicBulk
        batchQuotesMock.mock.restore()
    }
})

test('fetchMarketBreadth marks malformed activity changes as partial instead of flat', async () => {
    const originalGetStockBasicBulk = __tencentSnapshotDeps.getStockBasicBulk
    __tencentSnapshotDeps.getStockBasicBulk = async () => [
        { ts_code: '600000.SH', symbol: '600000', name: '浦发银行', industry: '银行', list_date: '19991110' },
        { ts_code: '000001.SZ', symbol: '000001', name: '平安银行', industry: '银行', list_date: '19910403' },
    ]
    const batchQuotesMock = mock.method(TencentQuoteService, 'getBatchQuotes', async () => [
        { '股票代码': 'sh600000', '涨跌幅': 1.2, '成交量': 1000000 },
        { '股票代码': 'sz000001', '涨跌幅': 'not-a-number', '成交量': 1000000 },
    ])

    try {
        const result = await TencentSnapshotService.fetchMarketBreadth()
        assert.equal(result.breadth, undefined)
        assert.deepEqual(result.availability, {
            state: 'partial',
            available_fields: [],
            reason: 'Tencent activity rows contain missing or non-numeric 涨跌幅',
        })
    } finally {
        __tencentSnapshotDeps.getStockBasicBulk = originalGetStockBasicBulk
        batchQuotesMock.mock.restore()
    }
})

test('fetchMarketBreadth marks null change and blank volume rows partial instead of zero', async () => {
    const originalGetStockBasicBulk = __tencentSnapshotDeps.getStockBasicBulk
    __tencentSnapshotDeps.getStockBasicBulk = async () => [
        { ts_code: '600000.SH', symbol: '600000', name: '浦发银行', industry: '银行', list_date: '19991110' },
        { ts_code: '000001.SZ', symbol: '000001', name: '平安银行', industry: '银行', list_date: '19910403' },
    ]
    const batchQuotesMock = mock.method(TencentQuoteService, 'getBatchQuotes', async () => [
        { '股票代码': 'sh600000', '涨跌幅': null, '成交量': 1000000 },
        { '股票代码': 'sz000001', '涨跌幅': 1.2, '成交量': ' ' },
    ])

    try {
        const result = await TencentSnapshotService.fetchMarketBreadth()
        assert.equal(result.breadth, undefined)
        assert.deepEqual(result.availability, {
            state: 'partial',
            available_fields: [],
            reason: 'Tencent activity rows contain missing or non-numeric 涨跌幅',
        })
    } finally {
        __tencentSnapshotDeps.getStockBasicBulk = originalGetStockBasicBulk
        batchQuotesMock.mock.restore()
    }
})

test('calculateBreadth rejects null, blank, and illegal activity change or volume fields', () => {
    const invalidRows = [
        { '涨跌幅': null, '成交量': 1000000 },
        { '涨跌幅': ' ', '成交量': 1000000 },
        { '涨跌幅': 'invalid', '成交量': 1000000 },
        { '涨跌幅': 1.2, '成交量': null },
        { '涨跌幅': 1.2, '成交量': ' ' },
        { '涨跌幅': 1.2, '成交量': 'invalid' },
    ]

    for (const fields of invalidRows) {
        assert.throws(
            () => TencentSnapshotService.calculateBreadth([{ '股票代码': 'sh600000', ...fields }]),
            /missing or non-numeric/,
        )
    }
})

test('fetchMarketBreadth marks blank volume rows partial instead of zero', async () => {
    const originalGetStockBasicBulk = __tencentSnapshotDeps.getStockBasicBulk
    __tencentSnapshotDeps.getStockBasicBulk = async () => [
        { ts_code: '600000.SH', symbol: '600000', name: '浦发银行', industry: '银行', list_date: '19991110' },
    ]
    const batchQuotesMock = mock.method(TencentQuoteService, 'getBatchQuotes', async () => [
        { '股票代码': 'sh600000', '涨跌幅': 1.2, '成交量': ' ' },
    ])

    try {
        const result = await TencentSnapshotService.fetchMarketBreadth()
        assert.equal(result.breadth, undefined)
        assert.deepEqual(result.availability, {
            state: 'partial',
            available_fields: [],
            reason: 'Tencent activity rows contain missing or non-numeric 成交量',
        })
    } finally {
        __tencentSnapshotDeps.getStockBasicBulk = originalGetStockBasicBulk
        batchQuotesMock.mock.restore()
    }
})

test('fetchMarketBreadth marks incomplete batch coverage unavailable', async () => {
    const originalGetStockBasicBulk = __tencentSnapshotDeps.getStockBasicBulk
    __tencentSnapshotDeps.getStockBasicBulk = async () => [
        { ts_code: '600000.SH', symbol: '600000', name: '浦发银行', industry: '银行', list_date: '19991110' },
        { ts_code: '000001.SZ', symbol: '000001', name: '平安银行', industry: '银行', list_date: '19910403' },
    ]
    const batchQuotesMock = mock.method(TencentQuoteService, 'getBatchQuotes', async () => [
        { '股票代码': 'sh600000', '涨跌幅': 1.2, '成交量': 1000000 },
    ])

    try {
        const result = await TencentSnapshotService.fetchMarketBreadth()
        assert.equal(result.breadth, undefined)
        assert.deepEqual(result.availability, {
            state: 'unavailable',
            reason: 'Tencent activity quote batch coverage is incomplete',
        })
    } finally {
        __tencentSnapshotDeps.getStockBasicBulk = originalGetStockBasicBulk
        batchQuotesMock.mock.restore()
    }
})

test('fetchMarketBreadth reports stock-basic retrieval failure instead of a zero breadth', async () => {
    const originalGetStockBasicBulk = __tencentSnapshotDeps.getStockBasicBulk
    __tencentSnapshotDeps.getStockBasicBulk = async () => { throw new Error('stock_basic unavailable') }

    try {
        await assert.rejects(
            () => TencentSnapshotService.fetchMarketBreadth(),
            new Error('stock_basic unavailable'),
        )
    } finally {
        __tencentSnapshotDeps.getStockBasicBulk = originalGetStockBasicBulk
    }
})

test('buildQuickSnapshot rejects on non-trading days after 15:30 (no fake "today" close)', async () => {
    // 2026-08-01 为周六；腾讯会返回最近收盘，但不得以当天日期标注冒充"今日已收盘"（红线）。
    const weekendAfterClose = new Date('2026-08-01T07:30:00.000Z')
    await assert.rejects(
        () => TencentSnapshotService.buildQuickSnapshot(weekendAfterClose),
        /market_not_closed/,
    )
})

test('sectors and main_force come from Tencent board rank API', async () => {
    // quick 快照的 sectors/main_force 改自腾讯行情中心板块排行接口：
    // 概念板块领涨/领跌 + 行业板块主力净流入合计近似，15:30 收盘后立即可用。
    const afterClose = new Date('2026-07-30T07:30:00.000Z')
    const fetchIndexesMock = mock.method(TencentSnapshotService, 'fetchIndexes', async () => INDEX_FACTS)
    const fetchBreadthMock = mock.method(TencentSnapshotService, 'fetchMarketBreadth', async () => AVAILABLE_BREADTH_RESULT)
    const fetchSectorsMock = mock.method(TencentSnapshotService, 'fetchTencentSectors', async () => ({
        gainers: [
            { ts_code: 'gn1', name: 'CRO', pct_change: 10.63, net_amount: 2665165200, lead_stock: '博腾股份', company_num: 0, trade_date: '' },
        ],
        losers: [
            { ts_code: 'gn2', name: '稳定币概念', pct_change: -3.04, net_amount: -100000000, lead_stock: '某股', company_num: 0, trade_date: '' },
        ],
        availability: { state: 'available' as const },
    }))
    const fetchMainForceMock = mock.method(TencentSnapshotService, 'fetchTencentMainForce', async () => ({
        large_and_extra_large_net_yuan: 37585796000, // 3758579.6 万 × 1e4
        availability: { state: 'available' as const },
    }))
    // 东财不可用 → sectors/main_force 回落到腾讯板块排行（本用例即为腾讯兜底路径验证）
    const emMocks = mockEmUnavailable()

    try {
        const snapshot = await TencentSnapshotService.buildQuickSnapshot(afterClose)
        assert.equal(snapshot.coverage_info!.has_concept_flow, true)
        assert.equal(snapshot.coverage_info!.has_moneyflow, true)
        assert.deepEqual(snapshot.quick_data_availability.sectors, { state: 'available' })
        assert.deepEqual(snapshot.quick_data_availability.main_force, { state: 'available' })
        assert.equal(snapshot.sectors.top_gainers[0].name, 'CRO')
        assert.equal(snapshot.sectors.top_gainers[0].pct_change, 10.63)
        assert.equal(snapshot.sectors.top_losers[0].name, '稳定币概念')
        // 方案确认：不提供资金流排行，top_inflows/top_outflows 恒为空数组
        assert.equal(snapshot.sectors.top_inflows.length, 0)
        assert.equal(snapshot.sectors.top_outflows.length, 0)
        assert.equal(snapshot.main_force.large_and_extra_large_net_yuan, 37585796000)
        assert.equal(snapshot.main_force.source, 'tencent:board_main_flow')
        assert.equal(snapshot.main_force.approximate, true)
    } finally {
        fetchIndexesMock.mock.restore()
        fetchBreadthMock.mock.restore()
        fetchSectorsMock.mock.restore()
        fetchMainForceMock.mock.restore()
        emMocks.forEach((m) => m.mock.restore())
    }
})

test('buildQuickSnapshot prefers eastmoney limits/sectors/main_force over Tencent fallback', async () => {
    // 东财主源全部可用时应优先生效（限额精确池 + 概念资金排序 + 行业主力净额），腾讯仅兜底。
    const afterClose = new Date('2026-07-30T07:30:00.000Z')
    const fetchIndexesMock = mock.method(TencentSnapshotService, 'fetchIndexes', async () => INDEX_FACTS)
    const fetchBreadthMock = mock.method(TencentSnapshotService, 'fetchMarketBreadth', async () => AVAILABLE_BREADTH_RESULT)
    const poolsMock = mock.method(EmSnapshotService, 'getLimitPools', async () => ({
        up_count: 10, down_count: 3, broken_count: 2, highest_board: 5,
        availability: { state: 'available' as const },
    }))
    const conceptsMock = mock.method(EmSnapshotService, 'getConceptFlow', async () => ({
        gainers: [{ ts_code: 'BK0001', name: '创新药', pct_change: 8.0, net_amount: 6260000000, lead_stock: '', company_num: 0, trade_date: '' }],
        losers: [{ ts_code: 'BK0002', name: '稳定币概念', pct_change: -3.0, net_amount: -100000000, lead_stock: '', company_num: 0, trade_date: '' }],
        inflows: [{ ts_code: 'BK0003', name: '医药', pct_change: 5.0, net_amount: 9000000000, lead_stock: '', company_num: 0, trade_date: '' }],
        outflows: [{ ts_code: 'BK0004', name: '银行', pct_change: -1.0, net_amount: -8000000000, lead_stock: '', company_num: 0, trade_date: '' }],
        availability: { state: 'available' as const },
    }))
    const mainMock = mock.method(EmSnapshotService, 'getIndustryMainForce', async () => ({
        large_and_extra_large_net_yuan: 123456789,
        availability: { state: 'available' as const },
    }))
    // 腾讯兜底也可用，但应被东财主源覆盖（验证优先级）
    const fetchSectorsMock = mock.method(TencentSnapshotService, 'fetchTencentSectors', async () => ({
        gainers: [{ ts_code: 'gn1', name: 'TencentFallback', pct_change: 10, net_amount: 0, lead_stock: '', company_num: 0, trade_date: '' }],
        losers: [],
        availability: { state: 'available' as const },
    }))
    const fetchMainForceMock = mock.method(TencentSnapshotService, 'fetchTencentMainForce', async () => ({
        large_and_extra_large_net_yuan: 999,
        availability: { state: 'available' as const },
    }))

    try {
        const snapshot = await TencentSnapshotService.buildQuickSnapshot(afterClose)
        // limits 用东财精确池（含炸板/连板）
        assert.deepEqual(snapshot.limits, { up_count: 10, down_count: 3, broken_count: 2, highest_board: 5 })
        assert.equal(snapshot.quick_data_availability.limits.state, 'available')
        assert.equal(snapshot.coverage_info!.has_limit_pool, true)
        // sectors 用东财（含资金流排序，top_in/out 非空）
        assert.equal(snapshot.sectors.top_gainers[0].name, '创新药')
        assert.equal(snapshot.sectors.top_inflows[0].name, '医药')
        assert.equal(snapshot.sectors.top_outflows[0].name, '银行')
        assert.equal(snapshot.quick_data_availability.sectors.state, 'available')
        assert.equal(snapshot.coverage_info!.has_concept_flow, true)
        // main_force 用东财行业主力净额（不标记 approximate）
        assert.equal(snapshot.main_force.large_and_extra_large_net_yuan, 123456789)
        assert.equal(snapshot.main_force.source, 'eastmoney:industry_main_force')
        assert.equal(snapshot.main_force.approximate, undefined)
        assert.equal(snapshot.quick_data_availability.main_force.state, 'available')
        assert.equal(snapshot.coverage_info!.has_moneyflow, true)
    } finally {
        fetchIndexesMock.mock.restore()
        fetchBreadthMock.mock.restore()
        fetchSectorsMock.mock.restore()
        fetchMainForceMock.mock.restore()
        poolsMock.mock.restore()
        conceptsMock.mock.restore()
        mainMock.mock.restore()
    }
})

test('toSectorFact maps Tencent board fields to SectorFact (zdf→pct_change, zljlr 万→元)', () => {
    const fact = TencentSnapshotService.toSectorFact({
        code: 'pt01801156',
        name: '医疗服务',
        zdf: '8.40',
        zljlr: '257786.62',
        lzg: { name: '博腾股份', zdf: '20.02' },
    })
    assert.equal(fact.name, '医疗服务')
    assert.equal(fact.pct_change, 8.4)
    assert.equal(fact.net_amount, 2577866200) // 257786.62 万 × 1e4
    assert.equal(fact.lead_stock, '博腾股份')
})

test('hasCompleteMainForceFields rejects rows with missing big/extra-large fields', () => {
    const { hasCompleteMainForceFields } = require('../src/modules/quote/MarketSnapshotService')
    assert.equal(
        hasCompleteMainForceFields([
            { buy_lg_amount: -4233.99, buy_elg_amount: undefined, sell_lg_amount: undefined, sell_elg_amount: undefined },
        ]),
        false,
    )
    assert.equal(
        hasCompleteMainForceFields([
            { buy_lg_amount: 1, buy_elg_amount: 2, sell_lg_amount: 3, sell_elg_amount: 4 },
            { buy_lg_amount: 5, buy_elg_amount: 6, sell_lg_amount: 7, sell_elg_amount: 8 },
        ]),
        true,
    )
})
