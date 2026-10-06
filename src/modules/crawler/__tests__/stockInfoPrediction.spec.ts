// 运行：node --import tsx --test src/modules/crawler/__tests__/stockInfoPrediction.spec.ts
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import pool from '../../../core/db';
import type { StockInfoCandidate } from '../services/StockInfoPredictionService';

/**
 * 服务模块的 `AGENT_PY_URL` / `INTERNAL_TOKEN` 是**模块级常量**，在模块加载时读取 env。
 * ESM import 会被提升到文件顶部，先赋值 env 再 import 无效；因此这里先注入 env，
 * 再用 require 加载模块，从而让 defaultForward 的 URL 拼接与 header 取值可被断言。
 */
const TEST_AGENT_PY_URL = 'http://agent-py.test:8123';
const TEST_INTERNAL_TOKEN = 'test-internal-token-1234567890';
process.env.AGENT_PY_URL = TEST_AGENT_PY_URL;
process.env.INTERNAL_API_TOKEN = TEST_INTERNAL_TOKEN;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const stockInfoPredictionModule = require(
  '../services/StockInfoPredictionService',
) as typeof import('../services/StockInfoPredictionService');
const { StockInfoPredictionService, __stockInfoPredictionDependencies } = stockInfoPredictionModule;

/**
 * StockInfoService 也须用 require 加载：它静态 import 了 StockInfoPredictionService，
 * 若用顶层 ESM import 会先于上面的 env 注入执行，导致模块级 URL/token 常量取到默认值。
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { StockInfoService } = require('../StockInfoService') as typeof import('../StockInfoService');

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

// ─────────────────────────────────────────────────────────────────────────────
// defaultForward 真实转发链路 + 响应分支覆盖
// 不改实现：直接调用未打桩的 __stockInfoPredictionDependencies.forward（默认值即 defaultForward），
// 并 mock 掉全局 fetch 与 console.warn，以覆盖 URL/headers/body 与四个响应分支。
// ─────────────────────────────────────────────────────────────────────────────

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const defaultForwardCandidate: StockInfoCandidate = {
  symbol: '600383',
  stock_name: '金地集团',
  published_date: '2026-09-29',
  ai_impact: '利好',
  ai_horizon: '中期',
  ai_summary: '一句话结论',
  url: 'https://example.com/a',
};

/**
 * 为真实转发用例打桩：mock 全局 fetch + console.warn，并注入 timeoutMs。
 * 各用例独立打桩并按 t.after 复位，避免相互污染；warnCount 用调用次数断言「告警/不告警」。
 */
function stubForwardIo(
  t: { after: (fn: () => void) => void },
  respond: (url: string, init: FetchInit) => Response,
): { fetchCalls: Array<{ url: string; init: FetchInit }>; warnCount: () => number } {
  const originalTimeout = __stockInfoPredictionDependencies.timeoutMs;
  __stockInfoPredictionDependencies.timeoutMs = 1234;
  const fetchCalls: Array<{ url: string; init: FetchInit }> = [];
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async (input: FetchInput, init?: FetchInit): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url, init });
      return respond(url, init);
    },
  );
  const warnMock = mock.method(console, 'warn', () => {});
  t.after(() => {
    fetchMock.mock.restore();
    warnMock.mock.restore();
    __stockInfoPredictionDependencies.timeoutMs = originalTimeout;
  });
  return { fetchCalls, warnCount: () => warnMock.mock.calls.length };
}

test('defaultForward（a）：URL/headers/body 请求形态正确', async (t) => {
  const io = stubForwardIo(
    t,
    () => new Response(JSON.stringify({ status: 'skipped' }), { status: 200 }),
  );

  await __stockInfoPredictionDependencies.forward(defaultForwardCandidate);

  assert.equal(io.fetchCalls.length, 1, 'fetch 应恰好调用 1 次');
  const { url, init } = io.fetchCalls[0];
  assert.equal(url, `${TEST_AGENT_PY_URL}/api/agent/internal/predictions/from-stock-info`);
  assert.ok(url.endsWith('/api/agent/internal/predictions/from-stock-info'));
  assert.equal(init?.method, 'POST');
  const headers = init?.headers as unknown as Record<string, string>;
  assert.equal(headers['x-internal-token'], TEST_INTERNAL_TOKEN, 'token 应取自注入的 INTERNAL_API_TOKEN');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.ok(init?.signal instanceof AbortSignal, '应带 AbortSignal.timeout 的 signal');
  assert.deepEqual(JSON.parse(String(init?.body)), { ...defaultForwardCandidate });
});

test('defaultForward（b）：非 2xx → console.warn 且不抛', async (t) => {
  const io = stubForwardIo(
    t,
    () => new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
  );

  await assert.doesNotReject(__stockInfoPredictionDependencies.forward(defaultForwardCandidate));
  assert.equal(io.warnCount(), 1, '非 2xx 必须告警一次');
});

