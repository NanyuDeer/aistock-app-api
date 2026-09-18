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
  extractPerSectorTraceEntries,
  indexChainTraceSummaries,
  pickSectorTraceSummary,
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
      attribution_summary: '半导体板块量能放大资金回流，短线有望延续修复，谨防高位分歧回落。',
      target: { kind: 'sector', internal_id: '881121.TI', code: '881121.TI', name: '半导体' },
      horizons: [
        { horizon: 'long', remaining_estimate: '1-6 月', phase: 'building', direction: 'neutral', target: '半导体板块', metric_projection: '+8%', confidence: 'low', confidence_source: 'deterministic', label: '震荡磨底' },
        { horizon: 'short', remaining_estimate: '1-5 交易日', phase: 'building', direction: 'bullish', target: '半导体板块', metric_projection: '+3%', confidence: 'medium', confidence_source: 'llm', label: '缩量修复走强' },
      ],
      conditions: [
        { condition: '成交额放量至 500 亿', scenario: '板块继续上攻，涨幅上看 +3%', label: '放量反包 · 修复上行', keywords: ['放量反包', '资金回流'], scenario_keywords: ['续攻+3%'], anchor: { horizon: 'short', threshold: '+3%', metric: 'close', direction: 'bullish' } },
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
  assert.equal(s.attribution_summary, '半导体板块量能放大资金回流，短线有望延续修复，谨防高位分歧回落。'); // 一句话研判透传
  assert.deepEqual(s.horizons, [
    { horizon: 'short', remaining: '1-5 交易日', direction: 'bullish', confidence: 'medium', label: '缩量修复走强' },
    { horizon: 'long', remaining: '1-6 月', direction: 'neutral', confidence: 'low', label: '震荡磨底' },
  ]); // short→long 有序，mid 无档位；label 随档透传
  assert.deepEqual(s.conditions, [
    { horizon: 'short', direction: 'bullish', condition: '成交额放量至 500 亿', scenario: '板块继续上攻，涨幅上看 +3%', label: '放量反包 · 修复上行', keywords: ['放量反包', '资金回流'], scenario_keywords: ['续攻+3%'], met: true },
    { horizon: 'mid', direction: 'bearish', condition: '跌破 30 日均线', scenario: '转入震荡调整', met: null },
  ]); // 第二条旧形态无 label/keywords → 键省略（回退长句），不输出空串
});

