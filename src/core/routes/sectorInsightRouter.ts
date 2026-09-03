/**
 * Sector Insight Router — 板块四环聚合查询接口（2026-09-02 板块四环前端展示 design spec §6.2）。
 *
 * GET /api/agent/sector-insight/:date
 * - 聚合当日「长线风口板块（wind_leader，hot-sectors.json）」∪「大盘溯源主因板块
 *   （review_primary，sector_trace 报告 display_report.sectors）」为候选集；
 * - 板块统一归一到同花顺 ts_code（*.TI，881 行业 / 885/886 概念）作为主键去重合并；
 * - 每候选挂载 quote（风口行情）/ trace（溯源摘要，仅主因来源）/ prediction
 *   （sector_prediction 记录摘要：horizons/conditions/验证状态）。
 *
 * 挂载要求：必须在 createAgentProxy 之前 app.use('/api/agent', …)（见 src/index.ts），
 * 否则 /api/agent/sector-insight/* 会被反代转发到 Python。
 */
import { Router, type Request, type Response } from 'express'
import { WindLeaderService } from '../../modules/monitor/WindLeaderService'
import { resolveBoardName } from '../../modules/quote/ThsBoardService'
import { PredictionRecordService, type PredictionRecordRow } from '../../modules/prediction/PredictionRecordService'
import { getAnalysisReport } from './internal'

const router: Router = Router()

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TS_NAKED_RE = /^\d{6}$/
const TS_CODE_RE = /^\d{6}\.TI$/i

// ==================== 响应契约类型（spec §6.2 聚合接口返回） ====================

export type SectorCategory = 'industry' | 'concept'
export type SectorSource = 'wind_leader' | 'review_primary'
export type SectorCycle = 'short' | 'long' | 'both'
export type HorizonKey = 'short' | 'mid' | 'long'

export interface SectorInsightQuote {
  pct_change?: number | null
  amount?: number | null
  lead_stock?: string | null
}

export interface SectorInsightTrace {
  present: boolean
  status?: 'completed' | 'insufficient'
  summary?: string | null
  sectors: string[]
}

export interface SectorInsightHorizon {
  horizon: HorizonKey
  remaining?: string
  direction?: string
  confidence?: string
  /** 基准走势短语（4~6 字，2026-09-03 起新数据携带；旧记录无则省略） */
  label?: string
}

export interface SectorInsightCondition {
  horizon?: HorizonKey
  direction?: string
  condition: string
  scenario: string
  met?: boolean | null
  /** 路径短语名（两段式“状态 · 走势”，2026-09-03 起新数据携带；旧记录无则省略） */
  label?: string
  /** 简洁展示用关键词（2026-09-02 起新数据携带：1~2 个）；旧记录无则省略 */
  keywords?: string[]
}

export interface SectorInsightPrediction {
  present: boolean
  status: 'pending' | 'verified' | 'skipped'
  dueLabel?: string | null
  verification?: 'pending' | 'hit' | 'miss'
  direction?: string | null
  confidence?: string | null
  horizons?: SectorInsightHorizon[]
  conditions?: SectorInsightCondition[]
}

export interface SectorInsightCandidate {
  ts_code: string
  name: string
  category: SectorCategory
  source: SectorSource | 'both'
  cycle?: SectorCycle | null // 风口来源才有；主因-only 无 cycle 键
  quote: SectorInsightQuote | null
  trace: SectorInsightTrace | null
  prediction: SectorInsightPrediction | null
}

export interface SectorInsightResponse {
  date: string
  hasData: boolean
  candidates: SectorInsightCandidate[]
  unresolved?: Array<{ name: string; source: SectorSource }>
}

// ==================== 归一纯函数 ====================

/** 剥 .TI 后缀 → 6 位裸码（同花顺体系内部比较主键） */
export function stripTiSuffix(tsCode: string): string {
  return String(tsCode || '').replace(/\.TI$/i, '')
}

