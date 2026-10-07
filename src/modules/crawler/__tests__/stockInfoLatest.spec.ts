// 运行：node --import tsx --test src/modules/crawler/__tests__/stockInfoLatest.spec.ts
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { StockInfoService } from '../StockInfoService';
import pool from '../../../core/db'; // 实际：core/db 默认导出 pool

test('getLatestBySymbol 按 symbol 取最新一条', async (t) => {
  const m = mock.method(pool, 'query', async () => ({
    rows: [{ symbol: '600383', stock_name: '金地集团', ai_impact: '利好',
             ai_horizon: '短期', ai_summary: '一句话结论', published_at: null, url: null }],
  }));
  t.after(() => m.mock.restore());

  const out = await StockInfoService.getLatestBySymbol('600383');

  assert.equal(out?.ai_summary, '一句话结论');
  const firstCall = m.mock.calls[0];
  const sql = String(firstCall.arguments[0]);
  // Node25 @types 将 mock calls 的 arguments 建模为固定元组，arguments[1] 推断为 undefined，
  // 故用 unknown 注解读取实参（运行时即 ['600383']），不做 as any。
  const params: unknown = firstCall.arguments[1];
  assert.ok(sql.includes('FROM stock_info_judgements'), 'SQL 须查 stock_info_judgements');
  assert.ok(sql.includes('ORDER BY'), 'SQL 须排序以取最新');
  assert.deepEqual(params, ['600383']);
});

test('getLatestBySymbol 无数据返回 null', async (t) => {
  const m = mock.method(pool, 'query', async () => ({ rows: [] }));
  t.after(() => m.mock.restore());

  assert.equal(await StockInfoService.getLatestBySymbol('000001'), null);
});
