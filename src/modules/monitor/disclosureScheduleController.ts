/**
 * 自选股财报披露计划 API
 *
 * 数据源：Tushare `disclosure_date`（doc_id=162）的 `pre_date`（预计披露日期）。
 * 此前该字段在系统中从未被业务使用（仅 formal 发现用 `actual_date`），本接口补齐
 * 「未来披露前瞻」能力，供事件时间线展示自选股「大概什么时候出财报」。
 *
 * 取数口径：
 * - 按报告期（`end_date`）整表拉取，客户端按 ts_code 筛选（Tushare 不支持按 ts_code 查）
 * - 只保留 `actual_date` 为空（尚未披露）且 `pre_date` 在 [今天, 今天+days] 窗口内的记录
 * - 覆盖「当前最近已结束报告期」+「下一报告期」两期：披露季常跨期
 *   （如三季报 10 月披露完亦可能看到年报预约时间），两期并集保证窗口内不漏
 *
 * 缓存：按报告期缓存 12 小时（披露日期为低频变更的计划数据，且整表拉取有成本）。
 *
 * 路由：GET /api/cn/stocks/disclosure-schedule?symbols=600519,000001&days=90
 */

import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import { CacheService } from '../../shared/utils/CacheService';
import { getStockIdentity, normalizeStockSymbol } from '../../shared/utils/stock';
import { shanghaiDateStr } from '../../shared/utils/shanghaiTime';
import { getDisclosureDate } from '../quote/TushareService';

/** 单次查询股票数上限（自选股规模量级，防滥用）。 */
const MAX_SYMBOLS = 200;
/** days 缺省值。 */
const DEFAULT_DAYS = 90;
/** days 上限（披露季最长约 4 个月）。 */
const MAX_DAYS = 180;
/** 报告期缓存 TTL（秒）。 */
const CACHE_TTL_SECONDS = 12 * 3600;

/** 归一后的单条披露计划。 */
interface DisclosurePlanItem {
    /** 6 位裸码 */
    symbol: string;
    /** 报告期 YYYYMMDD */
    reportPeriod: string;
    /** 报告期中文标签，如「2026三季报」 */
    reportPeriodLabel: string;
    /** 预计披露日期 YYYY-MM-DD */
    preDate: string;
    /** 距今天数（0=今天） */
    daysUntil: number;
}

/** 缓存内的单期计划：ts_code → 预计披露日（YYYY-MM-DD）。 */
type PeriodSchedule = Record<string, string>;

/** 6 位裸码 → Tushare ts_code（无法识别板块时返回空串，避免产出无效 ts_code）。 */
function toTsCode(symbol: string): string {
    const code = normalizeStockSymbol(symbol);
    if (!code) return '';
    const market = getStockIdentity(code).market;
    if (market === 'unknown') return '';
    return `${code}.${market.toUpperCase()}`;
}

/** 最近的已结束报告期（YYYYMMDD），口径同 PerformanceReportAutoUpdateService.getRecentPeriods。 */
function latestEndedPeriod(today: string): string {
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7));
    const d = Number(today.slice(8, 10));
    const quarters: Array<[string, number, number]> = [['0331', 3, 31], ['0630', 6, 30], ['0930', 9, 30], ['1231', 12, 31]];
    for (let i = quarters.length - 1; i >= 0; i--) {
        const [md, qm, qd] = quarters[i];
        if (m > qm || (m === qm && d >= qd)) return `${y}${md}`;
    }
    return `${y - 1}1231`;
}

/** 下一个报告期（与 latestEndedPeriod 严格互逆）。 */
function nextPeriod(period: string): string {
    const y = Number(period.slice(0, 4));
    const md = period.slice(4);
    if (md === '1231') return `${y + 1}0331`;
    const seq: Record<string, string> = { '0331': '0630', '0630': '0930', '0930': '1231' };
    return `${y}${seq[md] || '0630'}`;
}

/** 报告期中文标签：'20260930' → '2026三季报'。 */
function reportPeriodLabel(period: string): string {
    const y = period.slice(0, 4);
    const md = period.slice(4);
    const map: Record<string, string> = { '0331': '一季报', '0630': '半年报', '0930': '三季报', '1231': '年报' };
    return `${y}${map[md] || ''}`;
}

