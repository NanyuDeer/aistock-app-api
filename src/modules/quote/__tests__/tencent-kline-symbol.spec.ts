/**
 * TencentKlineService 符号归一测试。
 *
 * 背景（2026-11-10 M0 上线验证）：`POST /internal/market/causal-inputs` 传
 * `000300.SH` 时 prices 为空、completeness.prices=false；传裸码 `600519` 正常。
 * 根因：URL 构造直接 `${tencentPrefix}${symbol}`，而 getStockIdentity 只看前 3 位
 * 且不剥离交易所后缀 —— `000300.SH` 被拼成 `sz000300.SH`（腾讯无此代码），
 * 指数（000300/000905）与深市个股（000001）按前缀无法区分。
 *
 * 契约：显式交易所后缀优先；裸 6 位码沿用 getStockIdentity 前缀判定；
 * 已带 sh/sz/bj 前缀的写法原样保留。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TencentKlineService } from '../TencentKlineService'

const svc = TencentKlineService as unknown as {
    buildKlineUrl(options: { symbol: string; klt?: number; fqt?: number; limit?: number; startDate?: string; endDate?: string }): URL
    buildMinuteUrl(options: { symbol: string; klt?: number; fqt?: number; limit?: number }): URL
    fetchKlineJson(url: URL): Promise<any>
    getKLine(options: { symbol: string; klt?: number; fqt?: number; limit?: number }): Promise<Record<string, any>[]>
}

function klineCode(symbol: string): string {
    const param = svc.buildKlineUrl({ symbol, klt: 101, fqt: 1, limit: 48 }).searchParams.get('param') || ''
    return param.split(',')[0]
}

test('带 .SH 后缀的指数按沪市取码（000300.SH → sh000300）', () => {
    assert.strictEqual(klineCode('000300.SH'), 'sh000300')
})

test('带后缀的个股按后缀取码（600519.SH → sh600519，000001.SZ → sz000001）', () => {
    assert.strictEqual(klineCode('600519.SH'), 'sh600519')
    assert.strictEqual(klineCode('000001.SZ'), 'sz000001')
    assert.strictEqual(klineCode('920001.BJ'), 'bj920001')
})

test('裸 6 位码沿用前缀判定（600519 → sh600519，000001 → sz000001）', () => {
    assert.strictEqual(klineCode('600519'), 'sh600519')
    assert.strictEqual(klineCode('000001'), 'sz000001')
})

test('已带 sh/sz/bj 前缀的写法原样保留（sh000300 → sh000300）', () => {
    assert.strictEqual(klineCode('sh000300'), 'sh000300')
})

test('分钟级 URL 同样按后缀取码（000300.SH → sh000300,m1）', () => {
    const param = svc.buildMinuteUrl({ symbol: '000300.SH', klt: 1, fqt: 0, limit: 300 }).searchParams.get('param') || ''
    assert.ok(param.startsWith('sh000300,m1'), `param 应以 sh000300,m1 开头: ${param}`)
})

test('getKLine 必须按同一套取码读取响应键（000300.SH 不能因键不一致丢数据）', async () => {
    const original = svc.fetchKlineJson
    // 腾讯响应按 sh000300 存放，若 getKLine 仍用旧逻辑拼 sz000300.SH 就会取不到
    svc.fetchKlineJson = async () => ({
        code: 0,
        data: {
            sh000300: { day: [['2026-11-06', '19000.00', '19310.80', '19769.10', '18824.20', '1234567.0']] },
        },
    })
    try {
        const bars = await svc.getKLine({ symbol: '000300.SH', klt: 101, fqt: 0, limit: 48 })
        assert.strictEqual(bars.length, 1, `期望 1 根日 K，实际 ${bars.length}`)
        assert.strictEqual(bars[0]['收盘价'], 19310.8)
    } finally {
        svc.fetchKlineJson = original
    }
})
