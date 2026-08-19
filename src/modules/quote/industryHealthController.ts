import { Request, Response, NextFunction } from 'express';
import { CacheService } from '../../shared/utils/CacheService';
import { createResponse } from '../../shared/utils/response';
import { resolveBoardName } from './ThsBoardService';
import { getThsDaily, getThsMember, type ThsDailyRow } from './TushareService';

// 行业景气指数缓存 1 小时（交易日盘中数据变化较快）
const INDUSTRY_HEALTH_CACHE_KEY_PREFIX = 'industry_health:v1:';
const INDUSTRY_HEALTH_TTL_SECONDS = 60 * 60;

interface MonthAgg {
    month: string;      // YYYY-MM
    pctChange: number;  // 月涨幅%
    avgTurnover: number; // 月均换手率
}

interface IndustryHealthData {
    industry: string;
    tsCode: string;
    resolvedName: string;
    updatedAt: string;
    score: number;          // 景气指数 0-100
    level: 'high' | 'medium' | 'low';
    months: string[];       // ['2026-02', '2026-03', ...] 最近7个月
    values: number[];       // 对应月份的月涨幅%
    trend: 'up' | 'down' | 'flat';
    details: { label: string; desc: string }[];
    memberCount: number | null;
}

/** 按月聚合板块日K数据，计算月涨幅和均换手率 */
function aggregateByMonth(dailyRows: ThsDailyRow[]): MonthAgg[] {
    const monthMap = new Map<string, { rows: ThsDailyRow[] }>();
    for (const row of dailyRows) {
        const month = `${row.trade_date.substring(0, 4)}-${row.trade_date.substring(4, 6)}`;
        if (!monthMap.has(month)) monthMap.set(month, { rows: [] });
        monthMap.get(month)!.rows.push(row);
    }

    const result: MonthAgg[] = [];
    for (const [month, { rows }] of monthMap) {
        // 按 trade_date 排序
        const sorted = [...rows].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        // 月涨幅 = (月末收盘 - 月前收盘) / 月前收盘 * 100
        // 用 pre_close of first day 作为月初基准更准确
        const base = first.pre_close || first.open;
        const pctChange = base > 0 ? ((last.close - base) / base) * 100 : 0;
        const avgTurnover = sorted.reduce((sum, r) => sum + (r.turnover_rate || 0), 0) / sorted.length;
        result.push({ month, pctChange, avgTurnover });
    }

    return result.sort((a, b) => a.month.localeCompare(b.month));
}

/** 根据近7个月涨幅计算景气指数 0-100 */
function calcHealthScore(monthAggs: MonthAgg[]): number {
    if (monthAggs.length === 0) return 50;
    const recent = monthAggs.slice(-7);
    // 加权：越近权重越高
    const weights = [0.05, 0.08, 0.12, 0.15, 0.18, 0.22, 0.20];
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < recent.length; i++) {
        const w = weights[i] || (1 / recent.length);
        // 涨幅映射到 0-100：0% → 50，+10% → 80，-10% → 20
        const mapped = 50 + Math.max(-50, Math.min(50, recent[i].pctChange * 3));
        weightedSum += mapped * w;
        weightTotal += w;
    }
    return weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 50;
}

function getLevel(score: number): 'high' | 'medium' | 'low' {
    if (score >= 65) return 'high';
    if (score >= 45) return 'medium';
    return 'low';
}

function getTrend(values: number[]): 'up' | 'down' | 'flat' {
    if (values.length < 3) return 'flat';
    const recent3 = values.slice(-3);
    const avg = recent3.reduce((a, b) => a + b, 0) / recent3.length;
    const prev3 = values.slice(-6, -3);
    if (prev3.length === 0) return 'flat';
    const prevAvg = prev3.reduce((a, b) => a + b, 0) / prev3.length;
    const diff = avg - prevAvg;
    if (diff > 2) return 'up';
    if (diff < -2) return 'down';
    return 'flat';
}

