/**
 * 事件影响存活度（Impact Vitality）—— 判断已推送重大消息的影响是否仍在传递。
 *
 * 例：10/1 摩根新闻的影响到 10/15 是否还在推动相关板块（同期板块是否持续跑赢大盘）。
 *
 * 一期口径（用户已确认）：**只算不干扰** —— 只落表 + 内部只读接口，
 * 不接前端、不 gate 推送、不修改事件传导 / GI 语义。
 *
 * 数据链路：
 *   1. baseline（chain 快照）：`event_impact_vitality_baseline`
 *      为什么必须自持久化：event_conduction 报告 TTL=7 天，每日 03:00 ReportCleanupCron
 *      会 `DELETE FROM agent_analysis_reports WHERE expires_at < NOW()`，chain 随报告被物理
 *      删除 → 7 天后再算就没有行业可观测。故 D 日首次计算把 chain Top3 行业落库，
 *      此后只读快照（ON CONFLICT DO NOTHING，快照一次定稿）。
 *   2. 观测：链上 Top3 行业 → 同花顺行业板块池（`getThsIndex('I','A')`）映射板块代码
 *      → 板块日线（复用 RotationBoardStore.fetchBoardKline 的同花顺 bk_ 源）。
 *      选 ths_index 全量行业池而非 hotCirclePlate：实测行业名覆盖率 98% vs 57%。
 *   3. 基准：上证指数日涨跌幅（Tushare index_daily，经 getIndexKLine）。
 *   4. 输出：`event_impact_vitality_daily`（每事件每日一行，兼作长期事件池）。
 *
 * 评分（纯函数，可单测）：
 *   daily_excess = 板块 pct_change − 同日基准 pct_change
 *   aligned(日)  = |daily_excess| ≥ VITALITY_EXCESS_MIN_PCT 且符号与 chain 主导方向一致
 *                  （主导方向 neutral 时只判幅度）
 *   attribution_weak(日) = 该行业当日另有其它重大事件在窗口内 → 不计分子、计入分母
 *   recency_score = min(自最新观测日向前的连续 aligned 天数 / VITALITY_RECENT_ALIGNED_DAYS, 1)
 *   cum_excess     = 窗口内定向超额均值 / 2%（饱和归一到 [0,1]）
 *   reinforce      = min(窗口内同行业新增同向重大事件数 / 2, 1)
 *   decay          = 0.5 ^ (age_days / half_life(event_type))
 *   vitality = (0.35·aligned_ratio + 0.30·recency_score + 0.20·cum_excess + 0.15·reinforce) × decay
 *   分档：alive ≥ VITALITY_ALIVE_MIN / fading 中间 / expired < VITALITY_EXPIRED_MAX /
 *        no_observation（行业映射不到板块，vitality=NULL，禁判 expired）
 *
 * 模块解耦：本文件与板块数据同属 monitor 模块；仅复用同名模块已有的
 * `RotationBoardStore.fetchBoardKline` 与 quote 数据源（quote 作为数据源提供方，
 * 与 RotationBoardStore 既有 `getThsIndex` 导入先例一致），不横向 import 其他业务模块。
 */

import pool from '../../core/db';
import { shanghaiDateStr } from '../../shared/utils/shanghaiTime';
import { getThsIndex } from '../quote/TushareService';
import { TushareKlineService } from '../quote/TushareKlineService';
import { fetchBoardKline } from './RotationBoardStore';

// ==================== 类型 ====================

/** chain 节点（诊断口径：industry 必填，direction/impactStrength 可缺省）。 */
export interface ChainNode {
    industry: string;
    direction?: string;
    impactStrength?: number;
    reason?: string;
}

/** 事件链主导方向。 */
export type Direction = 'bullish' | 'bearish' | 'neutral';

/** 存活度分档。 */
export type ImpactStatus = 'alive' | 'fading' | 'expired' | 'no_observation';

/** 单行业观测明细（落 observed_industries JSONB）。 */
export interface ObservedIndustry {
    industry: string;
    board_code: string | null;
    obs_days: number;
    aligned_days: number;
    weak_days: number;
    avg_excess: number;
}

/** baseline 行（chain 快照）。 */
export interface VitalityBaselineRow {
    event_id: string;
    event_type: string;
    event_date: string; // YYYY-MM-DD
    chain: ChainNode[];
}

