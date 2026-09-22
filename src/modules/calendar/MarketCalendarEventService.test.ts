import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { DDL_MARKET_CALENDAR_EVENTS, normalizeTitle, listEvents, upsertEvent, toContractEvent } from './MarketCalendarEventService'
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

// mock pool.query 捕获 SQL 文本与参数数组，供 CASE 子句与透传位次断言用。
// Pool 引用是模块级单例；测试间覆盖/还原与既有 fixture（listEvents 折叠测试）一致。
let capturedSql = ''
let capturedParams: unknown[] | null = null

test('upsertEvent CASE 保护：已存在 high 行不被降级、source 不被改写', async () => {
  const orig = pool.query
  ;(pool as any).query = async (sql: string, params?: unknown[]) => {
    capturedSql = sql
    capturedParams = params ?? null
    return { rows: [{ id: '1', inserted: true }], rowCount: 1 }
  }
  try {
    await upsertEvent({ event_date: '2026-10-01', title: '美联储利率决议', importance: 'high' })
    // X1：importance/source SET 必须被 CASE 保护，不得直接覆盖
    assert.ok(
      capturedSql.includes(
        "importance = CASE WHEN market_calendar_events.importance = 'high' THEN 'high' ELSE EXCLUDED.importance END",
      ),
      'importance SET 应被 CASE 保护（已存在 high 不被降级）',
    )
    assert.ok(
      capturedSql.includes(
        "source = CASE WHEN market_calendar_events.importance = 'high' THEN market_calendar_events.source ELSE EXCLUDED.source END",
      ),
      'source SET 应被 CASE 保护（已存在 high 的 source 不被改写）',
    )
  } finally {
    ;(pool as any).query = orig
  }
})

test('upsertEvent 透传 result_source / result_attempted_at 到参数数组位次', async () => {
  const orig = pool.query
  ;(pool as any).query = async (sql: string, params?: unknown[]) => {
    capturedSql = sql
    capturedParams = params ?? null
    return { rows: [{ id: '1', inserted: true }], rowCount: 1 }
  }
  try {
    await upsertEvent({
      event_date: '2026-10-01',
      title: '美联储利率决议',
      result_source: 'auto',
      result_attempted_at: '2026-10-01T09:00:00Z',
    })
    assert.ok(capturedParams, 'upsertEvent 应传入参数数组')
    assert.ok(capturedSql.includes('result_source'), 'INSERT 列清单应含 result_source')
    assert.ok(capturedSql.includes('result_attempted_at'), 'INSERT 列清单应含 result_attempted_at')
    // 位次：event_date,title,importance,market,event_time,source,detail,result,result_source,result_attempted_at,dedup_hash
    assert.equal(capturedParams![0], '2026-10-01')
    assert.equal(capturedParams![8], 'auto')
    assert.equal(capturedParams![9], '2026-10-01T09:00:00Z')
  } finally {
    ;(pool as any).query = orig
  }
})

test('toContractEvent 加性透传 detail（预期差 job 读 consensus 用）', () => {
  // 有 detail → 透传（含 consensus 前缀）；无 detail → null（保持既有键，不缺省）
  const withDetail = toContractEvent({ id: 1, event_date: '2026-09-21', title: '图表', importance: 'high', market: 'CN', event_time: null, source: 'L4', detail: 'x｜consensus:1%', result: null } as any)
  assert.equal(withDetail.detail, 'x｜consensus:1%')
  const noDetail = toContractEvent({ id: 2, event_date: '2026-09-21', title: '图表2', importance: 'high', market: 'CN', event_time: null, source: 'L4', detail: null, result: null } as any)
  assert.equal(noDetail.detail, null)
  assert.ok('detail' in noDetail, 'detail 键应存在（null 也透传，禁省略导致读侧 undefined）')
})

// 终审 C1：toContractEvent 加性透传原始 event_date（US 隔夜 date 顺延后定位 dedup 键用）
test('toContractEvent 透传原始 event_date（供预期差 job 回写定位）', () => {
  const withDate = toContractEvent({ id: 1, event_date: '2026-10-28', title: 'FOMC', importance: 'high', market: 'US_OVERNIGHT', event_time: '22:00', source: 'L2', detail: null, result: null } as any)
  assert.equal(withDate.event_date, '2026-10-28', '原始 event_date 应作为 event_date 透传（不被 date 顺延覆盖）')
  // date 因隔夜顺延而为反应日（≠原始 event_date），event_date 保留原始 → 两者可分离
  assert.notEqual(withDate.date, withDate.event_date)
})