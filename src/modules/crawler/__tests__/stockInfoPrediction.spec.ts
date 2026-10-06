// 运行：node --import tsx --test src/modules/crawler/__tests__/stockInfoPrediction.spec.ts
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import pool from '../../../core/db';
import {
  StockInfoPredictionService,
  __stockInfoPredictionDependencies,
  type StockInfoCandidate,
} from '../services/StockInfoPredictionService';

/**
 * 注入 forward 依赖并记录调用参数；用例结束后复位（避免跨用例污染）。
 * 返回的 calls 收集传给 forward 的候选（运行时即 HTTP body 的来源）。
 */
function stubForward(
  t: { after: (fn: () => void) => void },
  impl: (candidate: StockInfoCandidate) => Promise<void>,
): { calls: StockInfoCandidate[] } {
  const original = __stockInfoPredictionDependencies.forward;
  const calls: StockInfoCandidate[] = [];
  __stockInfoPredictionDependencies.forward = async (candidate) => {
    calls.push(candidate);
    await impl(candidate);
  };
  t.after(() => {
    __stockInfoPredictionDependencies.forward = original;
  });
  return { calls };
}

test('ingest 将候选按上海自然日转发（forward 恰好一次）', async (t) => {
  const m = mock.method(pool, 'query', async () => ({
    rows: [
      {
        symbol: '600383',
        stock_name: '金地集团',
        published_date: '2026-09-29',
        ai_impact: '利好',
        ai_horizon: '中期',
        ai_summary: '一句话结论',
        url: 'https://example.com/a',
      },
    ],
  }));
  t.after(() => m.mock.restore());
  const { calls } = stubForward(t, async () => {});

  await StockInfoPredictionService.ingest([
    { symbol: '600383', stock_name: '金地集团', published_at: '2026-09-29T16:00:00+08:00' },
  ]);

  assert.equal(calls.length, 1, 'forward 应恰好调用 1 次');
  assert.equal(calls[0].symbol, '600383');
  assert.equal(calls[0].published_date, '2026-09-29', 'body 的 published_date 应为上海自然日');
  // +08:00 的 16:00 仍属当日 → 归日为 2026-09-29
  const params: unknown = m.mock.calls[0].arguments[1];
  assert.deepEqual(params, [['600383'], ['2026-09-29']]);
});

test('中性 / 利好+短期 候选仍被转发（门槛唯一判定点在 agent-py）', async (t) => {
  const m = mock.method(pool, 'query', async () => ({
    rows: [
      {
        symbol: '000001',
        stock_name: '平安银行',
        published_date: '2026-09-29',
        ai_impact: '中性',
        ai_horizon: '短期',
        ai_summary: '中性',
        url: null,
      },
      {
        symbol: '300750',
        stock_name: '宁德时代',
        published_date: '2026-09-29',
        ai_impact: '利好',
        ai_horizon: '短期',
        ai_summary: '短期利好',
        url: null,
      },
    ],
  }));
  t.after(() => m.mock.restore());
  const { calls } = stubForward(t, async () => {});

  await StockInfoPredictionService.ingest([
    { symbol: '000001', published_at: '2026-09-29T10:00:00+08:00' },
    { symbol: '300750', published_at: '2026-09-29T11:00:00+08:00' },
  ]);

  assert.equal(calls.length, 2, 'app-api 不得本地过滤门槛，中性/利好短期也要转发');
  assert.deepEqual(calls.map((c) => c.ai_impact), ['中性', '利好']);
});

test('同一 symbol + day 的 raw 去重后只查一次、pairs 长度 1', async (t) => {
  const m = mock.method(pool, 'query', async () => ({ rows: [] }));
  t.after(() => m.mock.restore());
  const { calls } = stubForward(t, async () => {});

  await StockInfoPredictionService.ingest([
    { symbol: '600383', published_at: '2026-09-29T09:00:00+08:00' },
    { symbol: '600383', published_at: '2026-09-29T15:00:00+08:00' },
  ]);

  assert.equal(m.mock.calls.length, 1, '批次内应合并为一次查询');
  const params: unknown = m.mock.calls[0].arguments[1];
  assert.deepEqual(params, [['600383'], ['2026-09-29']], 'pairs 应去重为长度 1');
  assert.equal(calls.length, 0);
});

