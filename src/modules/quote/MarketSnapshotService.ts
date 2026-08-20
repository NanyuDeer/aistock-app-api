/**
 * MarketSnapshotService — 当日 A 股大盘收盘事实聚合
 *
 * 设计原则（见 plan: 2026-07-19-daily-market-trace-agent.md Task 1）：
 * - 只聚合事实，禁止导入任何 LLM、新闻或 Agent 模块。
 * - 不回退昨日缓存；事实必须来自当日 Tushare 完整抓取。
 * - 以 000001.SH 的 index_daily 序列识别当前/前一交易日。
 * - Asia/Shanghai 时区计算请求日，避免服务器 UTC 日期漂移。
 * - CompleteDailyResult.rows 仅在 Node 内部用于计算；对外仅暴露 DailyCoverageSummary。
 * - 通过 __marketSnapshotDependencies 注入依赖，便于单测替换。
 */

import {
    getIndexDaily,
    getCompleteDailyByDate,
    getLimitListThs,
    getLimitStep,
    getMoneyflowCntThs,
    getMoneyflowIndDc,
    getMoneyflowThsByDate,
    type IndexDailyRow,
    type DailyPriceRow,
    type LimitStepRow,
    type MoneyflowCntThsRow,
    type MoneyflowIndDcRow,
    type MoneyflowThsRow,
    type CompleteDailyResult,
    type DailyCoverageReason,
} from './TushareService';
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService';
import { shanghaiDateYyyymmdd, shanghaiHourMinute } from '../../shared/utils/shanghaiTime';

// ============================================================================
// 对外类型定义
// ============================================================================

/** 单个指数的收盘事实。 */
export interface CloseIndexFact {
    ts_code: string;
    name: string;
    trade_date: string;
    close: number;
    pct_chg: number;
    amount: number;
    source: 'tushare:index_daily';
}

/** 概念板块事实（仅保留必要字段，板块涨跌与资金流各自独立排序）。 */
export interface SectorFact {
    ts_code: string;
    name: string;
    pct_change: number;
    net_amount: number;
    lead_stock: string;
    company_num: number;
    trade_date: string;
}

/** 完整日线覆盖摘要（不暴露全市场个股日线，仅元数据）。 */
export interface DailyCoverageSummary {
    complete: boolean;
    reason: DailyCoverageReason;
    page_count: number;
    row_count: number;
}

/** 全市场宽度（quick snapshot 用，含近似涨跌停）。 */
export interface MarketBreadth {
    total_count: number;
    advance_count: number;
    decline_count: number;
    flat_count: number;
    limit_up_count: number;
    limit_down_count: number;
    limit_count_approximate: boolean;
    total_volume: number;
    avg_change_pct: number;
    /** 全市场成交额合计（元），来自腾讯行情行“成交额”（万元→元）。 */
    total_amount_yuan: number;
}

/** quick snapshot 数据覆盖标识。 */
export interface QuickSnapshotCoverage {
    has_limit_pool: boolean;
    has_moneyflow: boolean;
    has_concept_flow: boolean;
}

/** 一个 quick snapshot 数据域的可用性说明。 */
export type QuickDataAvailability =
    | { state: 'available' }
    | { state: 'partial'; available_fields: string[]; approximate?: boolean; reason?: string }
    | { state: 'unavailable'; reason: string };

/** quick snapshot 各个数据域的真实可用性。 */
export interface QuickSnapshotDataAvailability {
    breadth: QuickDataAvailability;
    turnover: QuickDataAvailability;
    limits: QuickDataAvailability;
    sectors: QuickDataAvailability;
    main_force: QuickDataAvailability;
}

/** 当日 A 股大盘收盘事实快照。 */
export interface CloseMarketSnapshot {
    schema_version: '1.0';
    status: 'complete';
    trade_date: string;
    captured_at: string;
    indexes: CloseIndexFact[];
    breadth: {
        total_count: number;
        advance_count: number;
        decline_count: number;
        flat_count: number;
        advance_ratio: number;
        source: 'tushare:daily';
    };
    turnover: {
        amount_yuan: number;
        previous_amount_yuan: number;
        change_pct: number;
        source: 'tushare:daily';
    };
    limits: {
        up_count: number;
        down_count: number;
        broken_count: number;
        highest_board: number;
    };
    sectors: {
        top_gainers: SectorFact[];
        top_losers: SectorFact[];
        top_inflows: SectorFact[];
        top_outflows: SectorFact[];
    };
    main_force: {
        large_and_extra_large_net_yuan: number;
        source: 'tushare:moneyflow_ths';
    };
    coverage: {
        current_daily: DailyCoverageSummary;
        previous_daily: DailyCoverageSummary;
    };
}