/** 存活度配置。 */
export interface VitalityConfig {
    /** 总开关（默认 true，生产启用；显式设 VITALITY_ENABLED=false 可关闭计算） */
    enabled: boolean;
    /** 观测窗口上限（自事件日起算的自然日） */
    windowMaxDays: number;
    /** alive 阈值 */
    aliveMin: number;
    /** expired 阈值 */
    expiredMax: number;
    /** 单日定向超额门槛（%） */
    excessMinPct: number;
    /** recency 满分所需连续 aligned 天数 */
    recentAlignedDays: number;
    /** 定向超额归一尺度（%） */
    excessScalePct: number;
    /** 权重：aligned_ratio / recency / cum_excess / reinforce */
    weights: { aligned: number; recency: number; cumExcess: number; reinforce: number };
    /** 各事件类型半衰期（天） */
    halfLifeByType: Record<string, number>;
    /** 未知类型默认半衰期（天） */
    halfLifeDefault: number;
    /** reinforce 满分所需同向事件数 */
    reinforceTarget: number;
    /** chain 观测行业数上限 */
    topIndustries: number;
    /** 基准指数代码（上证指数） */
    benchmarkCode: string;
}

/** 单事件单日计算结果。 */
export interface VitalityResult {
    vitality: number | null;
    impact_status: ImpactStatus;
    observed_industries: ObservedIndustry[];
    reinforce_count: number;
    benchmark: string | null;
    window_start: string;
    window_end: string;
}

/** 计算输入（已预取好板块/基准数据，纯函数便于单测）。 */
export interface VitalityComputationInput {
    baseline: VitalityBaselineRow;
    /** 统计日（YYYY-MM-DD），须 ≥ event_date */
    statDate: string;
    /** 同花顺行业名 → 6 位板块代码（getIndustryCodeIndex() 产出，注入以保持纯函数可单测） */
    industryIndex: Map<string, string>;
    /** 板块代码 → 日期(YYYY-MM-DD) → 当日涨跌幅(%) */
    boardPct: Map<string, Map<string, number>>;
    /** 日期(YYYY-MM-DD) → 基准当日涨跌幅(%) */
    benchmarkPct: Map<string, number>;
    /** 同窗口内其它事件（用于 attribution_weak 与 reinforce 判定） */
    peerEvents: Array<{ event_id: string; chain: ChainNode[]; direction: Direction; event_date: string }>;
    config: VitalityConfig;
}

// ==================== 配置 ====================

const DEFAULT_HALF_LIFE: Record<string, number> = {
    policy: 14,
    macro: 10,
    geopolitical: 7,
    industry: 5,
    company: 3,
};

