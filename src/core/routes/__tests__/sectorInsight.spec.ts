/**
 * Sector Insight Router — 归一/摘要/join 纯函数测试（spec §6.2 聚合接口）。
 *
 * 不依赖真实 DB：只测导出纯函数（categoryOfTsCode/extractSectorTraceInfo/
 * aggregateVerificationResult/toPredictionSummary/buildCandidatesMap/joinPredictions）。
 *
 * Mock/清理说明：import sectorInsightRouter → internal.ts → services 链在模块加载时
 * 会调用 redis.ping() 并创建 setInterval（event_conduction.spec.ts 同款问题），
 * after() 中 redis.disconnect() 防止测试进程挂起。
 */
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';

import redis from '../../redis';
import {
  categoryOfTsCode,
  stripTiSuffix,
  extractSectorTraceInfo,
  aggregateVerificationResult,
  dueLabelOf,
  sectorNameFromSourceId,
  toPredictionSummary,
  buildCandidatesMap,
  joinPredictions,
  type ResolvedSectorInput,
} from '../sectorInsightRouter';
import type { PredictionRecordRow } from '../../../modules/prediction/PredictionRecordService';

after(() => {
  mock.restoreAll();
  redis.disconnect();
});

function makeRec(overrides: Partial<PredictionRecordRow>): PredictionRecordRow {
  return {
    id: 1,
    source_type: 'sector_prediction',
    source_id: 'sector:半导体:2026-09-01',
    schema_version: '3.0',
    prediction: {
      schema_version: '3.0',
      prediction_status: 'hypothesis',
      target: { kind: 'sector', internal_id: '881121.TI', code: '881121.TI', name: '半导体' },
      horizons: [
        { horizon: 'short', remaining_estimate: '1-5 交易日', phase: 'building', direction: 'bullish', target: '半导体板块', metric_projection: '+3%', confidence: 'medium', confidence_source: 'llm' },
      ],
      conditions: [],
      evolution_narrative: '',
      evolution_steps: [],
      risks: [],
      evidence_ids: [],
    },
    verification: {},
    status: 'pending',
    due_dates: { short: '2026-09-08' },
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

test('categoryOfTsCode: 881 → industry, 885/886 → concept', () => {
  assert.equal(categoryOfTsCode('881121.TI'), 'industry');
  assert.equal(categoryOfTsCode('881121'), 'industry');
  assert.equal(categoryOfTsCode('885789.TI'), 'concept');
  assert.equal(categoryOfTsCode('886123.TI'), 'concept');
});

test('stripTiSuffix 只剥 .TI 后缀', () => {
  assert.equal(stripTiSuffix('881121.TI'), '881121');
  assert.equal(stripTiSuffix('881121'), '881121');
  assert.equal(stripTiSuffix('885789.ti'), '885789');
});

test('extractSectorTraceInfo: attribution_status/summary/sectors/primaryName 提取', () => {
  const content = {
    display_report: { summary: '', sectors: ['半导体'], risks: [] },
    market_trace: {
      trace: {
        chain_id: 'x',
        sector: '半导体',
        stages: [
          { kind: 'phenomenon', headline: '半导体板块今日领跌', claims: [], evidence: [] },
          { kind: 'trigger', headline: '海外出口管制传闻发酵', claims: [], evidence: [] },
        ],
        attribution_status: 'sufficient',
      },
    },
  };
  const info = extractSectorTraceInfo(content);
  assert.equal(info.present, true);
  assert.equal(info.status, 'completed');
  assert.equal(info.summary, '海外出口管制传闻发酵'); // trigger 阶段 headline
  assert.deepEqual(info.sectors, ['半导体']);
  assert.equal(info.primaryName, '半导体');
});

test('extractSectorTraceInfo: attribution_status insufficient / 无 stages 摘要降级', () => {
  const insufficient = extractSectorTraceInfo({
    display_report: { sectors: ['存储'] },
    market_trace: { trace: { attribution_status: 'insufficient', stages: [] } },
  });
  assert.equal(insufficient.status, 'insufficient');
  assert.equal(insufficient.summary, null); // 无 stages → summary=null 不编造
  const noAttr = extractSectorTraceInfo({ display_report: { sectors: ['存储'] }, market_trace: { trace: {} } });
  assert.equal(noAttr.status, 'insufficient'); // attribution_status 缺省保守 insufficient
});

test('aggregateVerificationResult: hit 优先于 miss，全 insufficient 省略，无 result pending', () => {
  assert.equal(aggregateVerificationResult({}), 'pending');
  assert.equal(
    aggregateVerificationResult({ short: { horizon: 'short', result: 'hit' } }),
    'hit',
  );
  assert.equal(
    aggregateVerificationResult({
      short: { horizon: 'short', result: 'hit' },
      mid: { horizon: 'mid', result: 'miss' },
    }),
    'hit', // 存在 hit → hit
  );
  assert.equal(
    aggregateVerificationResult({ mid: { horizon: 'mid', result: 'miss' } }),
    'miss',
  );
  assert.equal(
    aggregateVerificationResult({ long: { horizon: 'long', result: 'insufficient' } }),
    undefined, // 全 insufficient → 省略键
  );
  assert.equal(
    aggregateVerificationResult({
      long: { horizon: 'long', type: 'early_exit', early_exit: {} },
    }),
    'pending', // early_exit-only 无 result → pending
  );
});

test('dueLabelOf: short 档优先；无 short 取最早到期', () => {
  assert.equal(dueLabelOf({ short: '2026-09-08', long: '2027-02-26' }), '2026-09-08');
  assert.equal(dueLabelOf({ mid: '2026-09-29', long: '2027-02-26' }), '2026-09-29');
  assert.equal(dueLabelOf({}), null);
  assert.equal(dueLabelOf(null), null);
});

test('sectorNameFromSourceId 提取板块名', () => {
  assert.equal(sectorNameFromSourceId('sector:半导体:2026-09-01'), '半导体');
  assert.equal(sectorNameFromSourceId('review:2026-09-01'), null);
});

test('toPredictionSummary: horizons/conditions/验证聚合/dueLabel/方向置信', () => {
  const record = makeRec({
    status: 'verified',
    due_dates: { short: '2026-09-08', mid: '2026-09-29', long: '2027-02-26' },
    prediction: {
      schema_version: '3.0',
      prediction_status: 'hypothesis',
      target: { kind: 'sector', internal_id: '881121.TI', code: '881121.TI', name: '半导体' },
      horizons: [
        { horizon: 'long', remaining_estimate: '1-6 月', phase: 'building', direction: 'neutral', target: '半导体板块', metric_projection: '+8%', confidence: 'low', confidence_source: 'deterministic' },
        { horizon: 'short', remaining_estimate: '1-5 交易日', phase: 'building', direction: 'bullish', target: '半导体板块', metric_projection: '+3%', confidence: 'medium', confidence_source: 'llm' },
      ],
      conditions: [
        { condition: '成交额放量至 500 亿', scenario: '板块继续上攻', anchor: { horizon: 'short', threshold: '+3%', metric: 'close', direction: 'bullish' } },
        { condition: '跌破 30 日均线', scenario: '转入震荡调整', anchor: { horizon: 'mid', threshold: '-5%', metric: 'close', direction: 'bearish' } },
      ],
      evolution_narrative: '',
      evolution_steps: [],
      risks: [],
      evidence_ids: [],
    },
    verification: {
      short: { horizon: 'short', result: 'hit', actual: '+4.20%', reason: 'x', verified_at: '2026-09-08T00:00:00.000Z' },
      long: { horizon: 'long', result: 'insufficient', actual: '', reason: '窗口未满', verified_at: '2026-09-01T00:00:00.000Z' },
      c0: { horizon: 'short', condition_index: 0, condition_met: true, result: 'hit', actual: '+4.20%', reason: 'x', verified_at: '2026-09-08T00:00:00.000Z' },
      c1: { horizon: 'mid', condition_index: 1, condition_met: null, result: 'insufficient', reason: 'no_data' },
    },
  });
  const s = toPredictionSummary(record);
  assert.equal(s.present, true);
  assert.equal(s.status, 'verified');
  assert.equal(s.dueLabel, '2026-09-08');
  assert.equal(s.verification, 'hit');
  assert.equal(s.direction, 'bullish'); // short 档优先
  assert.equal(s.confidence, 'medium');
  assert.deepEqual(s.horizons, [
    { horizon: 'short', remaining: '1-5 交易日', direction: 'bullish', confidence: 'medium' },
    { horizon: 'long', remaining: '1-6 月', direction: 'neutral', confidence: 'low' },
  ]); // short→long 有序，mid 无档位
  assert.deepEqual(s.conditions, [
    { horizon: 'short', direction: 'bullish', condition: '成交额放量至 500 亿', scenario: '板块继续上攻', met: true },
    { horizon: 'mid', direction: 'bearish', condition: '跌破 30 日均线', scenario: '转入震荡调整', met: null },
  ]);
});

test('toPredictionSummary: 无验证/全 insufficient/无 target 旧记录防御', () => {
  const pending = toPredictionSummary(makeRec({ status: 'pending', verification: {} }));
  assert.equal(pending.verification, 'pending');
  assert.equal(pending.status, 'pending');

  const insuff = toPredictionSummary(
    makeRec({ status: 'verified', verification: { long: { horizon: 'long', result: 'insufficient' } } }),
  );
  assert.equal(insuff.verification, undefined); // 全 insufficient → 省略

  const skipped = toPredictionSummary(
    makeRec({ status: 'skipped', due_dates: {}, source_id: 'sector:存储:2026-09-01', prediction: { horizons: [] } }),
  );
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.dueLabel, undefined); // 无 due_dates → 省略
});

test('buildCandidatesMap: 异名同 ts 合并 both、主因权威名覆盖、wind-only trace null', () => {
  const wind: ResolvedSectorInput[] = [
    { ts_code: '881121.TI', name: '半导体', cycle: 'long', quote: { pct_change: 2.1, amount: 1e10, lead_stock: '中芯国际' } },
    { ts_code: '885789.TI', name: '存储', cycle: 'short', quote: { pct_change: -1.2 } },
  ];
  const primary: ResolvedSectorInput[] = [{ ts_code: '881121.TI', name: '半导体' }];
  const trace = { present: true, status: 'completed' as const, summary: '出口管制传闻', sectors: ['半导体'] };
  const map = buildCandidatesMap(wind, primary, trace);

  assert.equal(map.size, 2);
  const semi = map.get('881121');
  assert.ok(semi);
  assert.equal(semi.source, 'both');
  assert.equal(semi.category, 'industry');
  assert.equal(semi.name, '半导体');
  assert.equal(semi.cycle, 'long');
  assert.deepEqual(semi.quote, { pct_change: 2.1, amount: 1e10, lead_stock: '中芯国际' });
  assert.deepEqual(semi.trace, trace);

  const store = map.get('885789');
  assert.ok(store);
  assert.equal(store.source, 'wind_leader');
  assert.equal(store.category, 'concept');
  assert.equal(store.trace, null); // wind_leader-only 溯源恒 null
  assert.equal(store.cycle, 'short');
});

test('joinPredictions: target ts_code 直连 + source_id resolve 兜底', async () => {
  const map = buildCandidatesMap(
    [
      { ts_code: '881121.TI', name: '半导体', cycle: 'long' },
      { ts_code: '885789.TI', name: '存储', cycle: 'short' },
    ],
    [],
    null,
  );
  const recDirect = makeRec({}); // target.internal_id=881121.TI → 直连
  const recResolve = makeRec({
    // source_id 板块名（存储板块）与候选权威名（存储）不一致 → 名称匹配失败，走 resolve 兜底
    source_id: 'sector:存储板块:2026-09-01',
    prediction: {
      schema_version: '3.0',
      prediction_status: 'hypothesis',
      target: null, // 旧记录无 target → 走 source_id resolve
      horizons: [{ horizon: 'short', remaining_estimate: '1-5 交易日', direction: 'neutral', confidence: 'low' }],
      conditions: [],
    },
  });
  const resolveMock = mock.fn(async (name: string) => {
    if (name === '存储板块') return { ts_code: '885789.TI', name: '存储' };
    return null;
  });
  await joinPredictions(map, [recDirect, recResolve], resolveMock);

  assert.equal(map.get('881121')?.prediction?.present, true);
  assert.equal(map.get('885789')?.prediction?.present, true, '无 target 记录经 resolve 兜底 join');
  assert.equal(resolveMock.mock.callCount(), 1); // recDirect 已 join，仅 recResolve 触发 resolve
});