/** 15:30 后腾讯 quick snapshot 的专用事实契约。 */
export interface QuickCloseMarketSnapshot extends Omit<
    CloseMarketSnapshot,
    'breadth' | 'turnover' | 'limits' | 'main_force'
> {
    snapshot_kind: 'quick';
    breadth: {
        total_count: number | null;
        advance_count: number | null;
        decline_count: number | null;
        flat_count: number | null;
        advance_ratio: number | null;
        source: 'tencent:quote';
    };
    turnover: {
        amount_yuan: number | null;
        previous_amount_yuan: number | null;
        change_pct: number | null;
        source: 'tushare:daily' | 'tencent:quote';
        /** quick 版成交额为全市场行情行聚合近似（腾讯源），非 Tushare 精确口径。 */
        approximate?: boolean;
    };
    limits: {
        up_count: number | null;
        down_count: number | null;
        /** 精确炸板数（东财 push2ex getTopicZBPool）；腾讯兜底时仍为 null。 */
        broken_count: number | null;
        /** 最高连板数（东财涨停池 lbc 最大值）；腾讯兜底时仍为 null。 */
        highest_board: number | null;
    };
    main_force: {
        large_and_extra_large_net_yuan: number | null;
        source:
            | 'tushare:moneyflow_ths'
            | 'tushare:moneyflow_cnt_ths'
            | 'tencent:board_main_flow'
            | 'eastmoney:industry_main_force';
        /** quick 版主力净额为行业板块主力净流入合计近似（board_main_flow / industry_main_force）。 */
        approximate?: boolean;
    };
    coverage_info: QuickSnapshotCoverage;
    quick_data_availability: QuickSnapshotDataAvailability;
    market_breadth?: MarketBreadth;
}

/** 快照不可用原因。 */
export type MarketSnapshotUnavailableReason =
    | 'market_not_closed'
    | 'incomplete_daily_coverage';

/**
 * 409 响应体中 data.status 的取值：
 * - not_ready：未收盘（盘中 / 非交易日 / 指数数据未到位），上层可定时重试
 * - incomplete：已收盘但 daily 覆盖残缺（重复页 / 页数上限 / 空），需要数据修复
 *
 * 区分二者是为了让 Python 侧按需重试时知道"再等一会儿"还是"今天没救了"。
 */
export type MarketSnapshotUnavailableStatus = 'not_ready' | 'incomplete';

/** reason -> status 的固定映射，避免不同抛出点写错语义。 */
function statusFromReason(reason: MarketSnapshotUnavailableReason): MarketSnapshotUnavailableStatus {
    return reason === 'incomplete_daily_coverage' ? 'incomplete' : 'not_ready';
}

/**
 * 当收盘事实不完整时抛出。
 * - market_not_closed：指数序列不足以识别 requestDate 当日行，或某指数缺当日行
 *   （含盘中、非交易日、数据延迟三种场景，status='not_ready'）
 * - incomplete_daily_coverage：当日或前日全市场日线抓取不完整（重复页/页数上限/空）
 *   （status='incomplete'）
 */
export class MarketSnapshotUnavailableError extends Error {
    readonly status: MarketSnapshotUnavailableStatus;
    readonly reason: MarketSnapshotUnavailableReason;

    constructor(reason: MarketSnapshotUnavailableReason, message?: string) {
        super(message ?? reason);
        this.name = 'MarketSnapshotUnavailableError';
        this.status = statusFromReason(reason);
        this.reason = reason;
    }
}

// ============================================================================
// 依赖注入（便于单测替换；生产环境默认指向真实 TushareService 导出）
// ============================================================================