/** 分类：881 前缀 = industry，其余（885/886）= concept（hot_sectors[].type 不可靠，spec §3） */
export function categoryOfTsCode(tsCode: string): SectorCategory {
  return /^881/.test(stripTiSuffix(tsCode)) ? 'industry' : 'concept'
}

/** 候选/预测主键是否 ts_code 形态（6 位裸码或带 .TI） */
function looksLikeTsCode(v: string): boolean {
  return TS_NAKED_RE.test(v) || TS_CODE_RE.test(v)
}

// ==================== 溯源报告解析（sector_trace 报告 content） ====================

/**
 * 从 market_trace.trace（SectorChainResult 序列化：chain_id/sector/stages[]/
 * attribution_status/missing_evidence）提取可展示的归因主句。
 * stages[].headline 是 LLM 按现象/触发/传导/影响产出的标题——取 trigger 阶段
 * （无则第一个 stage）headline 作 summary；取不到返回 null（不编造）。
 */
export function extractTraceSummary(trace: unknown): string | null {
  if (!trace || typeof trace !== 'object') return null
  const stages = (trace as { stages?: unknown }).stages
  if (!Array.isArray(stages)) return null
  const pick = (s: unknown): string | null => {
    if (!s || typeof s !== 'object') return null
    const headline = (s as { headline?: unknown }).headline
    return typeof headline === 'string' && headline.trim() ? headline.trim() : null
  }
  const trigger = stages.find(
    (s) => s && typeof s === 'object' && (s as { kind?: unknown }).kind === 'trigger',
  )
  return pick(trigger) ?? pick(stages[0])
}

export interface SectorTraceInfo {
  present: boolean
  status: 'completed' | 'insufficient'
  summary: string | null
  sectors: string[]
  primaryName: string | null
}

/** 解析 sector_trace 报告 content → trace 展示信息（报告行由 getAnalysisReport 查询） */
export function extractSectorTraceInfo(content: unknown): SectorTraceInfo {
  const c = content && typeof content === 'object' ? (content as Record<string, unknown>) : {}
  const display =
    c.display_report && typeof c.display_report === 'object'
      ? (c.display_report as Record<string, unknown>)
      : {}
  const marketTrace =
    c.market_trace && typeof c.market_trace === 'object'
      ? (c.market_trace as Record<string, unknown>)
      : {}
  const trace = marketTrace.trace
  const sectorsRaw = Array.isArray(display.sectors) ? (display.sectors as unknown[]) : []
  const sectors = sectorsRaw.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
  const attributionStatus =
    trace && typeof trace === 'object'
      ? (trace as { attribution_status?: unknown }).attribution_status
      : undefined
  return {
    present: true,
    // attribution_status 缺省视为 insufficient：不宣称归因完成（宁缺毋滥）
    status: attributionStatus === 'sufficient' ? 'completed' : 'insufficient',
    summary: extractTraceSummary(trace),
    sectors,
    primaryName: sectors[0] ?? null,
  }
}

// ==================== 预测记录摘要映射（纯函数） ====================

const HORIZON_ORDER: HorizonKey[] = ['short', 'mid', 'long']

function isHorizonKey(v: unknown): v is HorizonKey {
  return v === 'short' || v === 'mid' || v === 'long'
}

/** verification 聚合：存在 hit → hit；否则存在 miss → miss；全 insufficient → 省略；
 * 无任何 result entry（含 early_exit-only）→ pending（对齐任务契约 §6.2） */
export function aggregateVerificationResult(
  verification: Record<string, PredictionRecordRow['verification'][string]> | null | undefined,
): 'pending' | 'hit' | 'miss' | undefined {
  const v = verification ?? {}
  let hasHit = false
  let hasMiss = false
  let hasResult = false
  for (const entry of Object.values(v)) {
    const r = entry?.result
    if (r === 'hit') { hasHit = true; hasResult = true }
    else if (r === 'miss') { hasMiss = true; hasResult = true }
    else if (r === 'insufficient') { hasResult = true }
  }
  if (hasHit) return 'hit'
  if (hasMiss) return 'miss'
  if (hasResult) return undefined // 全 insufficient：无命中判定，前端缺省展示
  return 'pending'
}

