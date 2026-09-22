import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { DDL_MARKET_CALENDAR_EVENTS, normalizeTitle, listEvents } from './MarketCalendarEventService'
import pool from '../../core/db'

const ORIGINAL_QUERY = pool.query
before(() => {
  ;(pool as any).query = async () => ({ rows: [], rowCount: 0 })
})
after(async () => {
  ;(pool as any).query = ORIGINAL_QUERY
  await pool.end()
})

// TDD：先断言建表 DDL 常量含 result_source/result_attempted_at 两列（单测无法真连 PG，
// 与 index.ts 共用同一 DDL 常量作字面量断言，防跨处漂移）。常量未定义时应 FAIL（RED）。
test('result_source/result_attempted_at 列存在（建表 DDL 含两列）', () => {
  assert.ok(DDL_MARKET_CALENDAR_EVENTS.includes('result_source TEXT'))
  assert.ok(DDL_MARKET_CALENDAR_EVENTS.includes('result_attempted_at TIMESTAMPTZ'))
})

// TDD：RED 阶段，normalizeTitle 尚未剥离白名单后缀/碎片段时应 FAIL。
test('normalizeTitle 剥离平台后缀与尾部丨片段', () => {
  assert.equal(normalizeTitle('美联储利率决议 - Moomoo'), normalizeTitle('美联储利率决议'))
  assert.equal(normalizeTitle('美联储利率决议丨东方财富'), normalizeTitle('美联储利率决议'))
  assert.equal(normalizeTitle('美联储利率决议'), '美联储利率决议')
})

// TDD：RED 阶段，listEvents 无折叠合并时应 FAIL。
test('listEvents 读侧折叠近似重复并附 merged_count', async () => {
  const orig = pool.query
  ;(pool as any).query = async () => ({
    rows: [
      { id: 1, event_date: '2026-10-01', title: '美联储利率决议', importance: 'high', market: 'CN', event_time: null, source: 'L2', detail: null, result: null },
      { id: 2, event_date: '2026-10-01', title: '美联储利率决议 - Moomoo', importance: 'medium', market: 'CN', event_time: null, source: 'L2', detail: null, result: null },
    ],
    rowCount: 2,
  })
  try {
    const rows = await listEvents('2026-10-01', '2026-10-05')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].importance, 'high')
    assert.equal(rows[0].merged_count, 2)
  } finally {
    ;(pool as any).query = orig
  }
})

// Plan-mandated 锁定测试：堵死"importance 优先"被 result 加权推翻的原公式缺陷。
// mock 返回同 event_date、归一标题相同、但顺序为 medium+result 在前、high 无 result 在后 →
// 原公式 curScore=(1+1)=2 vs prevScore=(2+0)=2 平手保留先见 medium；必须改为字典序后保留 high。
test('listEvents 折叠按字典序：high(无 result) 优先于 medium(result 非空)', async () => {
  const orig = pool.query
  ;(pool as any).query = async () => ({
    rows: [
      { id: 1, event_date: '2026-10-01', title: '美联储利率决议', importance: 'medium', market: 'CN', event_time: null, source: 'L2', detail: null, result: '加息 25bp' },
      { id: 2, event_date: '2026-10-01', title: '美联储利率决议 - Moomoo', importance: 'high', market: 'CN', event_time: null, source: 'L2', detail: null, result: null },
    ],
    rowCount: 2,
  })
  try {
    const rows = await listEvents('2026-10-01', '2026-10-05')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].importance, 'high')
    // 保留 high 行：id=2 且 result 为原 high 行才说明真的用 high 替换了 medium
    assert.equal(rows[0].id, 2)
    assert.equal(rows[0].merged_count, 2)
  } finally {
    ;(pool as any).query = orig
  }
})