/**
 * 节奏日历热力图聚合（契约 #7，design-debate R7 裁决）：
 * 聚合逻辑纯函数测试——"最近 N 个交易日"与"after_close 行"合并为补位网格。
 *
 * level 可空契约：行缺失/沿用前值 → level=null（前端灰格），与"行存在但 level=null"分开。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeRhythmCalendarDays } from '../src/modules/calendar/publicRouter'

test('mergeRhythmCalendarDays：行缺失日期补 level=null（灰格），有行日期透传 level/score/basis_date', () => {
    const dates = ['2026-08-28', '2026-08-31', '2026-09-01']
    const rows = [
        { report_date: '2026-08-31', level: 'active', score: '59.9', basis_date: '2026-08-28' },
        { report_date: '2026-09-01', level: null, score: null, basis_date: null },
    ]
    const items = mergeRhythmCalendarDays(dates, rows)
    assert.equal(items.length, 3)
    // 行缺失 → 灰格（level=null）
    assert.deepEqual(items[0], { date: '2026-08-28', refresh_slot: 'after_close', level: null, score: null, basis_date: null })
    // 有行 → 透传 level/score（score 字符串转 number）
    assert.equal(items[1].level, 'active')
    assert.equal(items[1].score, 59.9)
    assert.equal(items[1].basis_date, '2026-08-28')
    assert.equal(items[1].refresh_slot, 'after_close')
    // 行存在但 level=null（沿用前值）→ 同样灰格，但与"行缺失"共用 null 契约
    assert.equal(items[2].level, null)
})

test('mergeRhythmCalendarDays：日期顺序与传入一致（服务端已按交易日展开）', () => {
    const dates = ['2026-09-01', '2026-08-31', '2026-08-28']
    const items = mergeRhythmCalendarDays(dates, [])
    assert.deepEqual(items.map((i) => i.date), dates)
    assert.ok(items.every((i) => i.level === null))
})