/** due_dates 里最近到期标签：优先 short 档；无 short 档取全部档位最早到期日 */
export function dueLabelOf(dueDates: Record<string, string> | null | undefined): string | null {
  const d = dueDates ?? {}
  if (typeof d.short === 'string' && d.short) return d.short
  const values = Object.values(d).filter((x): x is string => typeof x === 'string' && x !== '')
  if (values.length === 0) return null
  return [...values].sort()[0] // YYYY-MM-DD 字典序 = 时间序
}

/** source_id（sector:{板块名}:{YYYY-MM-DD}）→ 板块名；非该形态返回 null */
export function sectorNameFromSourceId(sourceId: string): string | null {
  const m = /^sector:(.+):\d{4}-\d{2}-\d{2}$/.exec(sourceId)
  return m && m[1] ? m[1] : null
}

/**
 * prediction_records 行 → §6.2 契约 prediction 摘要。
 * horizons[]/conditions[] 直映射记录 prediction JSON；conditions[].met 对齐
 * verification c{i} entry 的 condition_met（无判定则省略）。
 */
export function toPredictionSummary(record: PredictionRecordRow): SectorInsightPrediction {
  const p =
    record.prediction && typeof record.prediction === 'object'
      ? (record.prediction as Record<string, unknown>)
      : {}
  const status: 'pending' | 'verified' | 'skipped' =
    record.status === 'verified' || record.status === 'skipped' ? record.status : 'pending'

  // ---- horizons（含剩余期限/方向/置信）----
  const rawHorizons = Array.isArray(p.horizons)
    ? (p.horizons as Array<Record<string, unknown>>)
    : []
  const byHorizon = new Map<string, Record<string, unknown>>()
  for (const h of rawHorizons) {
    if (h && typeof h === 'object' && typeof h.horizon === 'string') byHorizon.set(h.horizon, h)
  }
  const horizons: SectorInsightHorizon[] = HORIZON_ORDER.filter((k) => byHorizon.has(k)).map(
    (k) => {
      const h = byHorizon.get(k) ?? {}
      return {
        horizon: k,
        ...(typeof h.remaining_estimate === 'string' && h.remaining_estimate
          ? { remaining: h.remaining_estimate }
          : {}),
        ...(typeof h.direction === 'string' && h.direction ? { direction: h.direction } : {}),
        ...(typeof h.confidence === 'string' && h.confidence
          ? { confidence: h.confidence }
          : {}),
        ...(typeof h.label === 'string' && h.label.trim() ? { label: h.label.trim() } : {}),
      }
    },
  )
  // 概览方向/置信：按 short→mid→long 取首个有方向判断的档位（供卡片徽标）
  const overview = horizons.find((h) => h.direction) ?? horizons[0]

  // ---- conditions（met 对齐 verification c{i}）----
  const verification = record.verification ?? {}
  const metByIndex = new Map<number, boolean | null>()
  for (const entry of Object.values(verification)) {
    const ci = (entry as { condition_index?: unknown }).condition_index
    if (typeof ci === 'number' && Number.isInteger(ci)) {
      const cm = (entry as { condition_met?: unknown }).condition_met
      metByIndex.set(ci, typeof cm === 'boolean' ? cm : null)
    }
  }
  const rawConditions = Array.isArray(p.conditions)
    ? (p.conditions as Array<Record<string, unknown>>)
    : []
  const conditions: SectorInsightCondition[] = rawConditions
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c, i) => {
      const anchor =
        c.anchor && typeof c.anchor === 'object'
          ? (c.anchor as Record<string, unknown>)
          : {}
      return {
        ...(isHorizonKey(anchor.horizon) ? { horizon: anchor.horizon } : {}),
        ...(typeof anchor.direction === 'string' && anchor.direction
          ? { direction: anchor.direction }
          : {}),
        condition: typeof c.condition === 'string' ? c.condition : '',
        scenario: typeof c.scenario === 'string' ? c.scenario : '',
        ...(typeof c.label === 'string' && c.label.trim() ? { label: c.label.trim() } : {}),
        ...(Array.isArray(c.keywords) && c.keywords.length > 0
          ? {
              keywords: c.keywords.filter((k): k is string => typeof k === 'string' && k.trim() !== ''),
            }
          : {}),
        ...(metByIndex.has(i) ? { met: metByIndex.get(i) ?? null } : {}),
      }
    })

  const verificationResult = aggregateVerificationResult(verification)
  return {
    present: true,
    status,
    ...(dueLabelOf(record.due_dates) !== null
      ? { dueLabel: dueLabelOf(record.due_dates) }
      : {}),
    ...(verificationResult !== undefined ? { verification: verificationResult } : {}),
    ...(overview?.direction ? { direction: overview.direction } : {}),
    ...(overview?.confidence ? { confidence: overview.confidence } : {}),
    horizons,
    conditions,
  }
}

