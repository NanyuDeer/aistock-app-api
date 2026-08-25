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

import { VALID_REPORT_TYPES } from '../src/core/routes/internal'
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