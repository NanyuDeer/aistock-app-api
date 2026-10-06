/**
 * publicRouter 统计口径：long 档命中率舍入（Task 10 结转 · 来自 Task 5 终评 Minor）。
 *
 * 背景：agent-py 侧对 long 命中率做了 `round(..., 4)`，而 app-api 的 `computeStats` 与
 * `bucketStats` 两处 long.hitRate 原样输出未舍入；long 样本少时（如 1/3）两侧数值不同
 * （0.3333 vs 0.3333333333333333）。此处把两处 long.hitRate 用 round4 对齐（不动主 hitRate 行为）。
 *
 * 位置：放在 `__tests__/` 下以确保被 `npm test` 的 glob
 * （`src/**\/__tests__/**\/*.spec.ts`）收集；既有 `src/modules/prediction/publicRouter.test.ts`
 * 不在该 glob 内（Task 5 复评发现），故不复用其文件。
 *
 * 测试策略：与既有 `publicRouter.test.ts` 同款——通过 `__predictionPublicDependencies` 注入点
 * mock Service 层（不触达 PG），起临时 HTTP server 打 GET /api/predictions 读 stats。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';
import express from 'express';

import predictionPublicRouter, { __predictionPublicDependencies } from '../publicRouter';
import pool from '../../../core/db';
import type { PredictionRecordRow } from '../PredictionRecordService';

const ORIGINAL_DEPS = { ...__predictionPublicDependencies };

/** long 档单行：声明 long + 当前版本(4.0) 已结算(long) → 进 long 单列统计 */
function longRow(id: number, result: 'hit' | 'miss'): PredictionRecordRow {
  return {
    id,
    source_type: 'market_trace',
    source_id: `review:2026-08-0${id}`,
    schema_version: '1.0',
    prediction: {
      schema_version: '1.0',
      horizons: [{ horizon: 'long', remaining_estimate: '1-3 月', direction: 'bullish' }],
    },
    verification: {
      long: {
        horizon: 'long',
        result,
        methodology_version: '4.0',
        target_type: 'index',
        direction: 'bullish',
        actual: '+1.00%',
        reason: 'x',
        verified_at: '2027-01-05T08:00:00.000Z',
      },
    },
    due_dates: { long: '2027-01-05' },
    status: 'verified',
    created_at: '2026-08-07T12:00:00.000Z',
  };
}

interface HttpResponse {
  status: number;
  body: unknown;
}

function makeJsonRequest(port: number, path: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 0, body: data });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let server: http.Server;
let port: number;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/predictions', predictionPublicRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  __predictionPublicDependencies.listAllForStats = ORIGINAL_DEPS.listAllForStats;
  __predictionPublicDependencies.list = ORIGINAL_DEPS.list;
  __predictionPublicDependencies.getById = ORIGINAL_DEPS.getById;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test('GET /api/predictions -> 200：long 命中率舍入到 4 位（1/3 → 0.3333，与 agent-py 同值）', async () => {
  // 3 条 long 已结算（hit/miss/miss）→ 1/3；不构造非-long 档，主 hitRate 不参与本断言
  const rows = [longRow(1, 'hit'), longRow(2, 'miss'), longRow(3, 'miss')];
  __predictionPublicDependencies.listAllForStats = async () => rows;
  __predictionPublicDependencies.list = async () => ({ rows, total: rows.length });

  const res = await makeJsonRequest(port, '/api/predictions');
  assert.equal(res.status, 200);
  const body = res.body as {
    data: {
      stats: {
        long: { n: number; hits: number; hitRate: number | null };
        bucketStats: { combined: { long: { n: number; hits: number; hitRate: number | null } } };
      };
    };
  };
  assert.deepEqual(body.data.stats.long, { n: 3, hits: 1, hitRate: 0.3333 });
  // computeStats 与 bucketStats 两处 long.hitRate 同口径同值
  assert.equal(body.data.stats.bucketStats.combined.long.hitRate, 0.3333);
});