test('collectCandidates SQL 含 DISTINCT ON / 时区 / CASE 强度排序，参数为两个数组', async (t) => {
  const m = mock.method(pool, 'query', async () => ({ rows: [] }));
  t.after(() => m.mock.restore());

  await StockInfoPredictionService.collectCandidates([
    { symbol: '600383', publishedDate: '2026-09-29' },
  ]);

  const sql = String(m.mock.calls[0].arguments[0]);
  assert.ok(sql.includes('DISTINCT ON'), '须用 DISTINCT ON 做当日去重');
  assert.ok(sql.includes("AT TIME ZONE 'Asia/Shanghai'"), '须按上海自然日归日');
  assert.ok(sql.includes('ORDER BY'), '须排序取当日最强口径');
  assert.ok(sql.includes('CASE j.ai_impact'), '强度排序须用 CASE');
  const params: unknown = m.mock.calls[0].arguments[1];
  assert.ok(Array.isArray(params), '参数应为数组');
  assert.deepEqual(params, [['600383'], ['2026-09-29']]);
});

test('published_at 上海自然日：+08:00 的 16:00 归当日、次日 01:00 归次日', async (t) => {
  const m = mock.method(pool, 'query', async () => ({ rows: [] }));
  t.after(() => m.mock.restore());
  const { calls } = stubForward(t, async () => {});

  await StockInfoPredictionService.ingest([
    { symbol: '600383', published_at: '2026-09-29T16:00:00+08:00' },
    { symbol: '300750', published_at: '2026-09-30T01:00:00+08:00' },
  ]);

  const params: unknown = m.mock.calls[0].arguments[1];
  assert.deepEqual(params, [['600383', '300750'], ['2026-09-29', '2026-09-30']]);
  assert.equal(calls.length, 0);
});

test('forward 抛异常时 ingest 不抛（fail-safe）', async (t) => {
  const m = mock.method(pool, 'query', async () => ({
    rows: [
      {
        symbol: '600383',
        stock_name: '金地集团',
        published_date: '2026-09-29',
        ai_impact: '利好',
        ai_horizon: '中期',
        ai_summary: 'x',
        url: null,
      },
    ],
  }));
  t.after(() => m.mock.restore());
  stubForward(t, async () => {
    throw new Error('network down');
  });

  await assert.doesNotReject(
    StockInfoPredictionService.ingest([
      { symbol: '600383', published_at: '2026-09-29T09:00:00+08:00' },
    ]),
  );
});

test('collectCandidates 查询异常时 ingest 不抛（fail-safe）', async (t) => {
  const m = mock.method(pool, 'query', async () => {
    throw new Error('db down');
  });
  t.after(() => m.mock.restore());
  const { calls } = stubForward(t, async () => {});

  await assert.doesNotReject(
    StockInfoPredictionService.ingest([
      { symbol: '600383', published_at: '2026-09-29T09:00:00+08:00' },
    ]),
  );
  assert.equal(calls.length, 0);
});

test('symbol 非法或 published_at 缺失/非法时跳过，不查库不转发', async (t) => {
  const m = mock.method(pool, 'query', async () => ({ rows: [] }));
  t.after(() => m.mock.restore());
  const { calls } = stubForward(t, async () => {});

  await StockInfoPredictionService.ingest([
    { symbol: 'ABC', published_at: '2026-09-29T09:00:00+08:00' },
    { symbol: '600383', published_at: null },
    { symbol: '600383' },
    { symbol: '600383', published_at: 'not-a-date' },
  ]);

  assert.equal(m.mock.calls.length, 0);
  assert.equal(calls.length, 0);
});

test('空批次不查库不转发', async (t) => {
  const m = mock.method(pool, 'query', async () => ({ rows: [] }));
  t.after(() => m.mock.restore());
  const { calls } = stubForward(t, async () => {});

  await StockInfoPredictionService.ingest([]);

  assert.equal(m.mock.calls.length, 0);
  assert.equal(calls.length, 0);
});