// ==================== 候选合并（纯函数） ====================

export interface ResolvedSectorInput {
  ts_code: string
  name: string
  /** 仅风口来源携带；主因来源恒不传 */
  cycle?: SectorCycle
  quote?: SectorInsightQuote | null
}

export interface CandidateDraft extends SectorInsightCandidate {
  tsNorm: string
}

/**
 * 两来源归一合并：按 ts_code（裸码）去重，来源并集标 both；
 * name 取后写权威名（resolve 名）；trace 仅主因/both 携带，quote/cycle 仅风口携带。
 */
export function buildCandidatesMap(
  windItems: ResolvedSectorInput[],
  primaryItems: ResolvedSectorInput[],
  traceInfo: SectorInsightTrace | null,
): Map<string, CandidateDraft> {
  const map = new Map<string, CandidateDraft>()
  const put = (item: ResolvedSectorInput, source: SectorSource) => {
    const norm = stripTiSuffix(item.ts_code)
    const existing = map.get(norm)
    if (existing) {
      if (source === 'wind_leader') {
        // 风口补充行情/周期；不覆盖 name（existing.name 若来自主因恒为权威名）
        existing.cycle = item.cycle ?? existing.cycle
        existing.quote = item.quote ?? existing.quote
      } else {
        // 主因：权威名（resolve 名）+ 溯源信息——无论先后都覆盖，保证展示名权威
        existing.name = item.name
        existing.trace = traceInfo
      }
      if (existing.source !== source) existing.source = 'both'
      return
    }
    const draft: CandidateDraft = {
      ts_code: `${norm}.TI`,
      name: item.name,
      category: categoryOfTsCode(item.ts_code),
      source,
      cycle: source === 'wind_leader' ? (item.cycle ?? null) : null,
      quote: source === 'wind_leader' ? (item.quote ?? null) : null,
      trace: source === 'review_primary' ? traceInfo : null,
      prediction: null,
      tsNorm: norm,
    }
    map.set(norm, draft)
  }
  for (const item of windItems) put(item, 'wind_leader')
  for (const item of primaryItems) put(item, 'review_primary')
  return map
}

// ==================== 预测 join（含 resolve 兜底） ====================

type Resolver = (name: string) => Promise<{ ts_code: string; name: string } | null>

/**
 * 当日 sector_prediction 记录 join 候选（主循环为候选集）：
 * 1) 记录 target.internal_id/code（ts_code 形态）直连候选 ts_code；
 * 2) target.name / source_id 板块名与候选权威名精确匹配；
 * 3) 仍未命中 → resolve 板块名得 ts_code 再匹配（resolve 失败或 ts 不在候选则忽略）。
 * 同一 ts_code 多条记录（异名同板块 upsert 前历史）保留最新（records 已 created_at DESC）。
 */
