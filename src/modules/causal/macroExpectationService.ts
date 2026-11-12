/**
 * 宏观预期快照 —— 抓取、归一化、落库、回溯查询。
 *
 * 为什么需要落库（2026-11-12 实测）：
 *   华尔街见闻 macrodatas 的 forecast 会过期清空。11-10 查 11-09 的「10月CPI」
 *   有 forecast=0.8；11-12 查 09-09 的「8月CPI」forecast 已为空。实时拉历史不可行，
 *   回测会失去预期基准。必须每日抓「今日 + 未来 7 天」并落库。
 *
 * 三个实现细节（都踩过）：
 *   1. start / end 是 Unix 时间戳，传日期字符串会被静默忽略筛选
 *   2. 必须带 Referer: https://wallstreetcn.com/
 *   3. 不需要 akshare（其 macro_info_ws 只是包装同一接口）
 */

import axios from 'axios';

import pool from '../../core/db';

const API = 'https://api-one-wscn.awtmt.com/apiv1/finance/macrodatas';
const REFERER = 'https://wallstreetcn.com/';

/** 只关心与 A 股归因相关的地区 */
const WATCH_COUNTRIES = new Set(['中国', '美国']);

/** 关键事件的最低重要度 */
const MIN_IMPORTANCE = 3;

export interface RawCalendarItem {
    country?: string;
    title?: string;
    previous?: string | number;
    forecast?: string | number;
    actual?: string | number;
    importance?: string | number;
    public_date?: number;
    unit?: string;
}

export interface MacroExpectationRow {
    indicator: string;
    period: string;
    country: string;
    titleRaw: string;
    unit: string | null;
    previous: number | null;
    forecast: number | null;
    actual: number | null;
    importance: number | null;
    asOf: Date;
}

export interface MacroExpectationView {
    period: string;
    previous: number | null;
    forecast: number | null;
    actual: number | null;
    gap: number | null;
    gapPct: number | null;
    basis: 'forecast' | 'previous_only';
    importance: number | null;
    asOf: string;
}

/**
 * 指标归一化规则。
 *
 * 归一化失败的条目不落库——宁可缺，不造错键。错键会让跨月序列错位，
 * 比缺数据更难排查。
 */
const INDICATOR_RULES: Array<{ pattern: RegExp; key: string; unit: string }> = [
    { pattern: /CPI(同比|年率)/, key: 'CPI_YOY', unit: '%' },
    { pattern: /PPI(同比|年率)/, key: 'PPI_YOY', unit: '%' },
    { pattern: /社会融资规模/, key: 'TSF', unit: '亿元' },
    { pattern: /M2货币供应同比/, key: 'M2_YOY', unit: '%' },
    { pattern: /M1货币供应同比/, key: 'M1_YOY', unit: '%' },
    { pattern: /制造业PMI/, key: 'PMI_MFG', unit: '' },
    { pattern: /ADP就业人数/, key: 'ADP', unit: '万人' },
    { pattern: /首次申请失业救济/, key: 'JOBLESS', unit: '万人' },
    { pattern: /ISM非制造业/, key: 'ISM_SERVICES', unit: '' },
];

const COUNTRY_PREFIX: Record<string, string> = {
    中国: 'CN',
    美国: 'US',
    欧元区: 'EU',
    日本: 'JP',
};

function toNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 把「10月CPI同比」归一成 { indicator: CN_CPI_YOY, period: 2026-10 }。
 *
 * 统计期取标题中第一个「N月」；年份取快照日期的年份。
 * 跨年场景（1 月抓去年 12 月数据）会有偏差，但当前只做日频归因，
 * 同年内足够；真需要精确时用 publish_at 反推。
 */
export function normalizeIndicator(
    title: string,
    country: string,
    asOf: Date,
): { indicator: string; period: string; unit: string } | null {
    const prefix = COUNTRY_PREFIX[country];
    if (!prefix) return null;

    const rule = INDICATOR_RULES.find((item) => item.pattern.test(title));
    if (!rule) return null;

    const monthMatch = title.match(/(\d{1,2})月/);
    if (!monthMatch) return null;
    const month = Number(monthMatch[1]);
    if (!Number.isInteger(month) || month < 1 || month > 12) return null;

    const year = asOf.getUTCFullYear();
    return {
        indicator: `${prefix}_${rule.key}`,
        period: `${year}-${String(month).padStart(2, '0')}`,
        unit: rule.unit,
    };
}

