import { Request, Response, NextFunction } from 'express';
import { CacheService } from '../../shared/utils/CacheService';
import { createResponse } from '../../shared/utils/response';
import { getReportRc, type ReportRcRow } from './TushareService';

// 券商研报缓存 12 小时（研报更新频率低）
const RESEARCH_CACHE_KEY_PREFIX = 'research_reports:v1:';
const RESEARCH_TTL_SECONDS = 12 * 60 * 60;
const MAX_REPORTS = 30;

interface ReportItem {
    reportDate: string;
    title: string;
    orgName: string;
    authorName: string;
    rating: string;
    targetPrice: number | null;
    forecastEps: number | null;
    forecastPe: number | null;
    forecastNetProfit: number | null;
    forecastRevenue: number | null;
}

interface RatingCount { rating: string; count: number }

interface ResearchData {
    symbol: string;
    updatedAt: string;
    reports: ReportItem[];
    summary: {
        totalReports: number;
        latestRating: string;
        latestReportDate: string | null;
        ratingDistribution: RatingCount[];
        avgTargetPrice: number | null;
        analystCount: number;
        orgCount: number;
    };
}

function normalizeRating(rating: string): string {
    if (!rating) return '未评级';
    const r = rating.trim();
    // 常见评级归一化
    if (/买入|增持|强烈推荐|推荐|adding|overweight/i.test(r)) return '买入';
    if (/持有|中性|equal[- ]?weight|hold/i.test(r)) return '持有';
    if (/卖出|减持|underweight|sell|reduce/i.test(r)) return '卖出';
    return r;
}

async function buildResearchData(symbol: string): Promise<ResearchData> {
    const startDate = (() => {
        const d = new Date();
        d.setFullYear(d.getFullYear() - 1);
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`;
    })();

    const rows = await getReportRc({ ts_code: `${symbol}.SZ`, start_date: startDate }).catch(() => [] as ReportRcRow[]);
    // 如果 SZ 查不到，尝试 SH
    let finalRows = rows;
    if (rows.length === 0) {
        const shRows = await getReportRc({ ts_code: `${symbol}.SH`, start_date: startDate }).catch(() => [] as ReportRcRow[]);
        finalRows = shRows;
    }

    // 按报告日期降序
    const sorted = [...finalRows].sort((a, b) => (b.report_date || '').localeCompare(a.report_date || ''));
    const recent = sorted.slice(0, MAX_REPORTS);

    const reports: ReportItem[] = recent.map(r => ({
        reportDate: r.report_date || '',
        title: r.report_title || '',
        orgName: r.org_name || '',
        authorName: r.author_name || '',
        rating: normalizeRating(r.rating),
        targetPrice: r.tp ?? null,
        forecastEps: r.eps ?? null,
        forecastPe: r.pe ?? null,
        forecastNetProfit: r.np ?? null,
        forecastRevenue: r.op_rt ?? null,
    }));

    // 评级分布
    const ratingMap = new Map<string, number>();
    for (const r of reports) {
        const norm = r.rating;
        ratingMap.set(norm, (ratingMap.get(norm) || 0) + 1);
    }
    const ratingDistribution: RatingCount[] = Array.from(ratingMap.entries())
        .map(([rating, count]) => ({ rating, count }))
        .sort((a, b) => b.count - a.count);

    // 平均目标价
    const targetPrices = reports.filter(r => r.targetPrice != null && r.targetPrice > 0).map(r => r.targetPrice!);
    const avgTargetPrice = targetPrices.length > 0
        ? Math.round((targetPrices.reduce((a, b) => a + b, 0) / targetPrices.length) * 100) / 100
        : null;

    // 机构数和分析师数
    const orgSet = new Set(reports.map(r => r.orgName).filter(Boolean));
    const analystSet = new Set(reports.map(r => r.authorName).filter(Boolean));

    const latestReport = reports[0];

    return {
        symbol,
        updatedAt: new Date().toISOString(),
        reports,
        summary: {
            totalReports: reports.length,
            latestRating: latestReport?.rating || '未评级',
            latestReportDate: latestReport?.reportDate || null,
            ratingDistribution,
            avgTargetPrice,
            analystCount: analystSet.size,
            orgCount: orgSet.size,
        },
    };
}

export class ResearchReportController {
    static async getReports(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const rawSymbol = req.params.symbol;
        const symbol = Array.isArray(rawSymbol) ? rawSymbol[0] : rawSymbol;
        if (!symbol || !/^\d{6}$/.test(symbol)) {
            createResponse(res, 400, 'Invalid symbol - A股代码必须是6位数字');
            return;
        }

        const cacheKey = `${RESEARCH_CACHE_KEY_PREFIX}${symbol}`;
        try {
            const cached = await CacheService.get<ResearchData>(cacheKey);
            if (cached) {
                createResponse(res, 200, 'success (cached)', cached);
                return;
            }
        } catch {}

        try {
            const data = await buildResearchData(symbol);
            try {
                await CacheService.put(cacheKey, data as unknown as Record<string, unknown>, RESEARCH_TTL_SECONDS);
            } catch {}
            createResponse(res, 200, 'success', data);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : '获取券商研报数据失败';
            console.error(`[ResearchReport] ${symbol} error:`, message);
            createResponse(res, 500, message);
        }
    }
}