export interface MarketSnapshotDeps {
    getIndexDaily: typeof getIndexDaily;
    getCompleteDailyByDate: typeof getCompleteDailyByDate;
    getLimitListThs: typeof getLimitListThs;
    getLimitStep: typeof getLimitStep;
    getMoneyflowCntThs: typeof getMoneyflowCntThs;
    /** D6（2026-08-17 数据源裁决）：行业板块资金流（doc_id=371 免费族），
     * 用于快照 sectors 概念板块（cnt_ths）之外的行业板块净流入补漏。 */
    getMoneyflowIndDc: typeof getMoneyflowIndDc;
    getMoneyflowThsByDate: typeof getMoneyflowThsByDate;
    /**
     * 当前时刻工厂。生产环境默认返回 new Date()；测试可注入固定时间，
     * 让内部路由测试不依赖真实当前时刻。
     */
    now: () => Date;
}

export const __marketSnapshotDependencies: MarketSnapshotDeps = {
    getIndexDaily,
    getCompleteDailyByDate,
    getLimitListThs,
    getLimitStep,
    getMoneyflowCntThs,
    getMoneyflowIndDc,
    getMoneyflowThsByDate,
    now: () => new Date(),
};

// ============================================================================
// 常量
// ============================================================================

interface IndexDef {
    ts_code: string;
    name: string;
}

/** 固定指数集合：上证、深成、创业板、沪深300、中证500、中证1000。 */
const INDEX_FACTS: readonly IndexDef[] = [
    { ts_code: '000001.SH', name: '上证指数' },
    { ts_code: '399001.SZ', name: '深证成指' },
    { ts_code: '399006.SZ', name: '创业板指' },
    { ts_code: '000300.SH', name: '沪深300' },
    { ts_code: '000905.SH', name: '中证500' },
    { ts_code: '000852.SH', name: '中证1000' },
];

const SH_INDEX_CODE = '000001.SH';

/** index_daily 回看窗口（自然日；足以覆盖最长节假日后的最近交易日）。 */
const LOOKBACK_DAYS = 15;

/** 概念板块涨跌与资金流各自保留前 N / 后 N。 */
const TOP_SECTOR_COUNT = 5;

/** 涨跌停池调用顺序（测试断言这个顺序）：涨停池 → 跌停池 → 炸板池。 */
const LIMIT_POOL_ARGS: readonly ['涨停池', '跌停池', '炸板池'] = ['涨停池', '跌停池', '炸板池'];

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 将 Date 转换为 Asia/Shanghai 时区的 YYYYMMDD 字符串。
 * 统一走 shared/utils/shanghaiTime 通用函数，避免各模块重复实现。
 */
function toShanghaiDateYyyymmdd(now: Date): string {
    return shanghaiDateYyyymmdd(now);
}

/**
 * 取 Asia/Shanghai 时区的 { hour, minute }（用于 15:30 收盘时钟门禁）。
 * 统一走 shared/utils/shanghaiTime 通用函数。
 */
function toShanghaiHourMinute(now: Date): { hour: number; minute: number } {
    return shanghaiHourMinute(now);
}

/**
 * A 股收盘时刻：Asia/Shanghai 15:30。
 * 15:30 前即使 6 指数和日线数据都已存在，也必须拒绝（盘中数据未稳定）。
 */
const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MINUTE = 30;

/**
 * 判断给定时刻是否已过 A 股收盘时刻（Asia/Shanghai 15:30）。
 * 严格语义：hour > 15 或 (hour == 15 且 minute >= 30) 才返回 true。
 */
export function isAtOrAfterClose(now: Date): boolean {
    const { hour, minute } = toShanghaiHourMinute(now);
    return hour > MARKET_CLOSE_HOUR || (hour === MARKET_CLOSE_HOUR && minute >= MARKET_CLOSE_MINUTE);
}

