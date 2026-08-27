/**
 * TradingCalendarService.getPreviousTradingDay 单元测试
 *
 * 关键日期：2026-07-17(五)/2026-07-20(一) 为交易日；2026-07-18(六)/19(日) 休市。
 * 节假日：2026-10-01~07 国庆休市，2026-10-08(四) 为节后首个交易日。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { TradingCalendarService } from '../src/shared/utils/TradingCalendarService'

test('getPreviousTradingDay returns the prior Friday for a Monday 15:10', () => {
    const monday = new Date('2026-07-20T07:10:00.000Z') // 15:10 Asia/Shanghai
    const prev = TradingCalendarService.getPreviousTradingDay(monday)
    assert.equal(prev.toISOString().slice(0, 10), '2026-07-17')
})

test('getPreviousTradingDay returns Friday for a weekend daytime', () => {
    const sunday = new Date('2026-07-19T02:00:00.000Z') // 10:00 Asia/Shanghai
    const prev = TradingCalendarService.getPreviousTradingDay(sunday)
    assert.equal(prev.toISOString().slice(0, 10), '2026-07-17')
})

test('getPreviousTradingDay ignores wall-clock hour (03:00 same day)', () => {
    const mondayEarly = new Date('2026-07-19T19:00:00.000Z') // 周一 03:00 Asia/Shanghai
    const prev = TradingCalendarService.getPreviousTradingDay(mondayEarly)
    assert.equal(prev.toISOString().slice(0, 10), '2026-07-17')
})

test('getPreviousTradingDay skips long holidays backwards', () => {
    const afterHoliday = new Date('2026-10-08T02:00:00.000Z') // 周四 10:00 Asia/Shanghai
    const prev = TradingCalendarService.getPreviousTradingDay(afterHoliday)
    assert.equal(prev.toISOString().slice(0, 10), '2026-09-30')
})

test('getPreviousTradingDay fails closed after calendar coverage', () => {
    assert.throws(
        () => TradingCalendarService.getPreviousTradingDay(new Date('2026-12-31T16:30:00.000Z')),
        /Trading calendar is not available for 2027/,
    )
})
