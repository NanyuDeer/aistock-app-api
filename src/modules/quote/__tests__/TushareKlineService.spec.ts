/**
 * TushareKlineService.getIndexKLine 行规范化单元测试（2026-09-05 核实修复）。
 *
 * 背景：`GET /internal/index/:code/kline` 的 vol/amount 在 service 层行规范化时被
 * 丢弃，导致返回行恒为 null，量能分支退化为伪分支。此处用纯函数
 * `normalizeIndexKLineRow` 锁定行契约：六 OHLC 中文键 + 加性透传 vol/amount
 * （Tushare index_daily 原始单位：vol=手、amount=千元；缺失如实为 null，不误填 0）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeIndexKLineRow } from '../TushareKlineService'

test('normalizeIndexKLineRow 透传 vol/amount（原始 Tushare 值）', () => {
    const out = normalizeIndexKLineRow({
        trade_date: '20260904',
        open: 3900,
        high: 3950,
        low: 3880,
        close: 3930.1164,
        pre_close: 3890,
        pct_chg: 1.03,
        vol: 4.2e8,
        amount: 8.0e8,
    })
    assert.equal(out['时间'], '20260904')
    assert.equal(out['收盘价'], 3930.1164)
    assert.equal(out['涨跌幅'], 1.03)
    assert.equal(out.vol, 4.2e8)
    assert.equal(out.amount, 8.0e8)
})

test('normalizeIndexKLineRow vol/amount 缺失 → null（不误填 0）', () => {
    const out = normalizeIndexKLineRow({ trade_date: '20260904', close: 3900 })
    assert.equal(out.vol, null)
    assert.equal(out.amount, null)
})

test('normalizeIndexKLineRow 无 pct_chg 时由 pre_close 推算涨跌幅', () => {
    const out = normalizeIndexKLineRow({ trade_date: '20260904', close: 4000, pre_close: 3900 })
    // (4000-3900)/3900*100 ≈ 2.5641 → round 2 位 → 2.56
    assert.equal(out['涨跌幅'], 2.56)
})