/** 抓取 [start, end) 的日历。日期格式 YYYY-MM-DD，内部转 Unix 时间戳。 */
export async function fetchCalendar(start: string, end: string): Promise<RawCalendarItem[]> {
    const toTs = (day: string): number => {
        const [y, m, d] = day.split('-').map(Number);
        return Math.floor(Date.UTC(y, m - 1, d) / 1000) - 8 * 3600;
    };

    const response = await axios.get(API, {
        params: { start: toTs(start), end: toTs(end) },
        headers: { Referer: REFERER, 'User-Agent': 'Mozilla/5.0' },
        timeout: 25_000,
        // 禁用环境代理：本机 HTTP(S)_PROXY 指向 http://127.0.0.1:xxx，
        // axios 会对 https 目标用它，抛 ERR_INVALID_PROTOCOL。
        // 已验证该域名直连可达（curl --noproxy 返回 200）。
        proxy: false,
    });

    const items = response.data?.data?.items;
    if (!Array.isArray(items)) {
        throw new Error('macro calendar: unexpected payload shape');
    }
    return items as RawCalendarItem[];
}

/** 把原始条目转成落库行。归一化失败、非关注国家、重要度不足的一律丢弃。 */
export function buildRows(items: RawCalendarItem[], asOf: Date): MacroExpectationRow[] {
    const rows: MacroExpectationRow[] = [];
    for (const item of items) {
        const country = String(item.country ?? '');
        if (!WATCH_COUNTRIES.has(country)) continue;

        const importance = toNumber(item.importance);
        if (importance === null || importance < MIN_IMPORTANCE) continue;

        const title = String(item.title ?? '').trim();
        if (!title) continue;

        const normalized = normalizeIndicator(title, country, asOf);
        if (!normalized) continue;

        rows.push({
            indicator: normalized.indicator,
            period: normalized.period,
            country,
            titleRaw: title,
            unit: normalized.unit || null,
            previous: toNumber(item.previous),
            forecast: toNumber(item.forecast),
            actual: toNumber(item.actual),
            importance,
            asOf,
        });
    }
    return rows;
}

/** 落库。同一小时内重复抓取幂等（asOf 已在调用方截断到小时）。 */
export async function saveRows(rows: MacroExpectationRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    let written = 0;
    for (const row of rows) {
        const result = await pool.query(
            `INSERT INTO macro_expectations
                 (indicator, period, country, title_raw, unit,
                  previous, forecast, actual, importance, as_of)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (indicator, period, as_of) DO UPDATE SET
                 title_raw  = EXCLUDED.title_raw,
                 unit       = EXCLUDED.unit,
                 previous   = EXCLUDED.previous,
                 forecast   = EXCLUDED.forecast,
                 actual     = EXCLUDED.actual,
                 importance = EXCLUDED.importance`,
            [
                row.indicator,
                row.period,
                row.country,
                row.titleRaw,
                row.unit,
                row.previous,
                row.forecast,
                row.actual,
                row.importance,
                row.asOf.toISOString(),
            ],
        );
        written += result.rowCount ?? 0;
    }
    return written;
}

/** 抓「今日 + 未来 windowDays 天」并落库。返回写入行数。 */
export async function fetchAndStore(windowDays = 7, now = new Date()): Promise<number> {
    const asOf = new Date(now);
    // 截断到小时：同一小时内重跑幂等，跨小时保留新快照（预期可能被修订）
    asOf.setUTCMinutes(0, 0, 0);

    const fmt = (d: Date): string => d.toISOString().slice(0, 10);
    const end = new Date(asOf.getTime() + (windowDays + 1) * 86_400_000);

    const items = await fetchCalendar(fmt(asOf), fmt(end));
    const rows = buildRows(items, asOf);
    return saveRows(rows);
}

/**
 * point-in-time 查询：某指标在 `at` 时刻可见的最新快照。
 *
 * 按 as_of <= at 过滤，绝不使用事后修订的数据。
 */
export async function queryExpectations(at: Date): Promise<Record<string, MacroExpectationView>> {
    const result = await pool.query<{
        indicator: string;
        period: string;
        previous: string | null;
        forecast: string | null;
        actual: string | null;
        importance: number | null;
        as_of: Date;
    }>(
        `SELECT DISTINCT ON (indicator)
                indicator, period, previous, forecast, actual, importance, as_of
           FROM macro_expectations
          WHERE as_of <= $1
            AND importance >= $2
       ORDER BY indicator, as_of DESC`,
        [at.toISOString(), MIN_IMPORTANCE],
    );

    const output: Record<string, MacroExpectationView> = {};
    for (const row of result.rows) {
        const forecast = row.forecast === null ? null : Number(row.forecast);
        const actual = row.actual === null ? null : Number(row.actual);
        const gap = forecast !== null && actual !== null ? actual - forecast : null;
        const gapPct =
            gap !== null && forecast !== null && forecast !== 0
                ? Number((gap / Math.abs(forecast)).toFixed(4))
                : null;

        output[row.indicator] = {
            period: row.period,
            previous: row.previous === null ? null : Number(row.previous),
            forecast,
            actual,
            gap,
            gapPct,
            basis: forecast === null ? 'previous_only' : 'forecast',
            importance: row.importance,
            asOf: new Date(row.as_of).toISOString(),
        };
    }
    return output;
}
