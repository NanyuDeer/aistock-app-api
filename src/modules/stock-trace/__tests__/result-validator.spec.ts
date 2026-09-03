import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStockTraceResult } from '../StockTraceResultService';
import type { TraceCandidate } from '../types';

const now = new Date('2026-07-30T02:15:00.000Z');

function source(id: string, kind: 'trigger_fact' | 'announcement' | 'sector_fact', level: 'A' | 'B' | 'D', occurredAt = now, payload: Record<string, unknown> = {}) {
  return { sourceId: id, kind, provider: 'test', sourceLevel: level, title: id, contentExcerpt: id, capturedAt: now, occurredAt, payload, contentHash: id.repeat(64).slice(0, 64) } as const
}

function validInput(companySource: ReturnType<typeof source>, extraSources: ReturnType<typeof source>[] = []) {
  const trigger = source('trigger', 'trigger_fact', 'A')
  const candidates: TraceCandidate[] = [
    { candidateId: 'company', layer: 'company' as const, rank: 1, status: 'supported' as const, verdict: '', supportingEvidenceIds: [companySource.sourceId], counterEvidenceIds: [] },
    { candidateId: 'sector', layer: 'sector' as const, rank: 1, status: 'insufficient' as const, verdict: '', supportingEvidenceIds: [], counterEvidenceIds: [] },
    { candidateId: 'market', layer: 'market' as const, rank: 1, status: 'insufficient' as const, verdict: '', supportingEvidenceIds: [], counterEvidenceIds: [] },
  ]
  const stages = ['structural_root', 'trigger', 'transmission', 'exposure', 'repricing', 'observable_result'] as const
  const nodes = stages.map((stage, index) => ({
    nodeId: stage, stage, stageOrder: index + 1,
    epistemicType: (stage === 'structural_root' || stage === 'trigger' || stage === 'observable_result' ? 'fact' : stage === 'exposure' ? 'hypothesis' : 'inference') as 'fact' | 'inference' | 'hypothesis',
    status: (stage === 'structural_root' || stage === 'trigger' || stage === 'observable_result' ? 'established' : stage === 'exposure' ? 'not_established' : 'partial') as 'established' | 'partial' | 'not_established',
    claim: stage, evidenceIds: stage === 'trigger' || stage === 'observable_result' ? [trigger.sourceId] : stage === 'exposure' ? [] : [companySource.sourceId], counterEvidenceIds: [],
  }))
  return { attributionStatus: 'confirmed' as const, confidenceScore: 0.78, candidates, chains: [{ chainId: 'primary', candidateId: 'company', role: 'primary' as const, nodes }], sources: [trigger, companySource, ...extraSources], windowEndAt: now, direction: 'up' as const }
}

test('A-grade company event can confirm without an independent market fact', () => {
  assert.deepEqual(validateStockTraceResult(validInput(source('announcement', 'announcement', 'A'))), [])
})

test('B-grade company event needs an independent direction-consistent market fact', () => {
  const input = validInput(source('announcement', 'announcement', 'B', now, { impact: '利好' }))
  assert.ok(validateStockTraceResult(input).includes('confirmed:missing_independent_market_fact'))
  input.sources.push(source('sector', 'sector_fact', 'B', now, { pct_change: 2 }))
  assert.deepEqual(validateStockTraceResult(input), [])
})

test('evidence published after the trigger window is rejected', () => {
  const later = new Date(now.getTime() + 1_000)
  const input = validInput(source('announcement', 'announcement', 'A', later))
  assert.ok(validateStockTraceResult(input).some((error) => error.includes('evidence_after_window')))
})

test('opposite-direction sector facts require a supported sector claim to cite counter evidence', () => {
  const sector = source('sector-down', 'sector_fact', 'B', now, { pct_change: -2 })
  const input = validInput(source('announcement', 'announcement', 'A'), [sector])
  input.candidates[1].status = 'supported'
  assert.ok(validateStockTraceResult(input).includes('candidate:sector:missing_counter_evidence'))
  input.candidates[1].counterEvidenceIds = [sector.sourceId]
  assert.deepEqual(validateStockTraceResult(input), [])
})

test('non-supported sector candidate with an opposite fact is not blocked', () => {
  const sector = source('sector-down', 'sector_fact', 'B', now, { pct_change: -2 })
  const input = validInput(source('announcement', 'announcement', 'A'), [sector])
  // sector 候选默认 insufficient（未声称板块驱动），存在反向板块事实也不强制反证
  assert.deepEqual(validateStockTraceResult(input), [])
})

test('capital_flow_disabled skips counter-evidence requirement for a supported sector claim', () => {
  const sector = source('sector-down', 'sector_fact', 'B', now, { pct_change: -2 })
  const input = validInput(source('announcement', 'announcement', 'A'), [sector])
  input.candidates[1].status = 'supported'
  assert.deepEqual(validateStockTraceResult({ ...input, missingCapabilities: ['capital_flow_disabled'] }), [])
})

test('opposite-direction facts captured after the event window do not block artifact publication', () => {
  const afterWindow = new Date(now.getTime() + 1_000)
  const lateMarketFact = source('market-down-late', 'sector_fact', 'B', afterWindow, { pct_change: -2 })
  const input = validInput(source('announcement', 'announcement', 'A'), [lateMarketFact])
  // The model may retain a later sector/market counter-fact for transparency.
  // It must not make the pre-window trace invalid or prevent Artifact publication.
  input.candidates[1].counterEvidenceIds = [lateMarketFact.sourceId]
  assert.deepEqual(validateStockTraceResult(input), [])
})