async function buildIndustryHealth(industryName: string): Promise<IndustryHealthData | null> {
    // 1. 板块名匹配
    const resolved = await resolveBoardName(industryName);
    if (!resolved) return null;

    // 2. 拉取近 7 个月板块日K（多拉 1 个月用于 pre_close 基准）
    const now = new Date();
    const start = new Date(now);
    start.setMonth(start.getMonth() - 8);
    const startDate = `${start.getFullYear()}${String(start.getMonth() + 1).padStart(2, '0')}01`;
    const endDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    const dailyRows = await getThsDaily(resolved.ts_code, startDate, endDate).catch(() => [] as ThsDailyRow[]);
    if (dailyRows.length === 0) {
        return {
            industry: industryName,
            tsCode: resolved.ts_code,
            resolvedName: resolved.name,
            updatedAt: new Date().toISOString(),
            score: 50,
            level: 'medium',
            months: [],
            values: [],
            trend: 'flat',
            details: [{ label: '板块行情', desc: '暂无日K数据' }],
            memberCount: null,
        };
    }

    // 3. 按月聚合
    const monthAggs = aggregateByMonth(dailyRows);
    const recent7 = monthAggs.slice(-7);

    // 4. 计算景气指数
    const score = calcHealthScore(monthAggs);
    const level = getLevel(score);
    const values = recent7.map(m => Math.round(m.pctChange * 100) / 100);
    const trend = getTrend(values);

    // 5. 成分股数量
    let memberCount: number | null = null;
    try {
        const members = await getThsMember(resolved.ts_code);
        memberCount = members.length;
    } catch {}

    // 6. 详情项
    const upMonths = recent7.filter(m => m.pctChange > 0).length;
    const totalMonths = recent7.length;
    const avgTurnover = recent7.length > 0
        ? recent7.reduce((sum, m) => sum + m.avgTurnover, 0) / recent7.length
        : 0;
    const latestMonth = recent7[recent7.length - 1];
    const details = [
        {
            label: '月度表现',
            desc: `近${totalMonths}个月${upMonths}个月上涨，最新月${latestMonth ? `${latestMonth.pctChange >= 0 ? '+' : ''}${latestMonth.pctChange.toFixed(1)}%` : '--'}`,
        },
        {
            label: '换手活跃度',
            desc: `月均换手率 ${avgTurnover.toFixed(2)}%`,
        },
        {
            label: '板块规模',
            desc: memberCount !== null ? `成分股 ${memberCount} 只` : '成分股数据待补',
        },
    ];

    return {
        industry: industryName,
        tsCode: resolved.ts_code,
        resolvedName: resolved.name,
        updatedAt: new Date().toISOString(),
        score,
        level,
        months: recent7.map(m => m.month),
        values,
        trend,
        details,
        memberCount,
    };
}

export class IndustryHealthController {
    static async getHealth(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const rawName = req.params.name;
        const industryName = Array.isArray(rawName) ? rawName[0] : rawName;
        if (!industryName || industryName.trim().length === 0) {
            createResponse(res, 400, '行业名称不能为空');
            return;
        }

        const cacheKey = `${INDUSTRY_HEALTH_CACHE_KEY_PREFIX}${encodeURIComponent(industryName.trim())}`;
        try {
            const cached = await CacheService.get<IndustryHealthData>(cacheKey);
            if (cached) {
                createResponse(res, 200, 'success (cached)', cached);
                return;
            }
        } catch {}

        try {
            const data = await buildIndustryHealth(industryName.trim());
            if (!data) {
                createResponse(res, 200, '未匹配到同花顺板块', null);
                return;
            }
            try {
                await CacheService.put(cacheKey, data as unknown as Record<string, unknown>, INDUSTRY_HEALTH_TTL_SECONDS);
            } catch {}
            createResponse(res, 200, 'success', data);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : '获取行业景气指数失败';
            console.error(`[IndustryHealth] ${industryName} error:`, message);
            createResponse(res, 500, message);
        }
    }
}