/** 从 YYYYMMDD 计算向前 lookbackDays 天的 YYYYMMDD（用于 index_daily start_date）。 */
function toLookbackStartYyyymmdd(requestYyyymmdd: string, lookbackDays: number): string {
    const y = Number(requestYyyymmdd.slice(0, 4));
    const m = Number(requestYyyymmdd.slice(4, 6)) - 1; // JS 月份从 0 开始
    const d = Number(requestYyyymmdd.slice(6, 8));
    const date = new Date(Date.UTC(y, m, d));
    date.setUTCDate(date.getUTCDate() - lookbackDays);
    const yy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yy}${mm}${dd}`;
}

/** 将 MoneyflowCntThsRow 映射为对外的 SectorFact（仅保留必要字段）。 */
function toSectorFact(row: MoneyflowCntThsRow): SectorFact {
    return {
        ts_code: row.ts_code,
        name: row.name,
        pct_change: row.pct_change,
        net_amount: row.net_amount,
        lead_stock: row.lead_stock,
        company_num: row.company_num,
        trade_date: row.trade_date,
    };
}

/**
 * 板块名称归一化（D6，2026-08-17 数据源裁决）。
 * 复用 WindLeaderAnalyzerService.ts:1094-1103 的匹配逻辑（模块解耦禁止跨模块 import，
 * 此处本地同构实现，后续如需收敛可提取到 shared/utils）。
 * 去空白/括号后缀/概念指数后缀/连接词/罗马数字分级后缀，小写化。
 */
function normalizeBoardName(name: string): string {
    return String(name || '')
        .replace(/\s+/g, '')
        .replace(/[（(](?:概念|指数)[)）]/g, '')
        .replace(/(概念|指数)$/, '')
        .replace(/[及与和]/g, '')
        .replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+$/, '')
        .toLowerCase();
}

/**
 * D6（2026-08-17 数据源裁决）：以 cnt_ths（概念板块）为主，ind_dc（行业板块）
 * 按名称归一匹配补漏——仅对概念板块中净流入为 0 的行，用同名行业板块的真实净流入补齐。
 * 单位换算：cnt_ths net_amount 为亿元，ind_dc net_amount 为元 → /1e8 对齐亿元。
 * 仅展示层（sectors 字段），不进 AI 推理链路。
 */
export function mergeIndustryInflow(
    conceptRows: MoneyflowCntThsRow[],
    industryRows: MoneyflowIndDcRow[],
): MoneyflowCntThsRow[] {
    // ind_dc 按归一化名称索引；同名多个时优先 content_type=行业，仍多个取净额绝对值最大者
    const indByNorm = new Map<string, MoneyflowIndDcRow>();
    for (const row of industryRows) {
        const norm = normalizeBoardName(row.name);
        if (!norm) continue;
        const prev = indByNorm.get(norm);
        if (!prev) {
            indByNorm.set(norm, row);
            continue;
        }
        const prevIsIndustry = prev.content_type === '行业';
        const curIsIndustry = row.content_type === '行业';
        const preferCur = (curIsIndustry && !prevIsIndustry)
            || (curIsIndustry === prevIsIndustry
                && Math.abs(row.net_amount || 0) > Math.abs(prev.net_amount || 0));
        if (preferCur) indByNorm.set(norm, row);
    }
    if (indByNorm.size === 0) return conceptRows;

    return conceptRows.map((row) => {
        // 已有净流入的行不补（概念板块自身数据优先，防覆盖真实值）
        if ((Number(row.net_amount) || 0) !== 0) return row;
        const norm = normalizeBoardName(row.name);
        const ind = norm ? indByNorm.get(norm) : undefined;
        if (!ind || typeof ind.net_amount !== 'number' || !Number.isFinite(ind.net_amount)) return row;
        return {
            ...row,
            // 元 → 亿元，与 cnt_ths 口径对齐（四舍五入到 4 位，避免浮点噪声）
            net_amount: Math.round((ind.net_amount / 1e8) * 10000) / 10000,
        };
    });
}

/**
 * 概念板块排序：涨跌（pct_change）与资金流（net_amount）各自独立排序。
 * - top_gainers：pct_change 降序前 5
 * - top_losers：pct_change 升序前 5（最负在前）
 * - top_inflows：net_amount 降序前 5
 * - top_outflows：net_amount 升序前 5（最负在前）
 */
function selectTopSectors(rows: MoneyflowCntThsRow[]): {
    top_gainers: SectorFact[];
    top_losers: SectorFact[];
    top_inflows: SectorFact[];
    top_outflows: SectorFact[];
} {
    const byPctDesc = [...rows].sort((a, b) => b.pct_change - a.pct_change);
    const byPctAsc = [...rows].sort((a, b) => a.pct_change - b.pct_change);
    const byNetDesc = [...rows].sort((a, b) => b.net_amount - a.net_amount);
    const byNetAsc = [...rows].sort((a, b) => a.net_amount - b.net_amount);
    return {
        top_gainers: byPctDesc.slice(0, TOP_SECTOR_COUNT).map(toSectorFact),
        top_losers: byPctAsc.slice(0, TOP_SECTOR_COUNT).map(toSectorFact),
        top_inflows: byNetDesc.slice(0, TOP_SECTOR_COUNT).map(toSectorFact),
        top_outflows: byNetAsc.slice(0, TOP_SECTOR_COUNT).map(toSectorFact),
    };
}

/**
 * 大单 + 特大单净额（万元）→ 元。
 * 单只个股：(buy_lg_amount + buy_elg_amount - sell_lg_amount - sell_elg_amount) × 10000
 */
export function computeMainForceNetYuan(rows: MoneyflowThsRow[]): number {
    let netWan = 0;
    for (const row of rows) {
        // Number(x) || 0 防护：Tushare moneyflow_ths 当日数据未完全就绪时，
        // buy_elg_amount 等字段可能为 undefined，直接相加会得到 NaN，
        // JSON 序列化后变成 null（曾被误判为数据缺失的根因）。
        netWan += (Number(row.buy_lg_amount) || 0)
            + (Number(row.buy_elg_amount) || 0)
            - (Number(row.sell_lg_amount) || 0)
            - (Number(row.sell_elg_amount) || 0);
    }
    return Math.round(netWan * 10000);
}

/**
 * 判断 moneyflow_ths 行是否包含完整的大单/特大单买卖字段。
 *
 * Tushare moneyflow_ths 在收盘后数据分批发回，可能出现 buy_lg_amount 已有值、
 * 但 buy_elg_amount/sell_lg_amount/sell_elg_amount 仍为 undefined 的部分数据。
 * 此时 computeMainForceNetYuan 会把缺失字段当 0，得到偏差巨大的结果，
 * 调用方（如 TencentSnapshotService）应据此降级到概念板块近似或标记 unavailable。
 */
export function hasCompleteMainForceFields(rows: MoneyflowThsRow[]): boolean {
    return rows.every((row) =>
        [row.buy_lg_amount, row.buy_elg_amount, row.sell_lg_amount, row.sell_elg_amount]
            .every((v) => typeof v === 'number' && Number.isFinite(v)),
    );
}

/** 连板天梯最高板数；无数据返回 0。 */
function computeHighestBoard(rows: LimitStepRow[]): number {
    let max = 0;
    for (const row of rows) {
        if (Number.isFinite(row.nums) && row.nums > max) {
            max = row.nums;
        }
    }
    return max;
}

/** amount(千元) → 元，对全市场日线求和。 */
export function sumAmountYuan(rows: DailyPriceRow[]): number {
    let total = 0;
    for (const row of rows) {
        total += row.amount;
    }
    return Math.round(total * 1000);
}

/** CompleteDailyResult → DailyCoverageSummary（剥离 rows，仅保留元数据）。 */
export function toCoverageSummary(result: CompleteDailyResult): DailyCoverageSummary {
    return {
        complete: result.complete,
        reason: result.reason,
        page_count: result.page_count,
        row_count: result.rows.length,
    };
}

// ============================================================================
// 主入口：getTodayCloseSnapshot
// ============================================================================

/**
 * 获取最近一个已完成交易日的收盘快照（跳过 15:30 时钟门禁）。
 *
 * 在开盘前（如凌晨 3 点）调用时返回上一交易日的完整收盘数据，
 * 让 Python review_full 链路能使用昨日数据完成测试/生成。
 *
 * 实现：构造一个"伪当前时刻"（最近交易日 15:30），
 * 复用 getTodayCloseSnapshot 的完整构建逻辑。
 */
export async function getLastCloseSnapshot(): Promise<CloseMarketSnapshot> {
    const now = __marketSnapshotDependencies.now();
    // 目标 = 严格早于今天的最近交易日（与时刻无关）：盘中/15:00-15:30/非交易日/凌晨
    // 一律回退上一真实交易日，消除 getRecentTradingDay 以 15:00 为界导致的空窗 409。
    const lastTradingDay = TradingCalendarService.getPreviousTradingDay(now);
    // —— 以下保持不变（取 Shanghai YYYYMMDD、构造伪时刻、复用 getTodayCloseSnapshot）——

    // 取最近交易日的 Shanghai YYYYMMDD
    const lastShanghaiStr = toShanghaiDateYyyymmdd(lastTradingDay);
    const year = Number(lastShanghaiStr.slice(0, 4));
    const month = Number(lastShanghaiStr.slice(4, 6)) - 1;
    const day = Number(lastShanghaiStr.slice(6, 8));

    // 构造伪当前时刻：最近交易日 15:30 CST = 07:30 UTC
    const fakeNow = new Date(Date.UTC(year, month, day, 7, 30, 0, 0));

    return getTodayCloseSnapshot(fakeNow);
}

/**
 * 按目标交易日重建收盘快照（三期：review 历史切片回补）。
 *
 * 实现：校验 YYYY-MM-DD 格式 → 构造目标日 15:30 CST 伪时刻（复用
 * getLastCloseSnapshot 模式）→ getTodayCloseSnapshot(fakeNow) 按需重算。
 * 历史 daily 数据在库即可；非交易日/数据缺失由构建逻辑抛 market_not_closed /
 * incomplete_daily_coverage（409 语义不变）。
 */
export async function getCloseSnapshotByDate(dateStr: string): Promise<CloseMarketSnapshot> {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!m) {
        throw new MarketSnapshotUnavailableError('market_not_closed', `invalid date format: ${dateStr}`);
    }
    // 目标日 15:30 CST = 07:30 UTC（与 getLastCloseSnapshot 的伪时刻构造一致）
    const fakeNow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 7, 30, 0, 0));
    return getTodayCloseSnapshot(fakeNow);
}

/**
 * 构建当日 A 股大盘收盘事实快照。
 *
 * 步骤：
 * 0. Asia/Shanghai 时钟门禁：15:30 前一律抛 market_not_closed，即使 6 指数和日线
 *    数据都已存在。盘中数据未稳定，禁止把盘中事实冒充"今日已收盘"。
 * 1. Asia/Shanghai 计算 requestDate；以 000001.SH 序列识别 current/previous trade_date。
 *    严格校验 currentTradeDate === requestDate：盘中 / 非交易日 / 数据延迟时一律抛
 *    market_not_closed，禁止把上一交易日伪装成"今日已收盘"。
 * 2. 校验 6 个指数都存在 current trade_date 行，否则抛 market_not_closed
 * 3. 抓取当日 + 前日完整日线；任一不完整抛 incomplete_daily_coverage
 * 4. 计算市场宽度（涨/跌/平家数）
 * 5. 计算成交额（千元 → 元）及环比
 * 6. 涨停池/跌停池/炸板池 + 连板天梯
 * 7. 概念板块（涨跌与资金流各自独立排序）
 * 8. 主力资金净额（大单 + 特大单，万元 → 元）
 *
 * @param nowOverride 用于计算请求日的时刻；测试可注入固定时间。
 *   不传时使用 `__marketSnapshotDependencies.now()`，让内部路由测试通过
 *   替换 `deps.now` 注入固定时间，不依赖真实当前时刻。
 */
export async function getTodayCloseSnapshot(nowOverride?: Date): Promise<CloseMarketSnapshot> {
    const deps = __marketSnapshotDependencies;
    const now = nowOverride ?? deps.now();
    const requestDate = toShanghaiDateYyyymmdd(now);

    // 完整同日行情数据不能证明当天是 A 股交易日；周末和节假日必须在所有行情调用前拒绝。
    if (!TradingCalendarService.isTradingDayYyyymmdd(requestDate)) {
        throw new MarketSnapshotUnavailableError(
            'market_not_closed',
            `request date ${requestDate} is not an A-share trading day`,
        );
    }

    // ---- 0. Asia/Shanghai 收盘时钟门禁 ----
    // 关键契约：currentTradeDate === requestDate 只能证明"当天数据存在"，
    // 不能证明"已收盘"。盘中 Tushare 可能已经推送当日指数行，但数据尚未稳定。
    // 必须在所有 Tushare 调用前先校验 Asia/Shanghai 时间 ≥ 15:30。
    // 15:30 前一律抛 market_not_closed，让上层（Python 侧）按 not_ready 语义重试。
    if (!isAtOrAfterClose(now)) {
        throw new MarketSnapshotUnavailableError(
            'market_not_closed',
            `market has not closed yet (Asia/Shanghai time before 15:30)`,
        );
    }

    const lookbackStart = toLookbackStartYyyymmdd(requestDate, LOOKBACK_DAYS);
    const capturedAt = now.toISOString();

    // ---- 1. 以 000001.SH 序列识别当前/前日交易日期 ----
    // 关键契约：只有当 SH 序列包含 requestDate 当日行时，才能识别为"今日已收盘"。
    // 旧实现用 `<= requestDate` 取最新一行作为 currentTradeDate，会把周末/节假日/数据延迟
    // 场景下的"上一交易日"伪装成"今日已收盘"。这里改为严格相等校验：
    // 若序列最新一行 trade_date != requestDate，立即抛 market_not_closed，
    // 让上层（Python 侧）按 not_ready 语义定时重试。
    const shRows = await deps.getIndexDaily(SH_INDEX_CODE, lookbackStart);
    const shSortedDesc = shRows
        .filter(r => r.trade_date <= requestDate)
        .sort((a, b) => b.trade_date.localeCompare(a.trade_date));
    if (shSortedDesc.length < 2) {
        throw new MarketSnapshotUnavailableError(
            'market_not_closed',
            `000001.SH has fewer than 2 trade_date rows on or before ${requestDate}`,
        );
    }
    const currentTradeDate = shSortedDesc[0].trade_date;
    if (currentTradeDate !== requestDate) {
        // SH 序列最新一行不是 requestDate 当日：
        // - 周末/节假日：requestDate 不是交易日，序列最新行是上一交易日
        // - 盘中数据延迟：requestDate 是交易日，但 Tushare index_daily 尚未推送当日行
        // - 节假日后首个交易日的早盘：同样可能延迟
        // 任何一种都不能把上一交易日的事实冒充"今日已收盘"。
        throw new MarketSnapshotUnavailableError(
            'market_not_closed',
            `000001.SH latest trade_date ${currentTradeDate} != requestDate ${requestDate} (non-trading day or data lag)`,
        );
    }
    const previousTradeDate = shSortedDesc[1].trade_date;

    // ---- 2. 校验全部 6 个指数都存在当前 trade_date 行 ----
    const indexFacts: CloseIndexFact[] = [];
    for (const def of INDEX_FACTS) {
        // 000001.SH 已抓取，直接复用 shSortedDesc；其他指数需独立抓取
        const rows = def.ts_code === SH_INDEX_CODE
            ? shSortedDesc
            : (await deps.getIndexDaily(def.ts_code, lookbackStart))
                .filter(r => r.trade_date <= requestDate);
        const currentRow = rows.find(r => r.trade_date === currentTradeDate);
        if (!currentRow) {
            throw new MarketSnapshotUnavailableError(
                'market_not_closed',
                `index ${def.ts_code} lacks current trade_date row ${currentTradeDate}`,
            );
        }
        indexFacts.push({
            ts_code: def.ts_code,
            name: def.name,
            trade_date: currentRow.trade_date,
            close: currentRow.close,
            pct_chg: currentRow.pct_chg,
            amount: currentRow.amount,
            source: 'tushare:index_daily',
        });
    }

    // ---- 3. 抓取当日 + 前日完整日线（不完整即失败） ----
    const currentDaily = await deps.getCompleteDailyByDate(currentTradeDate);
    if (!currentDaily.complete) {
        throw new MarketSnapshotUnavailableError(
            'incomplete_daily_coverage',
            `current daily coverage incomplete: ${currentDaily.reason}`,
        );
    }
    const previousDaily = await deps.getCompleteDailyByDate(previousTradeDate);
    if (!previousDaily.complete) {
        throw new MarketSnapshotUnavailableError(
            'incomplete_daily_coverage',
            `previous daily coverage incomplete: ${previousDaily.reason}`,
        );
    }

    // ---- 4. 市场宽度（涨/跌/平家数来自完整当日日线） ----
    const currentRows = currentDaily.rows;
    let advanceCount = 0;
    let declineCount = 0;
    let flatCount = 0;
    for (const row of currentRows) {
        if (row.pct_chg > 0) {
            advanceCount += 1;
        } else if (row.pct_chg < 0) {
            declineCount += 1;
        } else {
            flatCount += 1;
        }
    }
    const totalCount = currentRows.length;
    const advanceRatio = totalCount > 0 ? advanceCount / totalCount : 0;

    // ---- 5. 成交额（amount 千元 → 元）及环比 ----
    const amountYuan = sumAmountYuan(currentRows);
    const previousAmountYuan = sumAmountYuan(previousDaily.rows);
    const changePct = previousAmountYuan > 0
        ? Number((((amountYuan - previousAmountYuan) / previousAmountYuan) * 100).toFixed(2))
        : 0;

    // ---- 6. 涨跌停池（顺序固定：涨停池 → 跌停池 → 炸板池）+ 连板天梯 ----
    const upPool = await deps.getLimitListThs(currentTradeDate, LIMIT_POOL_ARGS[0]);
    const downPool = await deps.getLimitListThs(currentTradeDate, LIMIT_POOL_ARGS[1]);
    const brokenPool = await deps.getLimitListThs(currentTradeDate, LIMIT_POOL_ARGS[2]);
    const limitStepRows = await deps.getLimitStep(currentTradeDate);
    const highestBoard = computeHighestBoard(limitStepRows);

    // ---- 7. 概念板块（涨跌与资金流各自独立排序，前 5 / 后 5） ----
    const sectorRows = await deps.getMoneyflowCntThs(currentTradeDate);
    // D6（2026-08-17 数据源裁决）：moneyflow_cnt_ths 只含概念板块(885/886xxx)，
    // 不含行业板块(881xxx/BKxxxx)。用 moneyflow_ind_dc（doc_id=371 免费族）按名称
    // 归一匹配，为概念板块中净流入为 0 的行业板块补充真实净流入（仅展示层，不进 AI 链路）。
    // ind_dc 为补漏源：失败时降级为纯概念板块（保持 D6 前行为），不阻断快照。
    let industryRows: MoneyflowIndDcRow[] = [];
    try {
        industryRows = await deps.getMoneyflowIndDc(currentTradeDate);
    } catch (err) {
        console.warn('[MarketSnapshot] moneyflow_ind_dc 获取失败，行业板块净流入保持0:', err instanceof Error ? err.message : String(err));
    }
    const sectors = selectTopSectors(mergeIndustryInflow(sectorRows, industryRows));

    // ---- 8. 主力资金净额（大单 + 特大单，万元 → 元） ----
    const moneyflowRows = await deps.getMoneyflowThsByDate(currentTradeDate);
    const mainForceNetYuan = computeMainForceNetYuan(moneyflowRows);

    return {
        schema_version: '1.0',
        status: 'complete',
        trade_date: currentTradeDate,
        captured_at: capturedAt,
        indexes: indexFacts,
        breadth: {
            total_count: totalCount,
            advance_count: advanceCount,
            decline_count: declineCount,
            flat_count: flatCount,
            advance_ratio: advanceRatio,
            source: 'tushare:daily',
        },
        turnover: {
            amount_yuan: amountYuan,
            previous_amount_yuan: previousAmountYuan,
            change_pct: changePct,
            source: 'tushare:daily',
        },
        limits: {
            up_count: upPool.length,
            down_count: downPool.length,
            broken_count: brokenPool.length,
            highest_board: highestBoard,
        },
        sectors,
        main_force: {
            large_and_extra_large_net_yuan: mainForceNetYuan,
            source: 'tushare:moneyflow_ths',
        },
        coverage: {
            current_daily: toCoverageSummary(currentDaily),
            previous_daily: toCoverageSummary(previousDaily),
        },
    };
}
