/**
 * TencentSnapshotService 单元测试
 *
 * mock TencentSnapshotService 的 fetchIndexes / fetchMarketBreadth 等静态方法，
 * 验证 buildQuickSnapshot 的核心数据构建、宽度计算、分级失败策略。
 */

import assert from 'node:assert/strict'
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

test('buildQuickSnapshot returns complete snapshot with indexes and breadth', async () => {
    const afterClose = new Date('2026-07-30T07:30:00.000Z') // 15:30 Shanghai

    const fetchIndexesMock = mock.method(TencentSnapshotService, 'fetchIndexes', async () => INDEX_FACTS)
    const fetchBreadthMock = mock.method(TencentSnapshotService, 'fetchMarketBreadth', async () => ({
        total_count: 4,
        advance_count: 3,
        decline_count: 1,
        flat_count: 0,
        limit_up_count: 1,
        limit_down_count: 0,
        limit_count_approximate: true,
        total_volume: 2600000,
        avg_change_pct: 4.9,
    }))
    const fetchConceptFlowMock = mock.method(TencentSnapshotService, 'fetchConceptFlow', async () => [])

    try {
        const snapshot = await TencentSnapshotService.buildQuickSnapshot(afterClose)
        assert.equal(snapshot.status, 'complete')
        assert.equal(snapshot.snapshot_kind, 'quick')
        assert.equal(snapshot.indexes.length, 6)
        assert.ok(snapshot.market_breadth, 'market_breadth should be present')
        assert.equal(snapshot.market_breadth!.advance_count, 3)
        assert.equal(snapshot.market_breadth!.limit_up_count, 1)
        assert.equal(snapshot.market_breadth!.limit_count_approximate, true)
        assert.ok(snapshot.coverage_info)
        assert.equal(snapshot.coverage_info!.has_limit_pool, false)
        assert.equal(snapshot.coverage_info!.has_moneyflow, false)
    } finally {
        fetchIndexesMock.mock.restore()
        fetchBreadthMock.mock.restore()
        fetchConceptFlowMock.mock.restore()
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

test('fetchMarketBreadth queries only active SH/SZ stock-basic listings', async () => {
    const originalGetStockBasicBulk = __tencentSnapshotDeps.getStockBasicBulk
    const requestedBatches: string[][] = []
    __tencentSnapshotDeps.getStockBasicBulk = async () => [
        { ts_code: '600000.SH', symbol: '600000', name: '浦发银行', industry: '银行', list_date: '19991110' },
        { ts_code: '000001.SZ', symbol: '000001', name: '平安银行', industry: '银行', list_date: '19910403' },
        { ts_code: '430001.BJ', symbol: '430001', name: '北交所股票', industry: '其他', list_date: '20211115' },
    ]
    const batchQuotesMock = mock.method(TencentQuoteService, 'getBatchQuotes', async (symbols) => {
        requestedBatches.push(symbols)
        return []
    })

    try {
        await TencentSnapshotService.fetchMarketBreadth()
        assert.deepEqual(requestedBatches, [['sh600000', 'sz000001']])
    } finally {
        __tencentSnapshotDeps.getStockBasicBulk = originalGetStockBasicBulk
        batchQuotesMock.mock.restore()
    }
})

test('fetchMarketBreadth safely returns an empty breadth when stock-basic retrieval fails', async () => {
    const originalGetStockBasicBulk = __tencentSnapshotDeps.getStockBasicBulk
    __tencentSnapshotDeps.getStockBasicBulk = async () => { throw new Error('stock_basic unavailable') }

    try {
        const breadth = await TencentSnapshotService.fetchMarketBreadth()
        assert.equal(breadth.total_count, 0)
        assert.equal(breadth.advance_count, 0)
    } finally {
        __tencentSnapshotDeps.getStockBasicBulk = originalGetStockBasicBulk
    }
})
