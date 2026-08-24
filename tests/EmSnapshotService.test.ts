/**
 * EmSnapshotService 单元测试
 *
 * 通过 mock 私有静态方法 fetchPool / fetchBoardRows（运行时仍是可覆写的类属性，用 as any 绕过
 * TS private 限制），验证涨跌停/炸板/连板池的聚合与字段、概念板块资金流排序、行业主力净额求和。
 * 不发起真实网络请求。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mock } from 'node:test'

import { EmSnapshotService } from '../src/modules/quote/EmSnapshotService'

test('getLimitPools aggregates zt/dt/zb counts and highest_board from lbc', async () => {
    const fetchPoolMock = mock.method(EmSnapshotService as any, 'fetchPool', async (endpoint: string) => {
        if (endpoint === 'getTopicZTPool') {
            return [
                { c: '000001', n: '平安银行', lbc: 5 },
                { c: '000002', n: '万科A', lbc: 2 },
                { c: '000003', n: '无连板', lbc: null },
            ]
        }
        if (endpoint === 'getTopicDTPool') return [{ c: '000004', n: '跌停1' }]
        return [{ c: '000005', n: '炸板1' }, { c: '000006', n: '炸板2' }]
    })

    try {
        const res = await EmSnapshotService.getLimitPools('20260730')
        assert.equal(res.up_count, 3)
        assert.equal(res.down_count, 1)
        assert.equal(res.broken_count, 2)
        assert.equal(res.highest_board, 5)
        assert.deepEqual(res.availability, { state: 'available' })
    } finally {
        fetchPoolMock.mock.restore()
    }
})

test('getLimitPools marks partial when a sub-pool fails, keeping known counts', async () => {
    const fetchPoolMock = mock.method(EmSnapshotService as any, 'fetchPool', async (endpoint: string) => {
        if (endpoint === 'getTopicZTPool') throw new Error('zt fail')
        if (endpoint === 'getTopicDTPool') return [{ c: '000004', n: '跌停1' }]
        return [{ c: '000005', n: '炸板1' }]
    })

    try {
        const res = await EmSnapshotService.getLimitPools('20260730')
        assert.equal(res.up_count, null)
        assert.equal(res.down_count, 1)
        assert.equal(res.broken_count, 1)
        assert.equal(res.highest_board, null)
        assert.equal(res.availability.state, 'partial')
        assert.deepEqual((res.availability as any).available_fields, ['down', 'broken'])
    } finally {
        fetchPoolMock.mock.restore()
    }
})

test('getConceptFlow sorts sectors by pct and net amount independently', async () => {
    const fetchBoardRowsMock = mock.method(EmSnapshotService as any, 'fetchBoardRows', async () => [
        { f12: 'BK1', f14: 'A涨', f3: 9.5, f62: 100 },
        { f12: 'BK2', f14: 'B涨', f3: 8.0, f62: 5000 },
        { f12: 'BK3', f14: 'C跌', f3: -6.0, f62: -300 },
        { f12: 'BK4', f14: 'D跌', f3: -3.0, f62: -8000 },
        { f12: 'BK5', f14: 'E稳', f3: 0.0, f62: 1000 },
    ])

    try {
        const res = await EmSnapshotService.getConceptFlow()
        assert.deepEqual(res.gainers.map((s) => s.name), ['A涨', 'B涨', 'E稳', 'D跌', 'C跌'])
        assert.deepEqual(res.losers.map((s) => s.name), ['C跌', 'D跌', 'E稳', 'B涨', 'A涨'])
        assert.deepEqual(res.inflows.map((s) => s.name), ['B涨', 'E稳', 'A涨', 'C跌', 'D跌'])
        assert.deepEqual(res.outflows.map((s) => s.name), ['D跌', 'C跌', 'A涨', 'E稳', 'B涨'])
        assert.deepEqual(res.availability, { state: 'available' })
    } finally {
        fetchBoardRowsMock.mock.restore()
    }
})

test('getIndustryMainForce sums net inflow across industry boards (yuan)', async () => {
    const fetchBoardRowsMock = mock.method(EmSnapshotService as any, 'fetchBoardRows', async () => [
        { f12: 'BK001', f14: '医药生物', f62: 109000000 },
        { f12: 'BK002', f14: '电子', f62: -50000000 },
        { f12: 'BK003', f14: '银行', f62: 30000000 },
    ])

    try {
        const res = await EmSnapshotService.getIndustryMainForce()
        assert.equal(res.large_and_extra_large_net_yuan, 89000000)
        assert.deepEqual(res.availability, { state: 'available' })
    } finally {
        fetchBoardRowsMock.mock.restore()
    }
})

test('getIndustryMainForce returns unavailable on empty board rows', async () => {
    const fetchBoardRowsMock = mock.method(EmSnapshotService as any, 'fetchBoardRows', async () => [])

    try {
        const res = await EmSnapshotService.getIndustryMainForce()
        assert.equal(res.large_and_extra_large_net_yuan, null)
        assert.equal(res.availability.state, 'unavailable')
    } finally {
        fetchBoardRowsMock.mock.restore()
    }
})