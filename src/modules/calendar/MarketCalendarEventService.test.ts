import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { DDL_MARKET_CALENDAR_EVENTS } from './MarketCalendarEventService'
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