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
    getMoneyflowThsByDate,
    type IndexDailyRow,
    type DailyPriceRow,
    type LimitStepRow,
    type MoneyflowCntThsRow,
    type MoneyflowThsRow,
    type CompleteDailyResult,
    type DailyCoverageReason,
} from './TushareService';
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService';

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
 * 使用 Intl.DateTimeFormat 而非服务器本地时区，避免 UTC 日期漂移。
 */
function toShanghaiDateYyyymmdd(now: Date): string {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const parts = fmt.formatToParts(now);
    const y = parts.find(p => p.type === 'year')?.value ?? '';
    const m = parts.find(p => p.type === 'month')?.value ?? '';
    const d = parts.find(p => p.type === 'day')?.value ?? '';
    return `${y}${m}${d}`;
}

/**
 * 取 Asia/Shanghai 时区的 { hour, minute }（用于 15:30 收盘时钟门禁）。
 * 使用 Intl.DateTimeFormat 取 hour/minute，避免服务器本地时区漂移。
 */
function toShanghaiHourMinute(now: Date): { hour: number; minute: number } {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const hour = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
    return { hour, minute };
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
function isAtOrAfterClose(now: Date): boolean {
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
function computeMainForceNetYuan(rows: MoneyflowThsRow[]): number {
    let netWan = 0;
    for (const row of rows) {
        netWan += row.buy_lg_amount + row.buy_elg_amount - row.sell_lg_amount - row.sell_elg_amount;
    }
    return Math.round(netWan * 10000);
}

/** 连板天梯最高板数；无数据返回 0。 */
function computeHighestBoard(rows: LimitStepRow[]): number {
    let max = 0;
    for (const row of rows) {
        if (Number.isFinite(row.limit_times) && row.limit_times > max) {
            max = row.limit_times;
        }
    }
    return max;
}

/** amount(千元) → 元，对全市场日线求和。 */
function sumAmountYuan(rows: DailyPriceRow[]): number {
    let total = 0;
    for (const row of rows) {
        total += row.amount;
    }
    return Math.round(total * 1000);
}

/** CompleteDailyResult → DailyCoverageSummary（剥离 rows，仅保留元数据）。 */
function toCoverageSummary(result: CompleteDailyResult): DailyCoverageSummary {
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
    const sectors = selectTopSectors(sectorRows);

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