export async function joinPredictions(
  map: Map<string, CandidateDraft>,
  records: PredictionRecordRow[],
  resolve: Resolver,
): Promise<void> {
  const attach = (norm: string, record: PredictionRecordRow) => {
    const draft = map.get(norm)
    if (draft && !draft.prediction) draft.prediction = toPredictionSummary(record)
  }
  const tryJoin = (record: PredictionRecordRow): boolean => {
    const p =
      record.prediction && typeof record.prediction === 'object'
        ? (record.prediction as Record<string, unknown>)
        : {}
    const target =
      p.target && typeof p.target === 'object' ? (p.target as Record<string, unknown>) : null
    let tsNorm: string | null = null
    let name: string | null = null
    if (target) {
      for (const v of [target.internal_id, target.code]) {
        if (typeof v === 'string' && looksLikeTsCode(v)) {
          tsNorm = stripTiSuffix(v)
          break
        }
      }
      name = typeof target.name === 'string' && target.name ? target.name : null
    }
    if (!name) name = sectorNameFromSourceId(record.source_id)
    if (tsNorm && map.has(tsNorm)) {
      attach(tsNorm, record)
      return true
    }
    if (name) {
      for (const draft of map.values()) {
        if (draft.name === name) {
          attach(draft.tsNorm, record)
          return true
        }
      }
    }
    return false
  }

  const unmatched: PredictionRecordRow[] = []
  for (const record of records) {
    if (!tryJoin(record)) unmatched.push(record)
  }
  // resolve 兜底：按 source_id 板块名批量 resolve（th 名称异名/权威名不一致场景）
  const names = [
    ...new Set(
      unmatched
        .map((r) => sectorNameFromSourceId(r.source_id))
        .filter((n): n is string => !!n),
    ),
  ]
  const resolvedByName = new Map<string, { ts_code: string } | null>()
  await Promise.all(
    names.map(async (n) => {
      try {
        resolvedByName.set(n, await resolve(n))
      } catch {
        resolvedByName.set(n, null)
      }
    }),
  )
  for (const record of unmatched) {
    const name = sectorNameFromSourceId(record.source_id)
    if (!name) continue
    const resolved = resolvedByName.get(name)
    if (!resolved) continue
    const norm = stripTiSuffix(resolved.ts_code)
    if (map.has(norm)) attach(norm, record)
  }
}

// ==================== 路由 ====================

/** Express 5 params 可能为 string | string[]，安全取 string */
function param(req: Request, key: string): string {
  const val = req.params[key]
  return Array.isArray(val) ? val[0] : (val || '')
}

interface HotSectorInputRow {
  code?: string
  cycle?: string
  name?: string
  today_change?: number | null
  amount?: number | null
  leading_stock?: string | null
  leading_stock_info?: { code?: string; name?: string } | null
}

/** WindLeaderService.getAnalysis 行（unknown）→ 防御收窄 */
function toHotSectorInput(row: unknown): HotSectorInputRow | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const code = typeof r.code === 'string' ? r.code : ''
  const name = typeof r.name === 'string' ? r.name : ''
  if (!code && !name) return null
  const li = r.leading_stock_info
  return {
    code: code || undefined,
    name: name || undefined,
    cycle: typeof r.cycle === 'string' ? r.cycle : undefined,
    today_change: typeof r.today_change === 'number' ? r.today_change : null,
    amount: typeof r.amount === 'number' ? r.amount : null,
    leading_stock: typeof r.leading_stock === 'string' && r.leading_stock ? r.leading_stock : null,
    leading_stock_info:
      li && typeof li === 'object'
        ? {
            code:
              typeof (li as { code?: unknown }).code === 'string'
                ? (li as { code: string }).code
                : undefined,
            name:
              typeof (li as { name?: unknown }).name === 'string'
                ? (li as { name: string }).name
                : undefined,
          }
        : null,
  }
}

