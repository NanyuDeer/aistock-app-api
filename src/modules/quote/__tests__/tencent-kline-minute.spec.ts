/**
 * TencentKlineService 分钟级（klt=1 分时）数据源测试。
 *
 * 背景：分时 K 线（klt=1）曾因腾讯 fqkline/get 不支持 m1 周期直接返回空，
 * 且公开 /api/cn/stock/quotes/kline 控制器走 TushareKlineService(paid min_data)。
 * 修复：分钟级改走腾讯 kline/mkline 接口（user 实测可返回 m1 数据），日/周/月仍走 fqkline。
 * 本测试锁定：分钟 URL 构造 + 分钟行解析为完整中文键字段（不依赖真实网络）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TencentKlineService } from '../TencentKlineService'

const svc = TencentKlineService as unknown as {
    buildMinuteUrl(options: { symbol: string; klt?: number; fqt?: number; limit?: number }): URL
    arrayRowsToKLine(rows: unknown[]): Record<string, any>[]
}

test('TencentKlineService 分钟 URL 使用 kline/mkline 且参数含 m1 周期', () => {
    const url = svc.buildMinuteUrl({ symbol: '600519', klt: 1, fqt: 0, limit: 300 })
    assert.strictEqual(url.hostname, 'ifzq.gtimg.cn')
    const param = url.searchParams.get('param') || ''
    assert.ok(param.startsWith('sh600519,m1'), `param 应以 sh600519,m1 开头: ${param}`)
    assert.ok(param.endsWith(',300,'), `param 应以 ,300, 结尾（限窗口）: ${param}`)
})

test('TencentKlineService 分钟行解析出完整中文键字段（klt=1 返回非空）', () => {
    // 腾讯 mkline m1 实测行：[时间, 开, 收, 高, 低, 量, {}, 额]
    const rows: unknown[] = [
        ['202608240931', '1272.00', '1273.10', '1274.90', '1270.60', '558.00', {}, '0.45'],
        ['202608240932', '1274.23', '1278.63', '1279.47', '1273.00', '570.00', {}, '0.46'],
    ]
    const items = svc.arrayRowsToKLine(rows)

    assert.strictEqual(items.length, 2)
    const first = items[0]
    assert.strictEqual(first['时间'], '202608240931')
    assert.strictEqual(first['开盘价'], 1272.0)
    assert.strictEqual(first['收盘价'], 1273.1)
    assert.strictEqual(first['最高价'], 1274.9)
    assert.strictEqual(first['最低价'], 1270.6)
    assert.strictEqual(first['成交量'], 558.0)
    // 关键：常规分时应至少 2 个有效点，MiniKLine 的 renderable 判定才满足
    assert.ok(items.length >= 2, '分钟序列应至少 2 根，保证前端 mini 分时可渲染')
})

test('TencentKlineService 分钟行遇到空数组返回空', () => {
    assert.deepStrictEqual(svc.arrayRowsToKLine([]), [])
    assert.deepStrictEqual(svc.arrayRowsToKLine(null as unknown as unknown[]), [])
})