function envBool(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
    const raw = env[name];
    if (raw === undefined || raw === '') return def;
    return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function envNum(env: NodeJS.ProcessEnv, name: string, def: number): number {
    const raw = env[name];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
}

/**
 * 事件类型 → 半衰期类别（LLM 给的 event_type 取值不稳定，按关键词兜底归一）。
 * 只影响 decay 快慢，不影响状态判定权（状态仍由确定性公式给出）。
 */
export function normalizeEventTypeCategory(eventType: string): string {
    const t = String(eventType || '').toLowerCase();
    if (t.includes('policy') || t.includes('政策')) return 'policy';
    if (t.includes('geo') || t.includes('war') || t.includes('地缘') || t.includes('战争')) return 'geopolitical';
    if (t.includes('macro') || t.includes('宏观') || t.includes('rate') || t.includes('利率')) return 'macro';
    if (t.includes('industry') || t.includes('行业') || t.includes('supply') || t.includes('chain')) return 'industry';
    if (t.includes('company') || t.includes('公司') || t.includes('earning') || t.includes('finance')) return 'company';
    return 'unknown';
}

/** 读取存活度配置（env 覆盖；总开关 VITALITY_ENABLED 默认 true，显式 false 关闭）。 */
export function loadVitalityConfig(env: NodeJS.ProcessEnv = process.env): VitalityConfig {
    const halfLifeByType: Record<string, number> = { ...DEFAULT_HALF_LIFE };
    const raw = env['VITALITY_HALF_LIFE_DAYS'];
    if (raw) {
        for (const pair of raw.split(',')) {
            const [k, v] = pair.split(':');
            const n = Number((v ?? '').trim());
            if (k && Number.isFinite(n) && n > 0) halfLifeByType[k.trim()] = n;
        }
    }
    return {
        enabled: envBool(env, 'VITALITY_ENABLED', true),
        windowMaxDays: envNum(env, 'VITALITY_WINDOW_MAX_DAYS', 45),
        aliveMin: envNum(env, 'VITALITY_ALIVE_MIN', 0.6),
        expiredMax: envNum(env, 'VITALITY_EXPIRED_MAX', 0.3),
        excessMinPct: envNum(env, 'VITALITY_EXCESS_MIN_PCT', 0.5),
        recentAlignedDays: envNum(env, 'VITALITY_RECENT_ALIGNED_DAYS', 3),
        excessScalePct: envNum(env, 'VITALITY_EXCESS_SCALE_PCT', 2),
        weights: { aligned: 0.35, recency: 0.3, cumExcess: 0.2, reinforce: 0.15 },
        halfLifeByType,
        halfLifeDefault: halfLifeByType['industry'] ?? 5,
        reinforceTarget: envNum(env, 'VITALITY_REINFORCE_TARGET', 2),
        topIndustries: envNum(env, 'VITALITY_TOP_INDUSTRIES', 3),
        benchmarkCode: env['VITALITY_BENCHMARK_CODE'] || '000001.SH',
    };
}

// ==================== 纯函数（可单测） ====================

/** chain 主导方向：按 impactStrength 加权，一侧显著占优才算方向（1.5 倍阈值，对齐 chain_dominant_direction）。 */
export function dominantDirection(chain: ChainNode[], ratio = 1.5): Direction {
    let bull = 0;
    let bear = 0;
    for (const node of chain) {
        const w = Number.isFinite(node.impactStrength) ? Number(node.impactStrength) : 0;
        if (node.direction === 'bullish') bull += w;
        else if (node.direction === 'bearish') bear += w;
    }
    if (bull <= 0 && bear <= 0) return 'neutral';
    if (bull >= bear * ratio) return 'bullish';
    if (bear >= bull * ratio) return 'bearish';
    return 'neutral';
}

/** 指数衰减（半衰期）。ageDays ≤ 0 → 1；halfLife ≤ 0 → 0（异常配置不产生虚高存活度）。 */
export function decayFactor(ageDays: number, halfLifeDays: number): number {
    if (!(halfLifeDays > 0)) return 0;
    if (ageDays <= 0) return 1;
    return Math.pow(0.5, ageDays / halfLifeDays);
}

/** 单日是否对齐：方向一致且幅度达标；neutral 只判幅度。 */
export function judgeAligned(dailyExcess: number, direction: Direction, excessMinPct: number): boolean {
    if (!Number.isFinite(dailyExcess)) return false;
    if (direction === 'bullish') return dailyExcess >= excessMinPct;
    if (direction === 'bearish') return dailyExcess <= -excessMinPct;
    return Math.abs(dailyExcess) >= excessMinPct;
}

/** 定向超额（与主导方向同号为正）。 */
export function directedExcess(dailyExcess: number, direction: Direction): number {
    if (direction === 'bearish') return -dailyExcess;
    if (direction === 'bullish') return dailyExcess;
    return Math.abs(dailyExcess);
}

/** 分档（vitality 为 null → no_observation）。 */
export function classifyStatus(vitality: number | null, config: VitalityConfig): ImpactStatus {
    if (vitality === null || !Number.isFinite(vitality)) return 'no_observation';
    if (vitality >= config.aliveMin) return 'alive';
    if (vitality < config.expiredMax) return 'expired';
    return 'fading';
}

/** YYYY-MM-DD 加 N 天（自然日，固定 +08）。 */
export function shiftDate(dateStr: string, days: number): string {
    const ms = new Date(`${dateStr}T00:00:00+08:00`).getTime() + days * 86400000;
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 两个 YYYY-MM-DD 之间的自然日差（b - a）。 */
export function diffDays(a: string, b: string): number {
    const ta = new Date(`${a}T00:00:00+08:00`).getTime();
    const tb = new Date(`${b}T00:00:00+08:00`).getTime();
    return Math.round((tb - ta) / 86400000);
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}

// ==================== 行业名 → 板块代码 ====================

/**
 * 未命中同花顺行业名的手工别名桥接（探针实测 4 个未命中名，共约 1.9% 条目）。
 * 值 = 候选替代名（按优先级），先精确命中，再包含式兜底；仍无 → 记 no_observation。
 */
export const INDUSTRY_ALIAS_BRIDGE: Record<string, string[]> = {
    石油石化: ['石油行业', '油气开采', '石油'],
    国防军工: ['航天航空', '国防军工', '军工'],
    玻璃制造: ['玻璃玻纤', '玻璃'],
    商业百货: ['商业百货', '百货', '商贸零售'],
};

/**
 * 行业名 → 6 位同花顺板块代码（纯函数，确定性）：
 *   1. 精确名命中
 *   2. 别名桥接候选命中
 *   3. 包含式兜底（板块名含行业名 或 行业名含板块名），按板块名升序取首个，保证确定性
 */
export function resolveIndustryBoardCode(name: string, index: Map<string, string>): string | null {
    const key = String(name || '').trim();
    if (!key) return null;
    const exact = index.get(key);
    if (exact) return exact;
    for (const alt of INDUSTRY_ALIAS_BRIDGE[key] ?? []) {
        const hit = index.get(alt);
        if (hit) return hit;
    }
    const sortedNames = [...index.keys()].sort();
    for (const boardName of sortedNames) {
        if (boardName.includes(key) || key.includes(boardName)) return index.get(boardName)!;
    }
    return null;
}

/** 行业板块池缓存 TTL（24 小时）。 */
const INDUSTRY_INDEX_TTL = 24 * 3600 * 1000;
let industryIndexCache: { map: Map<string, string>; at: number } | null = null;

/**
 * 构建「同花顺行业名 → 6 位板块代码」索引（24h 内存缓存）。
 * 用 ths_index 全量行业池（type=I, exchange=A）；失败返回空 Map（调用方降级为 no_observation）。
 */
export async function getIndustryCodeIndex(): Promise<Map<string, string>> {
    if (industryIndexCache && Date.now() - industryIndexCache.at < INDUSTRY_INDEX_TTL) {
        return industryIndexCache.map;
    }
    const map = new Map<string, string>();
    try {
        const rows = await getThsIndex('I', 'A');
        for (const row of rows) {
            const code = String(row.ts_code || '').match(/^\d{6}/)?.[0];
            if (code && row.name) map.set(String(row.name).trim(), code);
        }
        console.log(`[EventImpactVitality] 行业板块索引: ${map.size} 个`);
    } catch (err) {
        console.warn('[EventImpactVitality] getThsIndex(I) 失败:', (err as Error).message);
        return industryIndexCache?.map ?? map;
    }
    if (map.size > 0) industryIndexCache = { map, at: Date.now() };
    return map;
}

// ==================== 核心计算 ====================

/** chain → 观测行业（impactStrength 降序 Top N，过滤空行业）。 */
export function topChainIndustries(chain: ChainNode[], max: number): ChainNode[] {
    return chain
        .filter((n) => n && String(n.industry || '').trim() !== '')
        .map((n) => ({ ...n, industry: String(n.industry).trim() }))
        .sort((a, b) => (Number(b.impactStrength) || 0) - (Number(a.impactStrength) || 0))
        .slice(0, max);
}

/** 该事件链是否含某行业（peer 判定用，包含式匹配以容忍上下位名差异）。 */
function chainHasIndustry(chain: ChainNode[], industry: string): boolean {
    return chain.some((n) => {
        const other = String(n?.industry || '').trim();
        return other === industry || other.includes(industry) || industry.includes(other);
    });
}

/**
 * 单事件单日存活度计算（纯函数）。
 *
 * 观测日 = 基准有数据的交易日 ∩ 窗口 [event_date, min(event_date + windowMaxDays, statDate)]，
 * 且当日至少一个观测行业有板块数据。
 */
export function computeVitality(input: VitalityComputationInput): VitalityResult {
    const { baseline, statDate, industryIndex, boardPct, benchmarkPct, peerEvents, config } = input;
    const direction = dominantDirection(baseline.chain);
    const windowStart = baseline.event_date;
    const windowEnd = (() => {
        const cap = shiftDate(baseline.event_date, config.windowMaxDays);
        return cap < statDate ? cap : statDate;
    })();

    // 1) 观测行业 → 板块代码（解析不到 → board_code=null，记入 no_observation 明细）
    const industries = topChainIndustries(baseline.chain, config.topIndustries).map((node) => ({
        industry: node.industry,
        boardCode: resolveIndustryBoardCode(node.industry, industryIndex),
    }));
    const unresolved = industries.map((i) => ({
        industry: i.industry,
        board_code: i.boardCode,
        obs_days: 0,
        aligned_days: 0,
        weak_days: 0,
        avg_excess: 0,
    }));
    const noObservation = (benchmark: string | null): VitalityResult => ({
        vitality: null,
        impact_status: 'no_observation',
        observed_industries: unresolved,
        reinforce_count: 0,
        benchmark,
        window_start: windowStart,
        window_end: windowEnd,
    });

    const mapped = industries.filter((i) => i.boardCode);
    if (mapped.length === 0) return noObservation(null);

    // 2) 观测日（基准交易日 ∩ 窗口）
    const days = [...benchmarkPct.keys()].filter((d) => d >= windowStart && d <= windowEnd).sort();
    if (days.length === 0) return noObservation(null);

    // 3) 观测行业集合（用于 peer / reinforce 判定）
    const observedNames = mapped.map((i) => i.industry);
    const peersSameIndustry = (d: string): boolean =>
        peerEvents.some(
            (p) =>
                p.event_id !== baseline.event_id &&
                p.event_date <= d &&
                shiftDate(p.event_date, config.windowMaxDays) >= d &&
                observedNames.some((name) => chainHasIndustry(p.chain, name)),
        );

    const perIndustry = new Map<string, ObservedIndustry>();
    for (const item of mapped) {
        perIndustry.set(item.industry, {
            industry: item.industry,
            board_code: item.boardCode,
            obs_days: 0,
            aligned_days: 0,
            weak_days: 0,
            avg_excess: 0,
        });
    }

    const dayStats: Array<{ date: string; excess: number; aligned: boolean; weak: boolean }> = [];
    const excessSumByIndustry = new Map<string, number>();

    for (const d of days) {
        const bench = benchmarkPct.get(d);
        if (!Number.isFinite(bench as number)) continue;
        const excesses: Array<{ industry: string; excess: number }> = [];
        for (const item of mapped) {
            const pct = boardPct.get(item.boardCode!)?.get(d);
            if (!Number.isFinite(pct as number)) continue;
            excesses.push({ industry: item.industry, excess: (pct as number) - (bench as number) });
        }
        if (excesses.length === 0) continue;

        const weak = peersSameIndustry(d);
        const dailyExcess = excesses.reduce((s, e) => s + e.excess, 0) / excesses.length;
        const aligned = judgeAligned(dailyExcess, direction, config.excessMinPct);

        dayStats.push({ date: d, excess: dailyExcess, aligned, weak });
        for (const e of excesses) {
            const stat = perIndustry.get(e.industry)!;
            stat.obs_days += 1;
            if (aligned && !weak) stat.aligned_days += 1;
            if (weak) stat.weak_days += 1;
            excessSumByIndustry.set(e.industry, (excessSumByIndustry.get(e.industry) ?? 0) + e.excess);
        }
    }

    const observedDays = dayStats.length;
    if (observedDays === 0) {
        return {
            vitality: null,
            impact_status: 'no_observation',
            observed_industries: [...perIndustry.values()],
            reinforce_count: 0,
            benchmark: config.benchmarkCode,
            window_start: windowStart,
            window_end: windowEnd,
        };
    }

    // 4) 窗口累计指标
    const alignedDays = dayStats.filter((s) => s.aligned && !s.weak).length;
    const alignedRatio = alignedDays / observedDays;

    let run = 0;
    for (let i = dayStats.length - 1; i >= 0; i--) {
        if (dayStats[i].aligned && !dayStats[i].weak) run += 1;
        else break;
    }
    const recencyScore = Math.min(run / config.recentAlignedDays, 1);

    const avgDirected = dayStats.reduce((s, x) => s + directedExcess(x.excess, direction), 0) / observedDays;
    const cumExcess = clamp01(avgDirected / config.excessScalePct);

    const reinforceCount = peerEvents.filter(
        (p) =>
            p.event_id !== baseline.event_id &&
            p.event_date > baseline.event_date &&
            p.event_date <= windowEnd &&
            p.direction === direction &&
            direction !== 'neutral' &&
            observedNames.some((name) => chainHasIndustry(p.chain, name)),
    ).length;
    const reinforce = Math.min(reinforceCount / config.reinforceTarget, 1);

    const ageDays = diffDays(baseline.event_date, statDate);
    const category = normalizeEventTypeCategory(baseline.event_type);
    const halfLife = config.halfLifeByType[category] ?? config.halfLifeDefault;
    const decay = decayFactor(ageDays, halfLife);

    const base =
        config.weights.aligned * alignedRatio +
        config.weights.recency * recencyScore +
        config.weights.cumExcess * cumExcess +
        config.weights.reinforce * reinforce;
    const vitality = round3(clamp01(base * decay));

    const observedIndustries: ObservedIndustry[] = [...perIndustry.values()].map((s) => ({
        ...s,
        avg_excess: s.obs_days > 0 ? Math.round(((excessSumByIndustry.get(s.industry) ?? 0) / s.obs_days) * 100) / 100 : 0,
    }));

    return {
        vitality,
        impact_status: classifyStatus(vitality, config),
        observed_industries: observedIndustries,
        reinforce_count: reinforceCount,
        benchmark: config.benchmarkCode,
        window_start: windowStart,
        window_end: windowEnd,
    };
}

// ==================== 编排 ====================

/** 构建「板块代码 → 日期 → 涨跌幅(%)」（源 fetchBoardKline 的 OHLC [open, close, low, high]）。 */
export function buildBoardPct(boardKline: { dates: string[]; ohlc: [number, number, number, number][] }): Map<string, number> {
    const map = new Map<string, number>();
    for (let i = 1; i < boardKline.dates.length; i++) {
        const prev = boardKline.ohlc[i - 1]?.[1];
        const cur = boardKline.ohlc[i]?.[1];
        if (Number.isFinite(prev) && Number.isFinite(cur) && prev! > 0) {
            map.set(boardKline.dates[i], ((cur! - prev!) / prev!) * 100);
        }
    }
    return map;
}

/** 基准（上证指数）日期 → 涨跌幅(%)。 */
export async function fetchBenchmarkPct(config: VitalityConfig): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
        const rows = await TushareKlineService.getIndexKLine(config.benchmarkCode, 60);
        for (const row of rows) {
            const date = String(row['时间'] || '');
            const pct = Number(row['涨跌幅']);
            if (/^\d{8}$/.test(date) && Number.isFinite(pct)) {
                map.set(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`, pct);
            }
        }
    } catch (err) {
        console.warn('[EventImpactVitality] 基准指数拉取失败:', (err as Error).message);
    }
    return map;
}

/** 并发受限执行。 */
async function withConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
    let idx = 0;
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
        tasks.push((async () => {
            while (idx < items.length) {
                const cur = idx++;
                await worker(items[cur]);
            }
        })());
    }
    await Promise.all(tasks);
}

/** 建表（幂等；与 migration 025 一致，供本地/无迁移器环境兜底）。 */
export async function ensureVitalitySchema(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS event_impact_vitality_baseline (
            event_id VARCHAR(64) PRIMARY KEY,
            event_type VARCHAR(40) NOT NULL DEFAULT 'unknown',
            event_date DATE NOT NULL,
            chain JSONB NOT NULL,
            snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_vitality_baseline_event_date
            ON event_impact_vitality_baseline (event_date);
        CREATE TABLE IF NOT EXISTS event_impact_vitality_daily (
            event_id VARCHAR(64) NOT NULL,
            stat_date DATE NOT NULL,
            vitality NUMERIC(4, 3),
            impact_status VARCHAR(20) NOT NULL,
            observed_industries JSONB NOT NULL DEFAULT '[]'::jsonb,
            reinforce_count INTEGER NOT NULL DEFAULT 0,
            benchmark VARCHAR(40),
            window_start DATE,
            window_end DATE,
            computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (event_id, stat_date)
        );
        CREATE INDEX IF NOT EXISTS idx_vitality_daily_stat_date
            ON event_impact_vitality_daily (stat_date);
    `);
}

/**
 * 落 chain 快照（仅补齐缺失行，不覆盖既有快照）。
 *
 * 数据源：agent_analysis_reports（report_type='event_conduction'，user_id=event_id，
 * 见 internal.ts POST /analysis-reports 的 event_conduction 约定）+ event_entities 取事件日。
 * 报告 7 天后被物理删除，故快照必须尽早落库；ON CONFLICT DO NOTHING 保证一次定稿。
 */
export async function snapshotChainBaselines(
    statDate: string,
    windowMaxDays: number,
    topIndustries = 3,
): Promise<number> {
    const { rows } = await pool.query<{
        event_id: string;
        event_type: string | null;
        event_date: string;
        chain: unknown;
    }>(
        `SELECT DISTINCT ON (r.user_id)
                r.user_id AS event_id,
                r.content->>'event_type' AS event_type,
                to_char(COALESCE(date(e.event_start_time AT TIME ZONE 'Asia/Shanghai'), r.report_date), 'YYYY-MM-DD') AS event_date,
                r.content->'analysis_reports'->'event_transmission'->'chain' AS chain
         FROM agent_analysis_reports r
         LEFT JOIN event_entities e ON e.event_id = r.user_id
         WHERE r.report_type = 'event_conduction'
           AND jsonb_typeof(r.content->'analysis_reports'->'event_transmission'->'chain') = 'array'
           AND jsonb_array_length(r.content->'analysis_reports'->'event_transmission'->'chain') > 0
         ORDER BY r.user_id, r.created_at DESC`,
    );
    const earliest = shiftDate(statDate, -windowMaxDays);
    const candidates = rows.filter((r) => r.event_date && r.event_date >= earliest && r.event_date <= statDate);
    if (candidates.length === 0) return 0;

    let inserted = 0;
    for (const row of candidates) {
        const chain = topChainIndustries(
            (Array.isArray(row.chain) ? row.chain : []) as ChainNode[],
            topIndustries,
        );
        if (chain.length === 0) continue;
        const result = await pool.query(
            `INSERT INTO event_impact_vitality_baseline (event_id, event_type, event_date, chain)
             VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (event_id) DO NOTHING`,
            [row.event_id, row.event_type || 'unknown', row.event_date, JSON.stringify(chain)],
        );
        inserted += result.rowCount ?? 0;
    }
    return inserted;
}

/**
 * 单事件 chain 快照（传导报告落库即调用，根治 7 天 TTL 窗口丢失）。
 *
 * 为什么必须写时就快照：event_conduction 报告 TTL=7 天，03:00 ReportCleanupCron
 * 会物理删除过期报告；cron 15:50 的批量扫描只是"事后补"，报告一旦被删就永久丢 chain。
 * 落库即冻结（ON CONFLICT DO NOTHING 一次定稿）彻底消除该窗口，保证"从现在起不再丢"。
 *
 * 事件日兜底顺序与 snapshotChainBaselines 一致：event_entities.event_start_time → fallbackDate。
 *
 * @returns 是否新增了 baseline 行（已存在 / chain 为空 / 无事件日 → false）
 */
export async function snapshotBaselineForEvent(params: {
    eventId: string;
    eventType?: string | null;
    chain: ChainNode[];
    /** 显式事件日 YYYY-MM-DD；缺省时读 event_entities */
    eventDate?: string | null;
    /** event_entities 无事件日时的兜底日（一般传报告 report_date） */
    fallbackDate?: string | null;
    topIndustries?: number;
}): Promise<boolean> {
    const eventId = String(params.eventId || '').trim();
    if (!eventId) return false;
    const chain = topChainIndustries(params.chain ?? [], params.topIndustries ?? 3);
    // chain 为空 = 无行业可观测，不快照（避免占用窗口行却不产生任何观测）
    if (chain.length === 0) return false;

    let eventDate = (params.eventDate || '').trim();
    if (!eventDate) {
        const { rows } = await pool.query<{ d: string | null }>(
            `SELECT to_char(date(e.event_start_time AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD') AS d
             FROM event_entities e WHERE e.event_id = $1`,
            [eventId],
        );
        eventDate = rows[0]?.d ?? '';
    }
    if (!eventDate) eventDate = (params.fallbackDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return false;

    const result = await pool.query(
        `INSERT INTO event_impact_vitality_baseline (event_id, event_type, event_date, chain)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, params.eventType || 'unknown', eventDate, JSON.stringify(chain)],
    );
    return (result.rowCount ?? 0) > 0;
}

/** 加载窗口内 baseline（statDate - windowMaxDays ~ statDate）。 */
export async function loadBaselines(statDate: string, windowMaxDays: number): Promise<VitalityBaselineRow[]> {
    const { rows } = await pool.query<{
        event_id: string;
        event_type: string;
        event_date: string;
        chain: unknown;
    }>(
        `SELECT event_id, event_type, to_char(event_date, 'YYYY-MM-DD') AS event_date, chain
         FROM event_impact_vitality_baseline
         WHERE event_date BETWEEN $1 AND $2
         ORDER BY event_date DESC`,
        [shiftDate(statDate, -windowMaxDays), statDate],
    );
    return rows.map((r) => ({
        event_id: r.event_id,
        event_type: r.event_type,
        event_date: r.event_date,
        chain: (Array.isArray(r.chain) ? r.chain : []) as ChainNode[],
    }));
}

/** 批量 upsert 每日存活度。 */
export async function replaceVitalityRows(statDate: string, results: Array<{ event_id: string; result: VitalityResult }>): Promise<void> {
    if (results.length === 0) return;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM event_impact_vitality_daily WHERE stat_date = $1', [statDate]);
        for (const { event_id, result } of results) {
            await client.query(
                `INSERT INTO event_impact_vitality_daily
                    (event_id, stat_date, vitality, impact_status, observed_industries, reinforce_count,
                     benchmark, window_start, window_end)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
                 ON CONFLICT (event_id, stat_date) DO UPDATE SET
                    vitality = EXCLUDED.vitality,
                    impact_status = EXCLUDED.impact_status,
                    observed_industries = EXCLUDED.observed_industries,
                    reinforce_count = EXCLUDED.reinforce_count,
                    benchmark = EXCLUDED.benchmark,
                    window_start = EXCLUDED.window_start,
                    window_end = EXCLUDED.window_end,
                    computed_at = CURRENT_TIMESTAMP`,
                [
                    event_id,
                    statDate,
                    result.vitality,
                    result.impact_status,
                    JSON.stringify(result.observed_industries),
                    result.reinforce_count,
                    result.benchmark,
                    result.window_start,
                    result.window_end,
                ],
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/** 读取单事件存活度（内部接口用）：baseline + 最新一行 + 近 historyDays 天历史。 */
export async function getEventVitality(eventId: string, historyDays = 14): Promise<{
    event_id: string;
    baseline: { event_type: string; event_date: string; chain: ChainNode[] } | null;
    direction: Direction;
    latest: Record<string, unknown> | null;
    history: Array<Record<string, unknown>>;
}> {
    const { rows: baselineRows } = await pool.query<{ event_type: string; event_date: string; chain: unknown }>(
        `SELECT event_type, to_char(event_date, 'YYYY-MM-DD') AS event_date, chain
         FROM event_impact_vitality_baseline WHERE event_id = $1`,
        [eventId],
    );
    const chain = baselineRows[0] ? ((baselineRows[0].chain ?? []) as ChainNode[]) : [];
    const { rows: dailyRows } = await pool.query(
        `SELECT to_char(stat_date, 'YYYY-MM-DD') AS stat_date, vitality, impact_status,
                observed_industries, reinforce_count, benchmark, window_start, window_end
         FROM event_impact_vitality_daily
         WHERE event_id = $1
         ORDER BY stat_date DESC
         LIMIT $2`,
        [eventId, Math.max(1, historyDays)],
    );
    const norm = (r: Record<string, unknown>) => ({ ...r, vitality: r['vitality'] === null ? null : Number(r['vitality']) });
    return {
        event_id: eventId,
        baseline: baselineRows[0]
            ? { event_type: baselineRows[0].event_type, event_date: baselineRows[0].event_date, chain }
            : null,
        direction: dominantDirection(chain),
        latest: dailyRows[0] ? norm(dailyRows[0] as Record<string, unknown>) : null,
        history: dailyRows.map((r) => norm(r as Record<string, unknown>)),
    };
}

/** 列表/详情 annotation-only 的存活度展示载荷（score=null 表示 no_observation）。 */
export interface VitalityDisplay {
    score: number | null;
    status: ImpactStatus;
    statDate: string;
}

function toVitalityDisplay(row: Record<string, unknown>): VitalityDisplay {
    return {
        score: row['vitality'] === null ? null : Number(row['vitality']),
        status: String(row['impact_status'] || 'no_observation') as ImpactStatus,
        statDate: String(row['stat_date'] || ''),
    };
}

/** 取单事件最新一行存活度（无数据 → null）。调用方负责降级（如表不存在）。 */
export async function getLatestVitality(eventId: string): Promise<VitalityDisplay | null> {
    if (!eventId) return null;
    const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT vitality, impact_status, to_char(stat_date, 'YYYY-MM-DD') AS stat_date
         FROM event_impact_vitality_daily
         WHERE event_id = $1
         ORDER BY stat_date DESC LIMIT 1`,
        [eventId],
    );
    return rows[0] ? toVitalityDisplay(rows[0]) : null;
}

/** 批量取多事件各自最新一行存活度（event_id → 展示载荷）。 */
export async function getLatestVitalityByEventIds(eventIds: string[]): Promise<Map<string, VitalityDisplay>> {
    const map = new Map<string, VitalityDisplay>();
    const ids = eventIds.filter((id) => !!id);
    if (ids.length === 0) return map;
    // 用 IN ($1,$2,...) 标量占位符，而非 = ANY($n) 数组参数（pg 下后者触发 42P18）
    let placeholders = '';
    for (let i = 0; i < ids.length; i++) placeholders += (i > 0 ? ', ' : '') + `$${i + 1}`;
    const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT DISTINCT ON (event_id) event_id, vitality, impact_status,
                to_char(stat_date, 'YYYY-MM-DD') AS stat_date
         FROM event_impact_vitality_daily
         WHERE event_id IN (${placeholders})
         ORDER BY event_id, stat_date DESC`,
        ids,
    );
    for (const row of rows) map.set(String(row['event_id']), toVitalityDisplay(row));
    return map;
}

/**
 * 每日存活度计算（cron 入口）：快照 chain → 拉板块/基准日线 → 逐事件算分 → 落表。
 * 幂等：同 stat_date 覆盖写入。
 */
export async function runVitalityDaily(statDate?: string, config: VitalityConfig = loadVitalityConfig()): Promise<{
    stat_date: string;
    snapshotted: number;
    computed: number;
    no_observation: number;
}> {
    const stat = statDate || shanghaiDateStr();
    const result = { stat_date: stat, snapshotted: 0, computed: 0, no_observation: 0 };
    if (!config.enabled) {
        console.log('[EventImpactVitality] VITALITY_ENABLED=false，跳过计算');
        return result;
    }
    if (!stat) throw new Error('statDate 为空，无法计算存活度');

    await ensureVitalitySchema();
    result.snapshotted = await snapshotChainBaselines(stat, config.windowMaxDays, config.topIndustries);

    const baselines = await loadBaselines(stat, config.windowMaxDays);
    if (baselines.length === 0) {
        console.log(`[EventImpactVitality] ${stat} 无窗口内事件`);
        return result;
    }

    // 行业 → 板块代码索引（注入纯函数解析口径）
    const industryIndex = await getIndustryCodeIndex();

    // 需要观测的板块代码（行业名解析 + 别名桥接）
    const neededCodes = new Set<string>();
    for (const b of baselines) {
        for (const node of topChainIndustries(b.chain, config.topIndustries)) {
            const code = resolveIndustryBoardCode(node.industry, industryIndex);
            if (code) neededCodes.add(code);
        }
    }

    const boardPct = new Map<string, Map<string, number>>();
    await withConcurrency([...neededCodes], 8, async (code) => {
        try {
            const kline = await fetchBoardKline(code, 120);
            if (kline) boardPct.set(code, buildBoardPct(kline));
        } catch (err) {
            console.warn(`[EventImpactVitality] 板块日线失败 ${code}:`, (err as Error).message);
        }
    });

    const benchmarkPct = await fetchBenchmarkPct(config);

    const peers = baselines.map((b) => ({
        event_id: b.event_id,
        chain: b.chain,
        direction: dominantDirection(b.chain),
        event_date: b.event_date,
    }));

    const rows = baselines.map((b) => ({
        event_id: b.event_id,
        result: computeVitality({ baseline: b, statDate: stat, industryIndex, boardPct, benchmarkPct, peerEvents: peers, config }),
    }));

    await replaceVitalityRows(stat, rows);
    result.computed = rows.length;
    result.no_observation = rows.filter((r) => r.result.impact_status === 'no_observation').length;
    console.log(
        `[EventImpactVitality] ${stat} 完成: 快照 ${result.snapshotted} / 计算 ${result.computed} / no_observation ${result.no_observation}`,
    );
    return result;
}
