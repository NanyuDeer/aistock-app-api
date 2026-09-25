/**
 * CalendarEntityMaterializer 纯函数测试：qualifyCalendarEvent / toCalendarEntityInput。
 * 不需要 mock 数据库，纯函数断言。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { qualifyCalendarEvent, toCalendarEntityInput, type CalendarRowLike } from './CalendarEntityMaterializer'

test('qualifyCalendarEvent: importance=high → true', () => {
    const row: CalendarRowLike = {
        event_date: '2026-09-30',
        title: '美联储利率决议',
        importance: 'high',
        source: 'L2',
        detail: null,
    }
    assert.equal(qualifyCalendarEvent(row), true)
})

test('qualifyCalendarEvent: source=L4 → true', () => {
    const row: CalendarRowLike = {
        event_date: '2026-10-15',
        title: '中国三季度GDP',
        importance: 'medium',
        source: 'L4',
        detail: '种子事件',
    }
    assert.equal(qualifyCalendarEvent(row), true)
})

test('qualifyCalendarEvent: medium+L3 → false（防止时间线退化成普通活动日历）', () => {
    const row: CalendarRowLike = {
        event_date: '2026-09-30',
        title: '日常数据公告',
        importance: 'medium',
        source: 'L3',
        detail: null,
    }
    assert.equal(qualifyCalendarEvent(row), false)
})

test('qualifyCalendarEvent: low+L2 → false', () => {
    const row: CalendarRowLike = {
        event_date: '2026-09-30',
        title: '低优事件',
        importance: 'low',
        source: 'L2',
        detail: null,
    }
    assert.equal(qualifyCalendarEvent(row), false)
})

test('toCalendarEntityInput: date-only 时间格式正确', () => {
    const row: CalendarRowLike = {
        event_date: '2026-10-01',
        title: '国庆节',
        importance: 'high',
        source: 'L4',
        detail: '国庆假期',
    }
    const input = toCalendarEntityInput(row)
    assert.equal(input.event_start_time, '2026-10-01T00:00:00+08:00')
    assert.equal(input.source_type, 'calendar')
    assert.equal(input.time_source, 'calendar')
    assert.equal(input.time_confidence, 0.95)
    assert.equal(input.summary, '国庆假期')
    assert.equal(input.source_event_id, null)
})

test('toCalendarEntityInput: end = start（单日事件）', () => {
    const row: CalendarRowLike = {
        event_date: '2026-12-25',
        title: '圣诞节',
        importance: 'high',
        source: 'L2',
    }
    const input = toCalendarEntityInput(row)
    assert.equal(input.event_end_time, input.event_start_time)
    assert.equal(input.event_end_time, '2026-12-25T00:00:00+08:00')
})

test('toCalendarEntityInput: detail 为 null 时 summary 为 null', () => {
    const row: CalendarRowLike = {
        event_date: '2026-11-01',
        title: 'PMI数据',
        importance: 'high',
        source: 'L2',
        detail: null,
    }
    const input = toCalendarEntityInput(row)
    assert.equal(input.summary, null)
})

test('toCalendarEntityInput: detail 为 undefined 时 summary 为 null', () => {
    const row: CalendarRowLike = {
        event_date: '2026-11-01',
        title: 'PMI数据',
        importance: 'high',
        source: 'L2',
    }
    const input = toCalendarEntityInput(row)
    assert.equal(input.summary, null)
})

test('qualifyCalendarEvent: high 即使 source 不是 L4 也通过', () => {
    const row: CalendarRowLike = {
        event_date: '2026-10-01',
        title: 'FOMC',
        importance: 'high',
        source: 'L2',
    }
    assert.equal(qualifyCalendarEvent(row), true)
})

test('qualifyCalendarEvent: L4 即使 importance 不是 high 也通过', () => {
    const row: CalendarRowLike = {
        event_date: '2026-10-01',
        title: '人工录入种子',
        importance: 'medium',
        source: 'L4',
    }
    assert.equal(qualifyCalendarEvent(row), true)
})