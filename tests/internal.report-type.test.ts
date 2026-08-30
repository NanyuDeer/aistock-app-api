/**
 * Task 1 (盘中报 MVP): VALID_REPORT_TYPES 白名单放行 'midday' 报告类型
 *
 * 测试策略（适配 Node 原生 test runner，非 jest/vitest）：
 * 断言 internal.ts 导出的 VALID_REPORT_TYPES 包含 'midday'，
 * 使 POST/GET/list/公开路由对 midday 报告类型放行。
 *
 * 资源清理：internalRouter 依赖 PG pool / Redis / keepAlive HTTP agents，
 * 测试结束后显式关闭让进程自然退出（与 internal.index-quotes.test.ts 同一约定）。
 */

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { VALID_REPORT_TYPES, getReportTtlDays } from '../src/core/routes/internal'
import pool from '../src/core/db'
import redis from '../src/core/redis'
import { closeAllAgents } from '../src/shared/utils/httpAgent'

after(async () => {
    await pool.end()
    redis.disconnect()
    await closeAllAgents()
})

test('VALID_REPORT_TYPES 允许 midday 报告类型', () => {
    assert.ok(VALID_REPORT_TYPES.includes('midday'), 'VALID_REPORT_TYPES 应包含 midday')
})

test('rhythm_master 报告 TTL=90 天（支撑 60 交易日热力图窗口），其余类型保持 7 天', () => {
    // design-debate A4/U1 裁决：rhythm_master 需支撑日历热力图聚合，
    // 其余 report_type 维持建表默认 7 天 TTL，避免 03:00 清理过早删除。
    assert.equal(getReportTtlDays('rhythm_master'), 90)
    assert.equal(getReportTtlDays('morning'), 7)
    assert.equal(getReportTtlDays('event_conduction'), 7)
    assert.equal(getReportTtlDays('midday'), 7)
})