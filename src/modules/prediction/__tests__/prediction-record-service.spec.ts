/**
 * PredictionRecordService.appendVerification — 原子 jsonb 合并写 + early_exit 不联动 status（A1）。
 *
 * 测试约定（对齐仓库惯例）：node:test + mock.method(pool, 'query', ...)；
 * 不依赖真实 DB。mock 的 UPDATE 分支按 Node 端 jsonb 合并语义模拟。
 */
import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

import pool from '../../../core/db';
import { PredictionRecordService, type PredictionRecordRow } from '../PredictionRecordService';

after(() => {
  mock.restoreAll();
});

function makeRow(overrides: Partial<PredictionRecordRow> = {}): PredictionRecordRow {
  return {
    id: 1,
    source_type: 'market_trace',
    source_id: 'review:2026-08-01',
    schema_version: '2.0',
    prediction: { horizons: [{ horizon: 'short' }, { horizon: 'mid' }] },
    verification: {},
    status: 'pending',
    due_dates: { short: '2026-08-10', mid: '2026-09-10' },
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

/** mock pool.query：SELECT 返回给定行；UPDATE 记录 SQL/参数并按 jsonb 合并语义返回更新行 */
function mockAppend(row: PredictionRecordRow) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const queryMock = mock.method(pool, 'query', async (sql: unknown, params: unknown[]) => {
    const s = String(sql);
    queries.push({ sql: s, params: params ?? [] });
    if (s.trimStart().startsWith('SELECT')) {
      return { rows: [row] };
    }
    const horizon = String(params?.[0]);
    const entry = JSON.parse(String(params?.[1]));
    const merged = {
      ...(row.verification ?? {}),
      [horizon]: { ...(row.verification?.[horizon] ?? {}), ...entry },
    };
    return { rows: [{ ...row, verification: merged, status: String(params?.[2]) }] };
  });
  return { queries, queryMock };
}

test('appendVerification issues atomic jsonb merge UPDATE with horizon+entry params', async () => {
  const row = makeRow();
  const { queries, queryMock } = mockAppend(row);
  try {
    const result = await PredictionRecordService.appendVerification(1, 'short', {
      horizon: 'short',
      result: 'hit',
      actual: '+1.20%',
      reason: 'x',
      verified_at: '2026-08-10T00:00:00.000Z',
    });
    assert.ok(result, '应返回更新后的记录');
    const update = queries.find(q => q.sql.trimStart().startsWith('UPDATE'));
    assert.ok(update, '应执行 UPDATE');
    assert.ok(update!.sql.includes('jsonb_build_object'), 'SQL 用 jsonb_build_object 原子合并');
    assert.ok(update!.sql.includes('||'), 'SQL 用 || 合并运算符');
    assert.ok(update!.sql.includes('COALESCE(verification->$1'), '同档位已有值 COALESCE 合并');
    assert.equal(update!.params[0], 'short');
    const entry = JSON.parse(String(update!.params[1]));
    assert.equal(entry.result, 'hit');
    assert.equal(update!.params[2], 'pending'); // 仅 1/2 档有 result → 不 verified
    assert.equal(update!.params[3], 1); // WHERE id = $4
  } finally {
    queryMock.mock.restore();
  }
});

test('early_exit-only entry does not set status=verified', async () => {
  const row = makeRow();
  const { queries, queryMock } = mockAppend(row);
  try {
    await PredictionRecordService.appendVerification(1, 'short', {
      horizon: 'short',
      type: 'early_exit',
      early_exit: { state: 'armed', below_streak: 2, above_streak: 0, triggered_at: '2026-08-10' },
    });
    const update = queries.find(q => q.sql.trimStart().startsWith('UPDATE'));
    assert.ok(update, '应执行 UPDATE');
    const entry = JSON.parse(String(update!.params[1]));
    assert.equal(entry.type, 'early_exit');
    assert.ok(!('result' in entry), 'early_exit-only entry 不应含 result');
    assert.equal(update!.params[2], 'pending', '无 result → status 保持 pending');
  } finally {
    queryMock.mock.restore();
  }
});

test('all horizons with result flip status to verified', async () => {
  const row = makeRow({
    verification: {
      short: {
        horizon: 'short',
        result: 'hit',
        actual: '+1.20%',
        reason: 'x',
        verified_at: '2026-08-10T00:00:00.000Z',
      },
    },
  });
  const { queries, queryMock } = mockAppend(row);
  try {
    await PredictionRecordService.appendVerification(1, 'mid', {
      horizon: 'mid',
      result: 'miss',
      actual: '-0.50%',
      reason: 'y',
      verified_at: '2026-08-20T00:00:00.000Z',
    });
    const update = queries.find(q => q.sql.trimStart().startsWith('UPDATE'));
    assert.ok(update, '应执行 UPDATE');
    assert.equal(update!.params[2], 'verified', '全部档位均有 result → verified');
  } finally {
    queryMock.mock.restore();
  }
});

test('writing one horizon keeps other horizons untouched in entry payload', async () => {
  const row = makeRow({
    verification: {
      mid: {
        horizon: 'mid',
        result: 'miss',
        actual: '-0.50%',
        reason: 'y',
        verified_at: '2026-08-20T00:00:00.000Z',
      },
    },
  });
  const { queries, queryMock } = mockAppend(row);
  try {
    await PredictionRecordService.appendVerification(1, 'short', {
      horizon: 'short',
      result: 'hit',
      actual: '+1.20%',
      reason: 'x',
      verified_at: '2026-08-10T00:00:00.000Z',
    });
    const update = queries.find(q => q.sql.trimStart().startsWith('UPDATE'));
    assert.ok(update, '应执行 UPDATE');
    const entry = JSON.parse(String(update!.params[1]));
    assert.deepEqual(entry, {
      horizon: 'short',
      result: 'hit',
      actual: '+1.20%',
      reason: 'x',
      verified_at: '2026-08-10T00:00:00.000Z',
    }); // 仅新档 entry（老实现整段 verification 覆盖会丢其他档字段）
    assert.ok(!('mid' in entry), 'entry 不应携带其他档位字段');
  } finally {
    queryMock.mock.restore();
  }
});

test('listSectorByDate filters sector_prediction by source_id date suffix', async () => {
  const rows = [
    makeRow({
      source_type: 'sector_prediction',
      source_id: 'sector:半导体:2026-09-01',
      prediction: {
        target: { kind: 'sector', internal_id: '881121.TI', code: '881121.TI', name: '半导体' },
        horizons: [{ horizon: 'short' }],
      },
      due_dates: { short: '2026-09-08' },
    }),
  ];
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const queryMock = mock.method(pool, 'query', async (sql: unknown, params: unknown[]) => {
    capturedSql = String(sql);
    capturedParams = params ?? [];
    return { rows };
  });
  try {
    const result = await PredictionRecordService.listSectorByDate('2026-09-01');
    assert.equal(result.length, 1);
    assert.equal(result[0].source_id, 'sector:半导体:2026-09-01');
    assert.ok(capturedSql.includes("source_type = 'sector_prediction'"), '按 source_type 过滤');
    assert.ok(capturedSql.includes("source_id LIKE 'sector:%:' || $1"), '按 source_id 日期后缀 LIKE');
    assert.equal(capturedParams[0], '2026-09-01');
    assert.ok(capturedSql.includes('ORDER BY created_at DESC'), 'created_at DESC 排序（最新优先）');
  } finally {
    queryMock.mock.restore();
  }
});