test('toPredictionSummary: 无验证/全 insufficient/无 target 旧记录防御', () => {
  const pending = toPredictionSummary(makeRec({ status: 'pending', verification: {} }));
  assert.equal(pending.verification, 'pending');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.attribution_summary, undefined); // 旧记录无 attribution_summary → 键省略

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

// ==================== 每板块溯源摘要（2026-09-18 根治） ====================
//
// 生产实证（2026-09-18）：`display_report.sectors` 有 3 个主因板块，`market_trace.trace`
// 只承载第一个（单板块形状），于是 3 个候选全部显示第一个板块的归因句；且该句与大盘归因链
// `children[].trace_summary` 不是同一取源。根治 = 每板块解析，链优先。

test('extractPerSectorTraceEntries: 每板块取自己的 trigger headline（不再共用单板块形状）', () => {
  const content = {
    display_report: {
      sectors: ['国家大基金持股', '汽车芯片'],
      sector_traces: {
        国家大基金持股: {
          sector: '国家大基金持股',
          stages: [{ kind: 'trigger', headline: '大基金三期再落子' }],
          attribution_status: 'sufficient',
        },
        汽车芯片: {
          sector: '汽车芯片',
          stages: [{ kind: 'trigger', headline: '市场监管总局严查汽车芯片炒作' }],
          attribution_status: 'insufficient',
        },
      },
    },
  };
  const entries = extractPerSectorTraceEntries(content);
  assert.equal(entries.size, 2);
  // 逐字段断言（而非 deepEqual 整对象）：entry 会随加性键（如 stages）增长，整对象比较会被无关新增打破
  assert.equal(entries.get('国家大基金持股')?.summary, '大基金三期再落子');
  assert.equal(entries.get('国家大基金持股')?.status, 'completed');
  assert.equal(entries.get('汽车芯片')?.summary, '市场监管总局严查汽车芯片炒作');
  assert.equal(entries.get('汽车芯片')?.status, 'insufficient');
});

test('extractPerSectorTraceEntries: 顶层 summary 优先；无 sector_traces → 空 Map（调用方回退）', () => {
  const withTop = extractPerSectorTraceEntries({
    display_report: {
      sector_traces: {
        玉米: { summary: '超强厄尔尼诺供给扰动预期', stages: [{ kind: 'trigger', headline: '次选' }] },
      },
    },
  });
  assert.equal(withTop.get('玉米')?.summary, '超强厄尔尼诺供给扰动预期'); // 顶层优先，与 agent-py 报告侧口径一致
  assert.equal(extractPerSectorTraceEntries({ display_report: { sectors: ['玉米'] } }).size, 0);
  assert.equal(extractPerSectorTraceEntries(null).size, 0);
  assert.equal(extractPerSectorTraceEntries({ display_report: { sector_traces: [] } }).size, 0);
});

// ==================== 每板块 4 段原因链透出（2026-09-18 加性） ====================
//
// 板块溯源本身就是一条原因链，但**4 段**（现象→触发→传导→影响），不是大盘的 6 段。
// 它整条躺在 display_report.sector_traces[板块名].stages 里，此前前端只取了 trigger 段
// headline 当 summary —— 过程、每段 claims、证据 URL 全都没露出来。本轮**只透出数据**
// （界面稍后做，两处都放：板块详情页折叠 + 市场洞见链分支展开）。

test('extractPerSectorTraceEntries: 透出 4 段原因链（kind/headline/claims/evidence，保源序）', () => {
  const entries = extractPerSectorTraceEntries({
    display_report: {
      sector_traces: {
        汽车芯片: {
          attribution_status: 'sufficient',
          stages: [
            {
              kind: 'phenomenon',
              headline: '板块当日大涨 4.03%，华天科技领涨',
              claims: ['52 只成分股联动'],
              evidence: [{ url: 'https://news.example.com/a', title: '板块大涨' }],
            },
            {
              kind: 'trigger',
              headline: '美国对半导体加码关税，在美生产可豁免',
              claims: ['关税威胁', '国产替代升温'],
              evidence: [{ url: 'https://news.example.com/b', title: '关税' }],
            },
            { kind: 'transmission', headline: '同向走强', claims: [], evidence: [] },
            { kind: 'impact', headline: '订单可见度提升', claims: [], evidence: [] },
          ],
        },
      },
    },
  });

  const stages = entries.get('汽车芯片')?.stages;
  assert.ok(stages, 'stages 应透出');
  // 保源序（4 段顺序本身是语义，不得排序）
  assert.deepEqual(
    stages!.map((s) => s.kind),
    ['phenomenon', 'trigger', 'transmission', 'impact'],
  );
  assert.equal(stages![1]!.headline, '美国对半导体加码关税，在美生产可豁免');
  assert.deepEqual(stages![1]!.claims, ['关税威胁', '国产替代升温']);
  assert.equal(stages![0]!.evidence[0]!.url, 'https://news.example.com/a');
  assert.equal(stages![0]!.evidence[0]!.title, '板块大涨');
});

test('extractPerSectorTraceEntries: 无 stages / stages 非数组 → 省略该键（不编造空链）', () => {
  const entries = extractPerSectorTraceEntries({
    display_report: {
      sector_traces: {
        无链: { attribution_status: 'insufficient', stages: [] },
        坏形状: { stages: 'not-an-array' },
        没这键: { attribution_status: 'sufficient' },
      },
    },
  });
  assert.equal(entries.get('无链')?.stages, undefined);
  assert.equal(entries.get('坏形状')?.stages, undefined);
  assert.equal(entries.get('没这键')?.stages, undefined);
});

test('extractPerSectorTraceEntries: 段内畸形字段逐项清洗（不整段丢、不塞脏值）', () => {
  const entries = extractPerSectorTraceEntries({
    display_report: {
      sector_traces: {
        脏数据: {
          stages: [
            { kind: 'trigger', headline: '  有效标题  ', claims: ['ok', '', '   ', 42, null], evidence: [{ url: 'https://a', title: 'A' }, { url: null, title: 'B' }, 'junk'] },
            { kind: '', headline: '无 kind 段' }, // kind 非空才收
            null, // 非对象段丢弃
            { kind: 'impact' }, // headline 缺失 → 空串
          ],
        },
      },
    },
  });

  const stages = entries.get('脏数据')?.stages;
  assert.ok(stages);
  assert.equal(stages!.length, 2, 'null 段与空 kind 段被丢弃，其余保留');
  assert.equal(stages![0]!.kind, 'trigger');
  assert.equal(stages![0]!.headline, '有效标题'); // trim
  assert.deepEqual(stages![0]!.claims, ['ok']); // 空白/非字符串全部剔除
  // evidence：url 或 title 任一为非空字符串即收（title-only 仍可展示，url 缺失归一为 null）；'junk' 丢弃
  assert.deepEqual(stages![0]!.evidence, [
    { url: 'https://a', title: 'A' },
    { url: null, title: 'B' },
  ]);
  assert.equal(stages![1]!.kind, 'impact');
  assert.equal(stages![1]!.headline, ''); // 缺失 → 空串（不 undefined）
  assert.deepEqual(stages![1]!.claims, []);
  assert.deepEqual(stages![1]!.evidence, []);
});

test('indexChainTraceSummaries: ts_code 裸码 + sector_std/sector 双名索引', () => {
  const idx = indexChainTraceSummaries({
    date: '2026-09-18',
    children: [
      { sector: '注册制次新股', sector_std: '次新股', ts_code: '885905.TI', trace_summary: '某公司公告中标5亿元订单' },
      { sector: '国家大基金持股', ts_code: '885893.TI', trace_summary: '未检索到可解释当日大涨的独立触发事件' },
      { sector: '汽车芯片', ts_code: '885756.TI', trace_summary: '   ' }, // 空白摘要不收
    ],
  });
  assert.equal(idx.byTs.get('885905'), '某公司公告中标5亿元订单');
  assert.equal(idx.byName.get('注册制次新股'), '某公司公告中标5亿元订单');
  assert.equal(idx.byName.get('次新股'), '某公司公告中标5亿元订单'); // 权威名亦索引
  assert.equal(idx.byName.has('汽车芯片'), false);
  assert.equal(idx.byTs.has('885756'), false);
});

test('indexChainTraceSummaries: 无链/无 children → 空索引（接口降级回退报告侧）', () => {
  for (const bad of [null, undefined, {}, { children: null }, { children: 'x' }]) {
    const idx = indexChainTraceSummaries(bad);
    assert.equal(idx.byTs.size, 0);
    assert.equal(idx.byName.size, 0);
  }
});

test('buildCandidatesMap: 主因项自带 trace 时各候选拿自己的（不再全部共用第 3 参）', () => {
  const shared = { present: true, status: 'insufficient' as const, summary: '第一个板块的句子', sectors: ['A', 'B'] };
  const primary: ResolvedSectorInput[] = [
    { ts_code: '885905.TI', name: '注册制次新股', trace: { present: true, status: 'insufficient', summary: '事件A', sectors: ['A', 'B'] } },
    { ts_code: '885756.TI', name: '汽车芯片', trace: { present: true, status: 'completed', summary: '事件B', sectors: ['A', 'B'] } },
  ];
  const map = buildCandidatesMap([], primary, shared);
  assert.equal(map.get('885905')?.trace?.summary, '事件A');
  assert.equal(map.get('885756')?.trace?.summary, '事件B');
});

test('buildCandidatesMap: 主因项不带 trace → 回退第 3 参（旧调用方行为逐字不变）', () => {
  const shared = { present: true, status: 'completed' as const, summary: '出口管制传闻', sectors: ['半导体'] };
  const map = buildCandidatesMap([], [{ ts_code: '881121.TI', name: '半导体' }], shared);
  assert.deepEqual(map.get('881121')?.trace, shared);
});

test('pickSectorTraceSummary: 链优先于报告 sector_traces（跨页同源的唯一裁决点）', () => {
  const chainIndex = indexChainTraceSummaries({
    children: [
      { sector: '注册制次新股', sector_std: '次新股', ts_code: '885905.TI', trace_summary: '链上的事件句' },
    ],
  });
  const entry = { summary: '报告里的句子', status: 'insufficient' as const };
  assert.equal(
    pickSectorTraceSummary(chainIndex, { tsNorm: '885905', names: ['次新股', '注册制次新股'] }, entry),
    '链上的事件句', // 链命中即用链，报告句子被压过
  );
  // 链无该板块 → 回退该板块报告摘要
  assert.equal(
    pickSectorTraceSummary(chainIndex, { tsNorm: '885756', names: ['汽车芯片'] }, entry),
    '报告里的句子',
  );
  // 链与报告都没有 → null（调用方沿用旧单板块兜底，不编造）
  assert.equal(pickSectorTraceSummary(indexChainTraceSummaries(null), { tsNorm: '885756', names: [] }, undefined), null);
});

test('pickSectorTraceSummary: 名称漂移时按 ts_code/权威名/原始名逐级降级', () => {
  const chainIndex = indexChainTraceSummaries({
    children: [{ sector: '次新股', ts_code: '885905.TI', trace_summary: '链句' }],
  });
  // 候选权威名（次新股概念）与链 sector 不一致，但 ts_code 相同 → 仍命中
  assert.equal(pickSectorTraceSummary(chainIndex, { tsNorm: '885905', names: ['次新股概念'] }, undefined), '链句');
  // tsNorm 为空 → 仅按名匹配；名全不中 → null
  assert.equal(pickSectorTraceSummary(chainIndex, { tsNorm: '', names: ['别的板块'] }, undefined), null);
  assert.equal(pickSectorTraceSummary(chainIndex, { tsNorm: '', names: ['次新股'] }, undefined), '链句');
  // 空白名跳过，不因空串误命中
  assert.equal(pickSectorTraceSummary(chainIndex, { tsNorm: '', names: ['  ', ''] }, undefined), null);
});