function toQuote(row: HotSectorInputRow): SectorInsightQuote {
  return {
    pct_change: row.today_change ?? null,
    amount: row.amount ?? null,
    lead_stock:
      row.leading_stock ??
      row.leading_stock_info?.name ??
      row.leading_stock_info?.code ??
      null,
  }
}

router.get('/sector-insight/:date', async (req: Request, res: Response) => {
  const date = param(req, 'date')
  if (!DATE_RE.test(date)) {
    res.status(400).json({ code: -1, message: `Invalid date format: ${date}（需要 YYYY-MM-DD）` })
    return
  }

  try {
    const [wind, traceReport, predictions] = await Promise.all([
      WindLeaderService.getAnalysis(16), // 双榜 top8 并集（≤16），文件侧已双榜排序
      getAnalysisReport('sector_trace', date),
      PredictionRecordService.listSectorByDate(date),
    ])

    const unresolved: Array<{ name: string; source: SectorSource }> = []
    const pushUnresolved = (name: string, source: SectorSource) => {
      if (!unresolved.some((u) => u.name === name && u.source === source)) {
        unresolved.push({ name, source })
      }
    }

    // ---- 风口来源归一：resolve 优先；失败但有 6 位 code 用 code+.TI 兜底（原名人 unresolved）----
    const windItems: ResolvedSectorInput[] = []
    for (const raw of wind?.hot_sectors ?? []) {
      const row = toHotSectorInput(raw)
      if (!row) continue
      if (row.cycle === 'none') continue // 非风口档剔除（双榜 top8 并集内的无效档）
      const name = row.name ?? ''
      let tsCode: string | null = null
      let displayName = name
      let resolved: { ts_code: string; name: string } | null = null
      if (name) {
        try {
          resolved = await resolveBoardName(name)
        } catch {
          resolved = null // resolve 失败降级 code 兜底，不阻断整接口
        }
      }
      if (resolved) {
        tsCode = resolved.ts_code
        displayName = resolved.name
      } else {
        if (name) pushUnresolved(name, 'wind_leader')
        if (row.code && TS_NAKED_RE.test(row.code)) tsCode = `${row.code}.TI`
      }
      if (!tsCode) continue
      windItems.push({
        ts_code: tsCode,
        name: displayName,
        cycle:
          row.cycle === 'short' || row.cycle === 'long' || row.cycle === 'both'
            ? row.cycle
            : undefined,
        quote: toQuote(row),
      })
    }

    // ---- 主因来源归一：sector_trace 报告 display_report.sectors（通常 1 个主因板块）----
    const traceInfo =
      traceReport && traceReport.content
        ? extractSectorTraceInfo(traceReport.content)
        : null
    const primaryItems: ResolvedSectorInput[] = []
    if (traceInfo) {
      for (const primaryName of traceInfo.sectors) {
        let resolved: { ts_code: string; name: string } | null = null
        try {
          resolved = await resolveBoardName(primaryName)
        } catch {
          resolved = null
        }
        if (!resolved) {
          pushUnresolved(primaryName, 'review_primary')
          continue
        }
        primaryItems.push({ ts_code: resolved.ts_code, name: resolved.name })
      }
    }

    const map = buildCandidatesMap(windItems, primaryItems, traceInfo)
    await joinPredictions(map, predictions ?? [], resolveBoardName)

    const candidates: SectorInsightCandidate[] = [...map.values()].map((d) => ({
      ts_code: d.ts_code,
      name: d.name,
      category: d.category,
      source: d.source,
      ...(d.cycle ? { cycle: d.cycle } : {}),
      quote: d.quote,
      trace: d.trace,
      prediction: d.prediction,
    }))

    const body: SectorInsightResponse = {
      date,
      hasData: candidates.length > 0,
      candidates,
    }
    if (unresolved.length > 0) body.unresolved = unresolved
    res.json(body)
  } catch (err: unknown) {
    console.error('[SectorInsight] GET /api/agent/sector-insight/:date error:', err instanceof Error ? err.message : String(err))
    res.status(500).json({ code: -1, message: 'Internal server error' })
  }
})

export default router
