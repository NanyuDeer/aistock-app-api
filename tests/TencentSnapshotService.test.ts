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
import { mock } from 'node:test'

import {
    TencentSnapshotService,
    __tencentSnapshotDeps,
} from '../src/modules/quote/TencentSnapshotService'
import { TencentQuoteService } from '../src/modules/quote/TencentQuoteService'

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
    const fetchBreadthMock = mock.method(TencentSnapshotService, 'fetchMarketBreadth', async () => ({
        total_count: 10,
        advance_count: 8,
        decline_count: 2,
        flat_count: 0,
        limit_up_count: 1,
        limit_down_count: 0,
        limit_count_approximate: true,
        total_volume: 2600000,
        avg_change_pct: 4.9,
    }))
    const fetchConceptFlowMock = mock.method(TencentSnapshotService, 'fetchConceptFlow', async () => [])
    const originalGetMoneyflowThsByDate = __tencentSnapshotDeps.getMoneyflowThsByDate
    __tencentSnapshotDeps.getMoneyflowThsByDate = async () => { throw new Error('moneyflow unavailable') }

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
        assert.equal(snapshot.quick_data_availability!.turnover.state, 'unavailable')
        assert.deepEqual(snapshot.quick_data_availability!.limits, {
            state: 'partial',
            available_fields: ['up_count', 'down_count'],
            approximate: true,
        })
        assert.equal(snapshot.turnover.amount_yuan, null)
        assert.equal(snapshot.limits.broken_count, null)
        assert.equal(snapshot.main_force.large_and_extra_large_net_yuan, null)
        assert.ok(snapshot.market_breadth, 'market_breadth should be present')
        assert.equal(snapshot.market_breadth!.advance_count, 8)
        assert.equal(snapshot.market_breadth!.limit_up_count, 1)
        assert.equal(snapshot.market_breadth!.limit_count_approximate, true)
        assert.ok(snapshot.coverage_info)
        assert.equal(snapshot.coverage_info!.has_limit_pool, false)
        assert.equal(snapshot.coverage_info!.has_moneyflow, false)
    } finally {
        fetchIndexesMock.mock.restore()
        fetchBreadthMock.mock.restore()
        fetchConceptFlowMock.mock.restore()
        __tencentSnapshotDeps.getMoneyflowThsByDate = originalGetMoneyflowThsByDate
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
    const fetchConceptFlowMock = mock.method(TencentSnapshotService, 'fetchConceptFlow', async () => [])

    try {
        const snapshot = await TencentSnapshotService.buildQuickSnapshot(afterClose)
        assert.equal(snapshot.indexes.length, 6)
        // breadth fetch failed → market_breadth is undefined, coverage marks concept_flow as false
        assert.equal(snapshot.market_breadth, undefined)
        assert.equal(snapshot.coverage_info!.has_concept_flow, false)
    } finally {
        fetchIndexesMock.mock.restore()
        fetchBreadthMock.mock.restore()
        fetchConceptFlowMock.mock.restore()
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
        return [{ '股票代码': symbols[0], '涨跌幅': 1.2, '成交量': 1000000, '成交额': 10000000 }]
    })

    try {
        await TencentSnapshotService.fetchMarketBreadth()
        assert.deepEqual(requestedBatches, [['sh600000', 'sz000001']])
        assert.deepEqual(requestedLevels, ['activity'])
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
