import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBriefEnvelope, buildMiddayEnvelope } from '../src/core/routes/briefingEnvelope'

function makeBriefContent(briefType: 'morning' | 'evening') {
  return {
    schema_version: 'brief.v1',
    brief_type: briefType,
    as_of: '2026-11-22T01:10:00.000Z',
    items: [
      {
        title: briefType === 'morning' ? '隔夜美股' : '收盘复盘',
        conclusion: briefType === 'morning'
          ? '纳指收涨，科技股延续强势。'
          : '指数缩量整理，主线仍在新能源。',
        evidence: [
          { report_type: 'morning', id: 1, data_source: 'agent', created_at: '2026-11-22T01:00:00.000Z' },
        ],
        as_of: '2026-11-22T01:05:00.000Z',
        confidence: 0.72,
        uncertainty: '隔夜数据仍有滞后',
      },
      {
        title: '政策催化',
        conclusion: '储能政策落地，板块情绪升温。',
        evidence: [
          { report_type: 'event_conduction', id: 2, data_source: 'agent', created_at: '2026-11-22T01:06:00.000Z' },
        ],
        as_of: '2026-11-22T01:06:00.000Z',
        confidence: 0.61,
        uncertainty: '政策细则未出',
      },
      {
        title: '资金流向',
        conclusion: '北向资金净流入，权重股获加仓。',
        evidence: [
          { report_type: 'trend_score', id: 3, data_source: 'agent', created_at: '2026-11-22T01:07:00.000Z' },
        ],
        as_of: '2026-11-22T01:07:00.000Z',
        confidence: 0.55,
        uncertainty: '盘后数据待确认',
      },
    ],
    degraded: false,
    missing_sources: [],
  }
}

test('pre slot：第一条作为头条，其余进 sections，音频取 broadcast', () => {
  const envelope = buildBriefEnvelope({
    slot: 'pre',
    date: '2026-11-22',
    brief: { content: makeBriefContent('morning') },
    broadcast: {
      content: {
        schema_version: 'broadcast.v1',
        brief_type: 'morning',
        audio_path: '/api/agent/audio/broadcast-morning-2026-11-22.mp3',
        dialogue: [{ role: 'host', content: '早上好，先看隔夜市场。' }],
      },
    },
  })

  assert.equal(envelope.schema_version, 'briefing.v1')
  assert.equal(envelope.report_type, 'morning')
  assert.equal(envelope.slot, 'pre')
  assert.equal(envelope.date, '2026-11-22')
  assert.equal(envelope.display_report.highlight?.label, '今日头条')
  assert.equal(envelope.display_report.highlight?.title, '隔夜美股')
  assert.equal(envelope.display_report.sections.length, 3)
  assert.equal(envelope.display_report.sections[0].is_headline, true)
  assert.equal(envelope.display_report.sections[1].source, 'event')
  assert.equal(envelope.audio_path, '/api/agent/audio/broadcast-morning-2026-11-22.mp3')
  assert.deepEqual(envelope.podcast_brief, [{ role: 'host', content: '早上好，先看隔夜市场。' }])
})

test('post slot：不设头条，summary 优先取收盘复盘', () => {
  const envelope = buildBriefEnvelope({
    slot: 'post',
    date: '2026-11-22',
    brief: { content: makeBriefContent('evening') },
    broadcast: null,
  })

  assert.equal(envelope.report_type, 'evening')
  assert.equal(envelope.display_report.highlight, null)
  assert.equal(envelope.display_report.summary, '指数缩量整理，主线仍在新能源。')
  assert.equal(envelope.audio_path, null)
})

test('mid slot：保留午报 sections 的机会/风险与 audio_path', () => {
  const envelope = buildMiddayEnvelope({
    date: '2026-11-22',
    report: {
      created_at: '2026-11-22T04:10:00.000Z',
      content: {
        schema_version: '2.1',
        display_report: {
          summary: '早盘冲高回落，午后关注量能。',
          sections: [
            {
              title: '午后前瞻',
              conclusion: '若量能回升，储能与快充有望延续。',
              opportunities: ['储能', '快充'],
              risks: ['高位股补跌'],
            },
          ],
          risks: ['量能不足', '高位股补跌'],
        },
        podcast_brief: '午间播报稿',
        audio_path: '/api/agent/audio/midday-2026-11-22.mp3',
      },
    },
  })

  assert.equal(envelope.report_type, 'midday')
  assert.equal(envelope.slot, 'mid')
  assert.equal(envelope.display_report.summary, '早盘冲高回落，午后关注量能。')
  assert.deepEqual(envelope.display_report.sections[0].opportunities, ['储能', '快充'])
  assert.deepEqual(envelope.display_report.risks, ['量能不足', '高位股补跌'])
  assert.equal(envelope.audio_path, '/api/agent/audio/midday-2026-11-22.mp3')
  assert.equal(envelope.podcast_brief, '午间播报稿')
  assert.equal(envelope.as_of, '2026-11-22T04:10:00.000Z')
})

function eveningBriefContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'brief.v1',
    brief_type: 'evening',
    as_of: '2026-11-20T15:20:00+08:00',
    degraded: false,
    missing_sources: [],
    items: [
      { title: '收盘复盘', conclusion: '指数缩量整理，储能主线延续。' },
      { title: '归因结论', conclusion: '今日主因是储能放量，资金回流。' },
      { title: '板块轮动', conclusion: '储能、快充领涨。' },
    ],
    ...overrides,
  }
}

function reviewContent(): Record<string, unknown> {
  return {
    schema_version: '2.0',
    market_trace: {
      trace: { attribution_summary: '缩量整理为主因：量能不足导致高位股分化。' },
      snapshot: {
        a_share: {
          indexes: {
            SH000001: { name: '上证指数', close: 3421.32, change_pct: 0.35 },
            SZ399001: { name: '深证成指', close: 11023.45, change_pct: -0.12 },
          },
          breadth: { advance_count: 2860, decline_count: 1980, flat_count: 210 },
          sectors: {
            top_gainers: [{ name: '储能', pct_change: 3.42 }],
            top_losers: [{ name: '算力', pct_change: -1.62 }],
          },
        },
      },
    },
  }
}

test('post slot：evening_extras 投影 review 的异象结论、指数、涨跌家数与板块', () => {
  const envelope = buildBriefEnvelope({
    slot: 'post',
    date: '2026-11-20',
    brief: { content: eveningBriefContent() },
    review: { content: reviewContent(), status: 'completed' },
  })

  assert.ok(envelope.evening_extras)
  const extras = envelope.evening_extras
  assert.equal(extras.has_anomaly, true)
  assert.equal(extras.anomaly_conclusion, '缩量整理为主因：量能不足导致高位股分化。')
  assert.deepEqual(extras.indexes, [
    { name: '上证指数', close: 3421.32, pct_change: 0.35 },
    { name: '深证成指', close: 11023.45, pct_change: -0.12 },
  ])
  assert.deepEqual(extras.breadth, { advance_count: 2860, decline_count: 1980, flat_count: 210 })
  assert.deepEqual(extras.sector_ranking.top_gainers, [{ name: '储能', pct_change: 3.42 }])
  assert.deepEqual(extras.sector_ranking.top_losers, [{ name: '算力', pct_change: -1.62 }])
})

test('post slot：brief 降级判无异象；缺 review 时行情为空但异象保守回退', () => {
  const degraded = buildBriefEnvelope({
    slot: 'post',
    date: '2026-11-20',
    brief: {
      content: eveningBriefContent({
        degraded: true,
        missing_sources: ['review'],
        items: [{ title: '收盘复盘', conclusion: '指数缩量整理。' }],
      }),
    },
    review: { content: reviewContent(), status: 'completed' },
  })
  assert.equal(degraded.evening_extras?.has_anomaly, false)

  const noReview = buildBriefEnvelope({
    slot: 'post',
    date: '2026-11-20',
    brief: { content: eveningBriefContent() },
  })
  assert.equal(noReview.evening_extras?.has_anomaly, true)
  assert.equal(noReview.evening_extras?.anomaly_conclusion, '今日主因是储能放量，资金回流。')
  assert.deepEqual(noReview.evening_extras?.indexes, [])
  assert.equal(noReview.evening_extras?.breadth, null)
})

test('pre/mid slot：evening_extras 恒为 null', () => {
  const morning = buildBriefEnvelope({
    slot: 'pre',
    date: '2026-11-20',
    brief: { content: makeBriefContent('morning') },
  })
  assert.equal(morning.evening_extras, null)

  const midday = buildMiddayEnvelope({
    date: '2026-11-20',
    report: {
      content: {
        display_report: {
          summary: '早盘冲高回落。',
          sections: [{ title: '盘面回顾', conclusion: '指数冲高回落。' }],
          risks: [],
        },
      },
    },
  })
  assert.equal(midday.evening_extras, null)
})