test('defaultForward（c）：status=skipped（HTTP 200）→ 不告警（正常降级，硬需求）', async (t) => {
  const io = stubForwardIo(
    t,
    () => new Response(JSON.stringify({ status: 'skipped' }), { status: 200 }),
  );

  await __stockInfoPredictionDependencies.forward(defaultForwardCandidate);
  assert.equal(io.warnCount(), 0, 'skipped 是正常降级，不得告警');
});

test('defaultForward（d）：status=saved 但 record 为空 → console.warn', async (t) => {
  const io = stubForwardIo(
    t,
    () => new Response(JSON.stringify({ status: 'saved', record: null }), { status: 200 }),
  );

  await __stockInfoPredictionDependencies.forward(defaultForwardCandidate);
  assert.equal(io.warnCount(), 1, 'saved 但 record 为空必须告警');
});

test('defaultForward（d+）：status=saved 且 record 存在 → 不告警', async (t) => {
  const io = stubForwardIo(
    t,
    () => new Response(JSON.stringify({ status: 'saved', record: { id: 1 } }), { status: 200 }),
  );

  await __stockInfoPredictionDependencies.forward(defaultForwardCandidate);
  assert.equal(io.warnCount(), 0);
});

test('defaultForward（e）：响应体非合法 JSON → 不抛且告警', async (t) => {
  const io = stubForwardIo(t, () => new Response('not-json{{{', { status: 200 }));

  await assert.doesNotReject(__stockInfoPredictionDependencies.forward(defaultForwardCandidate));
  assert.equal(io.warnCount(), 1, 'JSON 解析失败必须告警');
});

test('defaultForward：未知 status（既非 saved 也非 skipped）→ 告警', async (t) => {
  const io = stubForwardIo(
    t,
    () => new Response(JSON.stringify({ status: 'weird' }), { status: 200 }),
  );

  await __stockInfoPredictionDependencies.forward(defaultForwardCandidate);
  assert.equal(io.warnCount(), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// P2-T4：研判落库成功后触发 ingest，且 ingest 失败不阻断落库
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 按 SQL 文本分流的 pool.query 打桩：`upsertJudgements` 开头会 await `ensureSchema()`，
 * 它会跑 CREATE TABLE / CREATE INDEX 等多条 DDL；单一返回值会与这些调用冲突。
 * 因此 INSERT 分支返回 inserted 行，其余（DDL/查询）返回空行集。
 */
function stubPoolQueryBySql(t: { after: (fn: () => void) => void }): void {
  const m = mock.method(pool, 'query', async (sql: string) => {
    if (String(sql).includes('INSERT INTO stock_info_judgements')) {
      return { rows: [{ id: 1, inserted: true }] };
    }
    return { rows: [] };
  });
  t.after(() => m.mock.restore());
}

/** 一条可通过 normalizeStockInfoJudgementInput 校验的原始入参 */
const validJudgementRaw = {
  symbol: '600383',
  stock_name: '金地集团',
  info_type: 'news',
  source: 'test-source',
  title: '测试标题',
  url: 'https://example.com/a',
  published_at: '2026-09-29T09:00:00+08:00',
  ai_impact: '利好',
  ai_horizon: '中期',
  ai_summary: '一句话结论',
};

test('upsertJudgements 落库成功后触发 ingest，入参为本批次原始 rawItems', async (t) => {
  stubPoolQueryBySql(t);
  const ingestMock = mock.method(StockInfoPredictionService, 'ingest', async () => {});
  t.after(() => ingestMock.mock.restore());

  const rawItems = [{ ...validJudgementRaw }];
  const out = await StockInfoService.upsertJudgements(rawItems);

  assert.equal(out.summary.inserted, 1, '应正常落库 1 条');
  assert.equal(out.summary.failed, 0);
  assert.equal(out.results.length, 1);
  assert.equal(ingestMock.mock.calls.length, 1, 'ingest 应恰好调用 1 次');
  // 入参必须是本批次原始 rawItems（而非候选或归一化后的对象）
  const passed: unknown = ingestMock.mock.calls[0].arguments[0];
  assert.deepEqual(passed, rawItems, 'ingest 入参须为本批次原始 rawItems');
});

test('ingest 抛异常不阻断 upsertJudgements（fail-safe，返回结构与计数不变）', async (t) => {
  stubPoolQueryBySql(t);
  const ingestMock = mock.method(StockInfoPredictionService, 'ingest', async () => {
    throw new Error('ingest boom');
  });
  t.after(() => ingestMock.mock.restore());
  const warnMock = mock.method(console, 'warn', () => {});
  t.after(() => warnMock.mock.restore());

  const rawItems = [{ ...validJudgementRaw }];
  const out = await StockInfoService.upsertJudgements(rawItems);

  assert.equal(out.summary.inserted, 1, 'ingest 抛异常不得影响落库计数');
  assert.equal(out.summary.updated, 0);
  assert.equal(out.summary.failed, 0);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].status, 'inserted');
  assert.equal(ingestMock.mock.calls.length, 1, 'ingest 仍应被调用 1 次');
  assert.equal(warnMock.mock.calls.length, 1, 'ingest 失败应告警一次（fail-safe）');
});