/** Tushare YYYYMMDD → YYYY-MM-DD（非法返回空串）。 */
function compactToIso(compact: string): string {
    const s = String(compact || '').replace(/-/g, '').trim();
    if (!/^\d{8}$/.test(s)) return '';
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** YYYY-MM-DD 偏移 N 天（上海时区，固定 +8 无 DST）。 */
function addDaysIso(iso: string, days: number): string {
    const ms = new Date(`${iso}T00:00:00+08:00`).getTime() + days * 86400000;
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 两个 YYYY-MM-DD 的自然日差（to - from）。 */
function daysBetweenIso(from: string, to: string): number {
    const a = new Date(`${from}T00:00:00+08:00`).getTime();
    const b = new Date(`${to}T00:00:00+08:00`).getTime();
    return Math.round((b - a) / 86400000);
}

/**
 * 拉取单报告期的「预计披露日」映射（ts_code → pre_date），按报告期缓存 12h。
 * 只保留 `actual_date` 为空且 `pre_date` 有效的记录。
 */
async function loadPeriodSchedule(period: string): Promise<PeriodSchedule> {
    const cacheKey = `disclosure_schedule:period:${period}`;
    const cached = await CacheService.get<PeriodSchedule>(cacheKey);
    if (cached) return cached;

    const rows = await getDisclosureDate({ end_date: period });
    const schedule: PeriodSchedule = {};
    for (const row of rows) {
        const tsCode = String(row.ts_code || '').trim().toUpperCase();
        const actual = String(row.actual_date || '').trim();
        const preDate = compactToIso(String(row.pre_date || ''));
        // 已实际披露 / 无预计日 → 跳过
        if (!tsCode || actual || !preDate) continue;
        // 同一 ts_code 多条取更早的预计日（更贴近「大概什么时候」）
        const existing = schedule[tsCode];
        if (!existing || preDate < existing) schedule[tsCode] = preDate;
    }

    await CacheService.put(cacheKey, schedule, CACHE_TTL_SECONDS);
    return schedule;
}

export class DisclosureScheduleController {
    /**
     * GET /api/cn/stocks/disclosure-schedule
     *
     * Query:
     *   - symbols（必填，逗号分隔的股票代码，支持 600519 / 600519.SH / SH600519）
     *   - days（可选，前瞻天数，缺省 90，上限 180）
     *
     * 响应信封：{ code: 200, message: 'success', data: { items: DisclosurePlanItem[] } }
     */
    static async getDisclosureSchedule(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const rawSymbols = String(req.query.symbols || '');
            const symbols = [...new Set(rawSymbols.split(',').map((s) => normalizeStockSymbol(s)).filter(Boolean))].slice(0, MAX_SYMBOLS);
            if (symbols.length === 0) {
                createResponse(res, 200, 'success', { items: [] });
                return;
            }

            const daysRaw = parseInt(String(req.query.days || DEFAULT_DAYS), 10);
            const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : DEFAULT_DAYS, 1), MAX_DAYS);

            const today = shanghaiDateStr();
            const windowEnd = addDaysIso(today, days);

            // 覆盖「最近已结束报告期」+「下一报告期」
            const basePeriod = latestEndedPeriod(today);
            const periods = [basePeriod, nextPeriod(basePeriod)];
            const schedules = await Promise.all(periods.map((p) => loadPeriodSchedule(p)));

            // ts_code → 窗口内最早的一条计划
            const best = new Map<string, { preDate: string; period: string }>();
            periods.forEach((period, idx) => {
                const schedule = schedules[idx];
                for (const [tsCode, preDate] of Object.entries(schedule)) {
                    if (preDate < today || preDate > windowEnd) continue;
                    const current = best.get(tsCode);
                    if (!current || preDate < current.preDate) best.set(tsCode, { preDate, period });
                }
            });

            const items: DisclosurePlanItem[] = [];
            for (const symbol of symbols) {
                const tsCode = toTsCode(symbol);
                if (!tsCode) continue;
                const hit = best.get(tsCode);
                if (!hit) continue;
                items.push({
                    symbol,
                    reportPeriod: hit.period,
                    reportPeriodLabel: reportPeriodLabel(hit.period),
                    preDate: hit.preDate,
                    daysUntil: daysBetweenIso(today, hit.preDate),
                });
            }
            items.sort((a, b) => a.preDate.localeCompare(b.preDate));

            createResponse(res, 200, 'success', { items });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[DisclosureScheduleController] getDisclosureSchedule error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }
}
