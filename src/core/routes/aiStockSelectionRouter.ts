import { SelectionSession } from '../../modules/stock-selection/SelectionSession';
import type { PoolClient } from 'pg';
import { aiRiskFlags, aiEligible, boundedAiPrompt, validateAiItem } from '../../modules/stock-selection/AiSelectionValidation';
import { SelectionCache, selectionProgress } from '../../modules/stock-selection/SelectionSupport';
import { selectionPriceLimits, selectionSuspensions } from '../../modules/quote/SelectionMarketData';
import { previousQuoteTradeDate, nextQuoteTradeDate } from './stockSelectionRouter';
import { METHOD_HORIZONS } from '../../modules/stock-selection/types';
import { PostgresSelectionStore } from '../../modules/stock-selection/SelectionStore';
import { NextFunction, Request, Response, Router } from 'express';
import pool from '../db';
import { createResponse } from '../../shared/utils/response';
import { shanghaiDateStr, shanghaiDateTimeStr } from '../../shared/utils/shanghaiTime';
import { sessionFetch } from '../../shared/utils/httpAgent';
import { TencentQuoteService } from '../../modules/quote/TencentQuoteService';
import { TushareKlineService } from '../../modules/quote/TushareKlineService';
import { getCapitalFlow, type CapitalFlowResult } from '../../modules/quote/TushareCapitalFlowService';
import { ClsStockNewsService } from '../../modules/monitor/ClsStockNewsService';

const TOP_PER_SOURCE = 10;
const RESULT_LIMIT = 10;
const PROMPT_VERSION = 'ai-stock-selection.v5';
const SHORT_TERM_WEIGHT = 3;
const MODEL_SHORTLIST_LIMIT = 20;
// 该部署模型上下文为 32768 token。候选池序列化后必须留出输出空间，超限时接口直接 400。
const PROMPT_CANDIDATE_LIMIT = 35;
const PROMPT_MAX_CHARS = 42_000;
const MODEL_MAX_TOKENS = 2_400;
const MODEL_TIMEOUT_MS = 240_000;
// 预测同比超过该值多为极小基数造成的统计假象，不作为增速排序依据，也不直接喂给模型。
const GROWTH_LIMIT_PCT = 500;
const selectionSnapshots = new PostgresSelectionStore();

type RankKey = 'shortTermRank' | 'trendRank' | 'institutionRank' | 'netProfitForecastRank' | 'epsForecastRank' | 'netProfitGrowthRank' | 'epsGrowthRank';
type SourceRanks = Record<RankKey, number | null>;

interface Candidate {
    symbol: string;
    name: string;
    industry: string;
    sourceRanks: SourceRanks;
    shortTerm?: { tradeDate: string; signals: Array<{ rank: number; reason: string[] }> };
    trend: Record<string, unknown>;
    institution: Record<string, unknown>;
    forecast: Record<string, unknown>;
    market: Record<string, unknown>;
    technical: Record<string, unknown>;
    capitalFlow: Record<string, unknown>;
    events: { recentNews: Array<{ date: string; title: string }> };
    riskFlags: Record<string, boolean>;
}

interface SelectionItem {
    rank: number;
    symbol: string;
    recommendationLevel: string;
    reason: string[];
    riskTip: string;
    evidence?: Array<{ field: string; value: number }>;
}

interface SelectionOutput { summary: string; stocks: SelectionItem[]; }

let schemaPromise: Promise<void> | null = null;
let activeRunId: number | null = null;
const performanceCache = new SelectionCache<Awaited<ReturnType<typeof aiEntryPerformance>>>();
export const __aiSelectionDependencies = { execute: executeRun, priceLimits: selectionPriceLimits, suspensions: selectionSuspensions, modelFetch: sessionFetch, capitalFlow: getCapitalFlow };

const numberOrNull = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
function institutionDetectedAt(value: unknown): string | null {
    const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const newRanks = (): SourceRanks => ({ shortTermRank: null, trendRank: null, institutionRank: null, netProfitForecastRank: null, epsForecastRank: null, netProfitGrowthRank: null, epsGrowthRank: null });

const truncate = (value: unknown, max: number): string => {
    const normalized = text(value).replace(/\s+/g, ' ');
    return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
};
const round2 = (value: unknown): number | null => {
    const number = numberOrNull(value);
    return number === null ? null : Math.round(number * 100) / 100;
};
const compactNumber = (value: unknown): number | null => {
    const number = numberOrNull(value);
    return number === null ? null : Math.round(number);
};
const compactText = (value: unknown, max: number): string | undefined => truncate(value, max) || undefined;

/** 只把模型真正需要的字段送进上下文；完整候选仍写入数据库供排查。 */
function compactCandidate(candidate: Candidate): Record<string, unknown> {
    const ranks = Object.fromEntries(Object.entries(candidate.sourceRanks).filter(([, rank]) => rank !== null));
    const trend = candidate.trend;
    const institution = candidate.institution;
    const forecast = candidate.forecast;
    const market = candidate.market;
    const technical = candidate.technical;
    const capitalFlow = candidate.capitalFlow;
    const themes = Array.isArray(institution.themes) ? institution.themes as unknown[] : [];
    return {
        symbol: candidate.symbol, name: candidate.name, industry: candidate.industry || undefined,
        ranks,
        shortTerm: candidate.shortTerm ? {
            tradeDate: candidate.shortTerm.tradeDate,
            signals: candidate.shortTerm.signals.slice(0, 1).map(signal => ({
                rank: signal.rank, reason: signal.reason.slice(0, 1).map(reason => truncate(reason, 80)),
            })),
        } : undefined,
        trend: Object.keys(trend).length ? { score: round2(trend.score), label: compactText(trend.label, 4) } : undefined,
        institution: Object.keys(institution).length ? {
            resonanceScore: round2(institution.resonanceScore), resonanceCount: compactNumber(institution.resonanceCount),
            themes: themes.slice(0, 3).map(theme => truncate(theme, 20)),
        } : undefined,
        forecast: Object.keys(forecast).length ? {
            netProfitForecast: round2(forecast.netProfitForecast), epsForecast: round2(forecast.epsForecast),
            netProfitGrowthPct: round2(forecast.netProfitGrowthPct), epsGrowthPct: round2(forecast.epsGrowthPct),
            growthAnomaly: forecast.growthAnomaly === true ? true : undefined,
            summary: compactText(forecast.summary, 60),
        } : undefined,
        market: {
            price: round2(market.price), changePct: round2(market.changePct), turnoverRatePct: round2(market.turnoverRatePct),
            peTtm: round2(market.peTtm), marketCap: compactNumber(market.marketCap), amount: compactNumber(market.amount),
        },
        technical: {
            return5dPct: round2(technical.return5dPct), return20dPct: round2(technical.return20dPct),
            ma20: round2(technical.ma20), ma60: round2(technical.ma60), aboveMa20: technical.aboveMa20 ?? null,
            distanceToHigh20dPct: round2(technical.distanceToHigh20dPct), maxDrawdown20dPct: round2(technical.maxDrawdown20dPct),
        },
        capitalFlow: Object.keys(capitalFlow).length ? {
            mainNetRatio: round2(capitalFlow.mainNetRatio), netInflow5d: round2(capitalFlow.netInflow5d),
            netInflow10d: round2(capitalFlow.netInflow10d), streak: compactNumber(capitalFlow.streak),
            tag: compactText(capitalFlow.tag, 12),
        } : undefined,
        news: candidate.events.recentNews.slice(0, 1).map(item => ({ date: item.date, title: truncate(item.title, 60) })),
        riskFlags: candidate.riskFlags,
    };
}

/**
 * 生成任务只允许定时器/运维系统调用；普通登录用户不可触发，避免重复调用模型与市场数据源。
 * 与项目现有 /api/internal/* 约定一致，token 通过 X-Internal-Token 或 Bearer 传入。
 */
function requireInternalTrigger(req: Request, res: Response, next: NextFunction): void {
    const token = req.headers['x-internal-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const expected = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN;
    if (!expected || token !== expected) {
        createResponse(res, 403, '仅允许内部定时任务或运维触发AI选股生成');
        return;
    }
    next();
}

function ensureCandidate(candidates: Map<string, Candidate>, row: Record<string, unknown>): Candidate | null {
    const symbol = text(row.symbol);
    if (!/^\d{6}$/.test(symbol)) return null;
    const existing = candidates.get(symbol);
    if (existing) return existing;
    const candidate: Candidate = {
        symbol,
        name: text(row.name) || text(row.stock_name) || symbol,
        industry: text(row.industry),
        sourceRanks: newRanks(),
        trend: {}, institution: {}, forecast: {}, market: {}, technical: {}, capitalFlow: {},
        events: { recentNews: [] }, riskFlags: {},
    };
    candidates.set(symbol, candidate);
    return candidate;
}

function setRank(candidate: Candidate, key: RankKey, rank: number): void {
    const previous = candidate.sourceRanks[key];
    candidate.sourceRanks[key] = previous === null ? rank : Math.min(previous, rank);
}

function weight(candidate: Candidate): number {
    return Object.entries(candidate.sourceRanks).reduce((sum, [key, rank]) =>
        sum + (rank ? (TOP_PER_SOURCE + 1 - rank) * (key === 'shortTermRank' ? SHORT_TERM_WEIGHT : 1) : 0), 0);
}

async function addShortTermCandidates(candidates: Map<string, Candidate>, tradeDate: string): Promise<void> {
    const [run] = await selectionSnapshots.previousPublished(tradeDate, 1);
    if (!run || nextQuoteTradeDate(run.tradeDate) !== tradeDate) {
        console.warn(`[AiStockSelection] 上一交易日盘后批次缺失或不可用（最近=${run?.tradeDate ?? '无'}），本次不使用短线信号`);
        return;
    }
    const ranked = run.batch.stocks.flatMap(stock => {
        const signals = stock.signals.filter(signal => {
            const stats = run.batch.methodStats[signal.method];
            return METHOD_HORIZONS[signal.method] === 'short' && stats && stats.unavailable * 4 <= stats.pass + stats.fail;
        }).sort((a, b) => a.rank - b.rank);
        if (!signals.length) return [];
        const points = 2100 / (20 + signals[0].rank) + (signals[1] ? 210 / (20 + signals[1].rank) : 0);
        return [{ stock, signals, points }];
    }).sort((a, b) => b.points - a.points || a.stock.symbol.localeCompare(b.stock.symbol));
    ranked.slice(0, TOP_PER_SOURCE).forEach(({ stock, signals }, index) => {
        const candidate = ensureCandidate(candidates, { ...stock });
        if (!candidate) return;
        setRank(candidate, 'shortTermRank', index + 1);
        candidate.shortTerm = { tradeDate: run.tradeDate, signals: signals.map(({ rank, reason }) => ({ rank, reason })) };
    });
}

export async function loadCandidates(tradeDate: string): Promise<Candidate[]> {
    const candidates = new Map<string, Candidate>();
    const latestForecast = `
        WITH latest AS (
            SELECT DISTINCT ON (symbol) symbol, update_time, summary, forecast_netprofit_yoy,
              forecast_netprofit, forecast_eps, forecast_eps_yoy
            FROM earnings_forecast ORDER BY symbol, update_time DESC
        )
        SELECT l.*, COALESCE(s.name, '') AS name, COALESCE(s.industry, '') AS industry
        FROM latest l LEFT JOIN stocks s ON s.symbol = l.symbol
    `;
    const sources = await Promise.allSettled([
        pool.query(`
            SELECT t.symbol, COALESCE(s.name, '') AS name, COALESCE(s.industry, '') AS industry,
              t.score, t.label, t.score_date
            FROM trend_scores t LEFT JOIN stocks s ON s.symbol = t.symbol
            WHERE t.score_date = (SELECT MAX(score_date) FROM trend_scores)
              AND t.label <> 'D' AND (t.ma60_excluded IS NULL OR t.ma60_excluded = false)
            ORDER BY t.score DESC, t.symbol ASC LIMIT $1`, [TOP_PER_SOURCE]),
        pool.query(`
            SELECT DISTINCT ON (h.symbol) h.symbol, h.stock_name AS name, COALESCE(s.industry, '') AS industry,
              h.resonance_score, h.resonance_level, h.resonance_count, (h.detected_at AT TIME ZONE 'UTC') AS detected_at,
              h.sector_info, h.keywords, h.news_count, h.feishu_count
            FROM institution_research_history h LEFT JOIN stocks s ON s.symbol = h.symbol
            WHERE h.resonance_count >= 2 AND h.detected_at >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '3 days'
            ORDER BY h.symbol, h.detected_at DESC, h.resonance_score DESC`),
        pool.query(`${latestForecast} WHERE forecast_netprofit IS NOT NULL ORDER BY forecast_netprofit DESC NULLS LAST, symbol ASC LIMIT $1`, [TOP_PER_SOURCE]),
        pool.query(`${latestForecast} WHERE forecast_eps IS NOT NULL ORDER BY forecast_eps DESC NULLS LAST, symbol ASC LIMIT $1`, [TOP_PER_SOURCE]),
        pool.query(`${latestForecast} WHERE forecast_netprofit_yoy > 0 AND forecast_netprofit_yoy <= $2 ORDER BY forecast_netprofit_yoy DESC, symbol ASC LIMIT $1`, [TOP_PER_SOURCE, GROWTH_LIMIT_PCT]),
        pool.query(`${latestForecast} WHERE forecast_eps_yoy > 0 AND forecast_eps_yoy <= $2 ORDER BY forecast_eps_yoy DESC, symbol ASC LIMIT $1`, [TOP_PER_SOURCE, GROWTH_LIMIT_PCT]),
    ]);
    const sourceNames = ['trend', 'institution', 'netProfit', 'eps', 'netGrowth', 'epsGrowth'];
    const [trends, institutionRows, netProfit, eps, netGrowth, epsGrowth] = sources.map((source, index) => {
        if (source.status === 'fulfilled') {
            console.info('[AiStockSelection] candidate source', { source: sourceNames[index], status: 'ready', count: source.value.rows.length });
            return source.value;
        }
        console.warn('[AiStockSelection] candidate source', { source: sourceNames[index], status: 'failed', message: source.reason instanceof Error ? source.reason.message : String(source.reason) });
        return { rows: [] };
    });

    trends.rows.forEach((row: Record<string, unknown>, index: number) => {
        const candidate = ensureCandidate(candidates, row); if (!candidate) return;
        setRank(candidate, 'trendRank', index + 1);
        candidate.trend = { score: numberOrNull(row.score), label: text(row.label) || null, scoreDate: text(row.score_date) || null };
    });
    const hotTop = [...institutionRows.rows].sort((a, b) => Number(b.resonance_score || 0) - Number(a.resonance_score || 0)
        || Date.parse(institutionDetectedAt(b.detected_at) ?? '1970-01-01T00:00:00Z')
            - Date.parse(institutionDetectedAt(a.detected_at) ?? '1970-01-01T00:00:00Z')
        || text(a.symbol).localeCompare(text(b.symbol))).slice(0, TOP_PER_SOURCE);
    hotTop.forEach((row: Record<string, unknown>, index: number) => {
        const candidate = ensureCandidate(candidates, row); if (!candidate) return;
        setRank(candidate, 'institutionRank', index + 1);
        candidate.institution = {
            resonanceScore: numberOrNull(row.resonance_score), resonanceLevel: text(row.resonance_level) || null,
            resonanceCount: numberOrNull(row.resonance_count), detectedAt: institutionDetectedAt(row.detected_at),
            themes: [text(row.sector_info), ...text(row.keywords).split(/[、,，|]/)].filter(Boolean).slice(0, 5),
            newsCount: numberOrNull(row.news_count), feishuCount: numberOrNull(row.feishu_count),
        };
    });
    const addForecast = (rows: Array<Record<string, unknown>>, key: RankKey) => rows.forEach((row, index) => {
        const candidate = ensureCandidate(candidates, row); if (!candidate) return;
        setRank(candidate, key, index + 1);
        const netProfitGrowth = numberOrNull(row.forecast_netprofit_yoy);
        const epsGrowthValue = numberOrNull(row.forecast_eps_yoy);
        // 极端同比只在内部保留原值用于排查，不参与排序，也不会原样进入提示词。
        const plausible = (value: number | null): number | null => value !== null && value > GROWTH_LIMIT_PCT ? null : value;
        candidate.forecast = {
            netProfitForecast: numberOrNull(row.forecast_netprofit), epsForecast: numberOrNull(row.forecast_eps),
            netProfitGrowthPct: plausible(netProfitGrowth), epsGrowthPct: plausible(epsGrowthValue),
            netProfitGrowthRawPct: netProfitGrowth, epsGrowthRawPct: epsGrowthValue,
            growthAnomaly: [netProfitGrowth, epsGrowthValue].some(value => value !== null && value > GROWTH_LIMIT_PCT),
            updatedAt: text(row.update_time) || null, summary: text(row.summary),
        };
    });
    addForecast(netProfit.rows, 'netProfitForecastRank');
    addForecast(eps.rows, 'epsForecastRank');
    addForecast(netGrowth.rows, 'netProfitGrowthRank');
    addForecast(epsGrowth.rows, 'epsGrowthRank');
    await addShortTermCandidates(candidates, tradeDate).catch(error => {
        console.warn('[AiStockSelection] 短线名单读取失败:', error instanceof Error ? error.message : String(error));
    });
    return [...candidates.values()].sort((a, b) => weight(b) - weight(a) || a.symbol.localeCompare(b.symbol));
}

function technicalSummary(rows: Array<Record<string, unknown>>): Record<string, unknown> {
    const closes = rows.map(row => numberOrNull(row['收盘价'])).filter((value): value is number => value !== null);
    if (closes.length < 2) return {};
    const latest = closes[closes.length - 1];
    const avg = (days: number): number | null => closes.length < days ? null : Number((closes.slice(-days).reduce((sum, v) => sum + v, 0) / days).toFixed(2));
    const change = (days: number): number | null => closes.length <= days || closes[closes.length - 1 - days] === 0 ? null
        : Number((((latest - closes[closes.length - 1 - days]) / closes[closes.length - 1 - days]) * 100).toFixed(2));
    const ma5 = avg(5); const ma20 = avg(20); const ma60 = avg(60);
    const trailing = closes.slice(-20); const high20 = Math.max(...trailing);
    let high = trailing[0]; let drawdown = 0;
    trailing.forEach(close => { high = Math.max(high, close); drawdown = Math.min(drawdown, high ? ((close - high) / high) * 100 : 0); });
    return {
        return5dPct: change(5), return20dPct: change(20), ma5, ma20, ma60,
        aboveMa5: ma5 === null ? null : latest >= ma5,
        aboveMa20: ma20 === null ? null : latest >= ma20,
        aboveMa60: ma60 === null ? null : latest >= ma60,
        distanceToHigh20dPct: high20 ? Number((((latest - high20) / high20) * 100).toFixed(2)) : null,
        maxDrawdown20dPct: Number(drawdown.toFixed(2)),
        // 页面右侧迷你走势：真实最近 20 个交易日收盘价，不用前端固定 SVG 伪造。
        sparkline: closes.slice(-20),
    };
}

export async function enrichCandidates(candidates: Candidate[], tradeDate: string, progress = selectionProgress('AiStockSelection')): Promise<void> {
    const symbols = candidates.map(candidate => candidate.symbol);
    const [activityQuotes, fundamentalQuotes, limits, suspensions] = await Promise.all([
        TencentQuoteService.getBatchQuotes(symbols, 'activity').catch(() => []),
        TencentQuoteService.getBatchQuotes(symbols, 'fundamental').catch(() => []),
        __aiSelectionDependencies.priceLimits(tradeDate).catch(() => null),
        __aiSelectionDependencies.suspensions(tradeDate, tradeDate).catch(() => null),
    ]);
    const activityBySymbol = new Map(activityQuotes.map(row => [String(row['股票代码'] || ''), row]));
    const fundamentalBySymbol = new Map(fundamentalQuotes.map(row => [String(row['股票代码'] || ''), row]));
    let cursor = 0, completed = 0;
    const worker = async () => {
        while (cursor < candidates.length) {
            const candidate = candidates[cursor++];
            const activity = activityBySymbol.get(candidate.symbol) || {};
            const fundamental = fundamentalBySymbol.get(candidate.symbol) || {};
            candidate.market = {
                open: numberOrNull(activity['今开价']),
                price: numberOrNull(activity['最新价']) ?? numberOrNull(fundamental['最新价']),
                changePct: numberOrNull(activity['涨跌幅']) ?? numberOrNull(fundamental['涨跌幅']),
                turnoverRatePct: numberOrNull(activity['换手率']) ?? numberOrNull(fundamental['换手率']),
                amount: numberOrNull(activity['成交额']), volume: numberOrNull(activity['成交量']),
                amplitudePct: numberOrNull(activity['振幅']) ?? numberOrNull(fundamental['振幅']),
                peTtm: numberOrNull(activity['市盈率']) ?? numberOrNull(fundamental['市盈率']),
                pb: numberOrNull(activity['市净率']) ?? numberOrNull(fundamental['市净率']),
                marketCap: numberOrNull(fundamental['总市值']), floatMarketCap: numberOrNull(fundamental['流通市值']),
                quoteAt: text(activity['行情时间']),
            };
            const [kline, flow, news] = await Promise.allSettled([
                TushareKlineService.getKLine({ symbol: candidate.symbol, klt: 101, fqt: 1, limit: 60 }),
                __aiSelectionDependencies.capitalFlow(candidate.symbol),
                ClsStockNewsService.getStockNews(candidate.symbol, { limit: 3, lastTime: 0 }),
            ]);
            if (kline.status === 'fulfilled') candidate.technical = technicalSummary(kline.value);
            if (flow.status === 'fulfilled') {
                const data: CapitalFlowResult = flow.value;
                candidate.capitalFlow = {
                    tradeDate: data.tradeDate, mainNetInflow: data.mainInflow, mainNetRatio: data.ratio,
                    netInflow5d: data.fiveDay, netInflow10d: data.tenDay, netInflow20d: data.twentyDay,
                    streak: data.streak, tag: data.tag,
                };
            }
            if (news.status === 'fulfilled') candidate.events.recentNews = news.value.items.slice(0, 3).map(item => ({ date: item.time, title: item.title.slice(0, 120) }));
            const rawDate = String(candidate.market.quoteAt || '').match(/^(\d{4})-?(\d{2})-?(\d{2})/);
            const quoteDate = rawDate ? `${rawDate[1]}-${rawDate[2]}-${rawDate[3]}` : null;
            candidate.riskFlags = aiRiskFlags({ name: candidate.name, price: numberOrNull(candidate.market.price),
                quoteDate, tradeDate, suspended: suspensions ? Boolean(suspensions.get(tradeDate)?.has(candidate.symbol)) : null,
                limits: limits?.get(candidate.symbol) });
            candidate.riskFlags.hasAbnormalVolatility = Math.abs(numberOrNull(candidate.market.changePct) ?? 0) >= 8;
            progress('enrich', ++completed, candidates.length);
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, worker));
}

const SYSTEM_PROMPT = `你是一名严谨、克制的A股多因子选股分析助手。仅能从输入候选池中选择股票，只能引用输入字段，不得虚构数据。
短线量价信号是权重最高的单项因子。结合趋势评分、机构调研热度、盈利预测、行情、资金流和近期资讯，给出最值得关注的10只股票（候选不足时可少于10只）。
多因子共振优先；ST、停牌、跌停不得推荐；涨停、异常波动或资金流出必须降低排序或提示风险；同一行业最多3只。
每只股票的 reason 是1至2个对象，每个对象为 {"field":"market.price","analysis":"股价位于MA20上方"}。field 必须对应该股 evidence 中的指标，analysis 是不超过18字的定性分析，不得自由填写数值；MA20、MA60、沪深300等指标名称及观察周期可使用。后端负责生成指标名称、数值和单位，不能把价格说成增速。
每只股票必须提供 evidence，引用该股输入中的1至6个数值指标，格式为 {"field":"technical.ma20","value":12.34}；field 为输入字段路径，value 必须原样引用。可引用字段为 market.price/changePct/turnoverRatePct/peTtm、technical.ma20/ma60/return5dPct/return20dPct/distanceToHigh20dPct/maxDrawdown20dPct、forecast.epsForecast/netProfitGrowthPct/epsGrowthPct、trend.score、institution.resonanceCount、capitalFlow.mainNetRatio。不得引用其他字段或换算单位。
reason 最多2条，渲染后每条不超过40个字；riskTip 不超过30个字；summary 不超过80个字。
reason 不得出现“进入榜单”“入选榜单”“候选池”“排名第几”“趋势榜/热门榜/预测榜”等候选来源措辞；这些仅用于你内部排序，不能作为展示理由。
禁止使用必涨、稳赚、强烈买入等承诺性表达。字段缺失时只能说明数据不足。
输入行情是生成时点的实时快照，当日涨跌幅不是收盘信号；若候选未提供 shortTerm 信号，不得假设存在短线确认。
严格只输出JSON，不要输出JSON以外的任何内容：{"summary":"不超过80字，含数据时效和整体风险","stocks":[{"rank":1,"symbol":"6位代码","recommendationLevel":"较高|中等|关注","reason":[{"field":"technical.ma20","analysis":"均线位置提供趋势参考"}],"riskTip":"主要风险","evidence":[{"field":"technical.ma20","value":12.34}]}]}`;

function fallbackReasons(candidate: Candidate): string[] {
    const reasons: string[] = candidate.shortTerm?.signals[0]?.reason.slice(0, 1) || [];
    const forecast = candidate.forecast;
    const technical = candidate.technical;
    const flow = candidate.capitalFlow;
    const market = candidate.market;
    const growth = numberOrNull(forecast.netProfitGrowthPct);
    const epsGrowth = numberOrNull(forecast.epsGrowthPct);
    if (growth !== null && growth > 0) reasons.push(`机构预测净利润同比增长${growth.toFixed(2)}%，盈利预期保持改善`);
    else if (epsGrowth !== null && epsGrowth > 0) reasons.push(`机构预测每股收益同比增长${epsGrowth.toFixed(2)}%，盈利预期向好`);
    else if (forecast.growthAnomaly === true) reasons.push('机构预测同比基数异常，暂不按增速排序');
    const aboveMa20 = technical.aboveMa20;
    const return20 = numberOrNull(technical.return20dPct);
    if (aboveMa20 === true && return20 !== null) reasons.push(`股价位于20日均线之上，近20日上涨${return20.toFixed(2)}%，趋势相对稳定`);
    else if (return20 !== null) reasons.push(`近20日涨跌幅为${return20.toFixed(2)}%，需结合后续趋势确认`);
    const mainRatio = numberOrNull(flow.mainNetRatio);
    if (mainRatio !== null && mainRatio > 0) reasons.push(`主力资金净流入占比${mainRatio.toFixed(2)}%，资金面有所支持`);
    const changePct = numberOrNull(market.changePct);
    if (!reasons.length && changePct !== null) reasons.push(`当日涨跌幅${changePct.toFixed(2)}%，需结合成交与后续市场表现观察`);
    if (!reasons.length) reasons.push('盈利、趋势或资金数据存在缺口，建议结合后续披露信息持续观察');
    return reasons.slice(0, 2).map(reason => truncate(reason, 39));
}

function fallback(candidates: Candidate[]): SelectionOutput {
    const industryCount = new Map<string, number>();
    const stocks: SelectionItem[] = [];
    for (const candidate of candidates) {
        if (!aiEligible(candidate.riskFlags)) continue;
        const industry = candidate.industry || '未分类';
        if ((industryCount.get(industry) || 0) >= 3) continue;
        industryCount.set(industry, (industryCount.get(industry) || 0) + 1);
        const reasons: string[] = [];
        reasons.push(...fallbackReasons(candidate));
        stocks.push({
            rank: stocks.length + 1, symbol: candidate.symbol, recommendationLevel: stocks.length < 3 ? '较高' : '关注', reason: reasons.slice(0, 3),
            riskTip: candidate.riskFlags.isLimitUp || candidate.riskFlags.hasAbnormalVolatility ? '当日波动较大，注意短线追高风险' : '以上为数据筛选结果，注意市场和业绩变化',
        });
        if (stocks.length === RESULT_LIMIT) break;
    }
    return { summary: '模型服务不可用，结果按多因子共振规则生成；数据仅供信息参考，不构成投资建议。', stocks };
}

function parseModelJson(raw: string): Record<string, unknown> | null {
    const normalized = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    const start = normalized.indexOf('{'); const end = normalized.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { const value = JSON.parse(normalized.slice(start, end + 1)); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}

export async function selectWithAi(candidates: Candidate[]): Promise<{ output: SelectionOutput; model: string | null }> {
    const baseUrl = (process.env.QWEN_BASE_URL || '').replace(/\/+$/, '');
    const apiKey = process.env.QWEN_API_KEY || ''; const model = process.env.QWEN_MODEL || '';
    if (!baseUrl || !apiKey || !model) {
        console.warn('[AiStockSelection] 模型配置缺失，使用规则降级');
        return { output: fallback(candidates), model: null };
    }
    const startedAt = Date.now();
    // 只发送压缩后的必要字段，并按字符预算截断，避免超过模型 32768 token 的上下文上限。
    let prepared: ReturnType<typeof boundedAiPrompt>;
    try { prepared = boundedAiPrompt(SYSTEM_PROMPT, shanghaiDateTimeStr(), candidates.filter(c => aiEligible(c.riskFlags)).map(compactCandidate), PROMPT_MAX_CHARS, PROMPT_CANDIDATE_LIMIT); }
    catch (error) {
        console.warn('[AiStockSelection] 请求预算校验失败:', error instanceof Error ? error.message : String(error));
        return { output: fallback(candidates), model: null };
    }
    const { candidates: modelCandidates, userPrompt, promptChars } = prepared;
    console.info('[AiStockSelection] 模型请求准备', { candidates: candidates.length, sent: modelCandidates.length, promptChars });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    try {
        const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
        const response = await __aiSelectionDependencies.modelFetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, signal: controller.signal,
            body: JSON.stringify({ model, temperature: 0.2, max_tokens: MODEL_MAX_TOKENS,
                chat_template_kwargs: { enable_thinking: false },
                response_format: { type: 'json_object' }, messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userPrompt },
            ] }),
        });
        if (!response.ok) {
            const failure = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
            const detail = typeof failure?.error?.message === 'string' ? failure.error.message.slice(0, 1000) : '';
            throw new Error(`模型请求失败: HTTP ${response.status}${detail ? `，${detail}` : ''}`);
        }
        const json: any = await response.json();
        const finishReason = json?.choices?.[0]?.finish_reason;
        const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? '';
        console.info('[AiStockSelection] 模型响应', {
            model, elapsedMs: Date.now() - startedAt, finishReason,
            contentLength: typeof content === 'string' ? content.length : 0,
            hasReasoning: Boolean(json?.choices?.[0]?.message?.reasoning ?? json?.choices?.[0]?.message?.reasoning_content),
            completionTokens: json?.usage?.completion_tokens,
        });
        // 不把思考过程当最终推荐；被截断的 JSON 即使可以部分解析也不能发布。
        if (finishReason === 'length') throw new Error('模型输出达到 token 上限，未生成完整答案');
        if (typeof content !== 'string' || !content.trim()) throw new Error('模型最终答案为空（可能仅返回思考内容）');
        const parsed = parseModelJson(String(content));
        const candidateBySymbol = new Map(candidates.filter(candidate => modelCandidates.some(input => input.symbol === candidate.symbol)).map(candidate => [candidate.symbol, candidate]));
        const industryCount = new Map<string, number>(); const stocks: SelectionItem[] = [];
        if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim() || [...parsed.summary].length > 80
            || !Array.isArray(parsed.stocks) || !parsed.stocks.length || parsed.stocks.length > RESULT_LIMIT) throw new Error('模型摘要或股票列表格式不合法');
        const rawStocks = parsed.stocks;
        const seen = new Set<string>();
        for (const raw of rawStocks) {
            if (!raw || typeof raw !== 'object' || typeof raw.symbol !== 'string' || seen.has(raw.symbol)) throw new Error('模型返回重复或无效股票');
            const input = modelCandidates.find(input => input.symbol === raw.symbol);
            if (!input) throw new Error('模型返回未发送的候选股票');
            validateAiItem(raw, input);
            seen.add(raw.symbol);
        }
        const shortlist = rawStocks.slice(0, MODEL_SHORTLIST_LIMIT).flatMap((raw: unknown, index: number) => {
            if (!raw || typeof raw !== 'object') return [];
            const item = raw as Record<string, unknown>;
            const candidate = candidateBySymbol.get(text(item.symbol ?? item.stockCode ?? item['股票代码']));
            return candidate ? [{ raw, score: weight(candidate) + (MODEL_SHORTLIST_LIMIT - index) / 2 }] : [];
        }).sort((a, b) => b.score - a.score);
        for (const { raw } of shortlist) {
            if (!raw || typeof raw !== 'object') continue;
            const item = raw as Record<string, unknown>;
            const symbol = text(item.symbol ?? item.stockCode ?? item['股票代码']); const candidate = candidateBySymbol.get(symbol);
            if (!candidate || !aiEligible(candidate.riskFlags) || stocks.some(stock => stock.symbol === symbol)) continue;
            const industry = candidate.industry || '未分类'; if ((industryCount.get(industry) || 0) >= 3) continue;
            industryCount.set(industry, (industryCount.get(industry) || 0) + 1);
            const checked = validateAiItem(item, modelCandidates.find(input => input.symbol === symbol)!);
            stocks.push({ rank: stocks.length + 1, symbol, ...checked });
            if (stocks.length === RESULT_LIMIT) break;
        }
        if (stocks.length) return { output: { summary: text(parsed?.summary).slice(0, 80) || '综合趋势、机构关注与盈利预测形成的候选结果，仅供信息参考。', stocks }, model };
        const output = fallback(candidates);
        console.warn('[AiStockSelection] 模型输出未通过结构或候选股校验');
        output.summary = '模型输出未通过校验，当前为规则筛选结果，仅供信息参考。';
        return { output, model: null };
    } catch (error) {
        const timedOut = controller.signal.aborted;
        console.warn('[AiStockSelection] 模型调用失败，使用规则降级：', {
            elapsedMs: Date.now() - startedAt, timedOut, promptChars, sent: modelCandidates.length,
            message: error instanceof Error ? error.message : String(error),
        });
        const output = fallback(candidates);
        output.summary = timedOut
            ? `模型请求超过${Math.round(MODEL_TIMEOUT_MS / 60_000)}分钟，当前为规则筛选结果，仅供信息参考。`
            : error instanceof Error && /token 上限|最终答案为空/.test(error.message)
                ? `${error.message}，当前为规则筛选结果，仅供信息参考。`
                : '模型请求失败，当前为规则筛选结果，仅供信息参考。';
        return { output, model: null };
    } finally { clearTimeout(timer); }
}

export async function ensureAiStockSelectionSchema(): Promise<void> {
    if (!schemaPromise) {
        const createSchema = async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ai_stock_selection_runs (
                id BIGSERIAL PRIMARY KEY, trade_date DATE NOT NULL, trigger_source VARCHAR(20) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'generating', candidate_count INTEGER NOT NULL DEFAULT 0,
                data_as_of TIMESTAMPTZ, generated_at TIMESTAMPTZ, model TEXT, prompt_version VARCHAR(80) NOT NULL,
                summary TEXT, ai_output JSONB, error_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ai_stock_selection_candidates (
                run_id BIGINT NOT NULL REFERENCES ai_stock_selection_runs(id) ON DELETE CASCADE,
                symbol VARCHAR(20) NOT NULL, stock_name TEXT NOT NULL, industry TEXT, source_ranks JSONB NOT NULL,
                candidate_payload JSONB NOT NULL, PRIMARY KEY (run_id, symbol)
            )`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ai_stock_selection_results (
                run_id BIGINT NOT NULL REFERENCES ai_stock_selection_runs(id) ON DELETE CASCADE,
                rank SMALLINT NOT NULL, symbol VARCHAR(20) NOT NULL, stock_name TEXT NOT NULL, industry TEXT,
                recommendation_level VARCHAR(20) NOT NULL, reasons JSONB NOT NULL, risk_tip TEXT NOT NULL,
                result_payload JSONB NOT NULL, PRIMARY KEY (run_id, rank), UNIQUE (run_id, symbol)
            )`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_stock_selection_runs_latest ON ai_stock_selection_runs(status, trade_date DESC, generated_at DESC)');
        console.log('[DB] ai_stock_selection tables ready');
        };
        schemaPromise = createSchema().catch((error) => {
            schemaPromise = null;
            throw error;
        });
    }
    await schemaPromise;
}

async function persistRun(client: PoolClient, runId: number, candidates: Candidate[], output: SelectionOutput, model: string | null): Promise<void> {
    for (const candidate of candidates) {
        await client.query(
            `INSERT INTO ai_stock_selection_candidates (run_id, symbol, stock_name, industry, source_ranks, candidate_payload)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
            [runId, candidate.symbol, candidate.name, candidate.industry || null, JSON.stringify(candidate.sourceRanks), JSON.stringify(candidate)],
        );
    }
    const candidateBySymbol = new Map(candidates.map(candidate => [candidate.symbol, candidate]));
    for (const stock of output.stocks) {
        const candidate = candidateBySymbol.get(stock.symbol); if (!candidate) continue;
        await client.query(
            `INSERT INTO ai_stock_selection_results (run_id, rank, symbol, stock_name, industry, recommendation_level, reasons, risk_tip, result_payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb)`,
            [runId, stock.rank, stock.symbol, candidate.name, candidate.industry || null, stock.recommendationLevel,
                JSON.stringify(stock.reason), stock.riskTip, JSON.stringify(stock)],
        );
    }
    await client.query(
        `UPDATE ai_stock_selection_runs
         SET status = 'ready', candidate_count = $2, data_as_of = NOW(), generated_at = NOW(), summary = $3,
           model = $4, ai_output = $5::jsonb, error_message = NULL WHERE id = $1`,
        [runId, candidates.length, output.summary, model, JSON.stringify(output)],
    );
}

async function executeRun(runId: number, tradeDate: string, client: PoolClient, session: SelectionSession): Promise<void> {
    const progress = selectionProgress(`AiStockSelection:${runId}`);
    try {
        session.assertUsable();
        progress('candidates');
        const candidates = await loadCandidates(tradeDate);
        if (!candidates.length) throw new Error('各因子均未返回可用候选股票');
        session.assertUsable();
        await enrichCandidates(candidates, tradeDate, progress);
        session.assertUsable();
        if (!candidates.some(candidate => aiEligible(candidate.riskFlags))) throw new Error('候选行情或交易状态不足，无法发布名单');
        progress('model');
        const { output, model } = await selectWithAi(candidates);
        if (!output.stocks.length) throw new Error('没有可发布的有效候选');
        session.assertUsable();
        progress('persist', 0, output.stocks.length);
        await client.query('BEGIN');
        await persistRun(client, runId, candidates, output, model);
        session.assertUsable();
        await client.query('COMMIT');
        performanceCache.clear();
        progress('complete', output.stocks.length, output.stocks.length);
        console.log(`[AiStockSelection] run=${runId} complete: ${candidates.length} candidates, ${output.stocks.length} selected`);
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[AiStockSelection] run=${runId} failed: ${message}`);
        await pool.query(`UPDATE ai_stock_selection_runs SET status = 'failed', generated_at = NOW(), error_message = $2 WHERE id = $1 AND status='generating'`, [runId, message]).catch(() => {});
    } finally { if (activeRunId === runId) activeRunId = null; }
}

export async function triggerAiStockSelection(triggerSource: 'schedule' | 'manual' | 'admin' = 'manual', tradeDate = shanghaiDateStr(), force = false): Promise<{ runId?: number; status: 'generating' | 'ready' }> {
    await ensureAiStockSelectionSchema();
    const client = await pool.connect();
    const session = new SelectionSession(client);
    let locked = false, handedOff = false;
    try {
        locked = Boolean((await client.query('SELECT pg_try_advisory_lock(73140922) AS locked')).rows[0].locked);
        if (!locked) return { runId: activeRunId ?? undefined, status: 'generating' };
        await client.query(`UPDATE ai_stock_selection_runs SET status='failed', generated_at=NOW(),
            error_message=COALESCE(error_message, '生成进程中断，未发布') WHERE status='generating'`);
        if (!force) {
            const existing = await client.query(`SELECT id FROM ai_stock_selection_runs
                WHERE trade_date=$1::date AND prompt_version=$2 AND status='ready' AND model IS NOT NULL
                ORDER BY id DESC LIMIT 1`, [tradeDate, PROMPT_VERSION]);
            session.assertUsable();
            if (existing.rows.length) return { runId: Number(existing.rows[0].id), status: 'ready' };
        }
        const result = await client.query(`INSERT INTO ai_stock_selection_runs (trade_date, trigger_source, status, prompt_version)
            VALUES ($1, $2, 'generating', $3) RETURNING id`, [tradeDate, triggerSource, PROMPT_VERSION]);
        const runId = Number(result.rows[0].id);
        session.assertUsable();
        activeRunId = runId;
        handedOff = true;
        void __aiSelectionDependencies.execute(runId, tradeDate, client, session).catch(error => {
            console.error('[AiStockSelection] execution failed:', error);
        }).finally(async () => {
            if (activeRunId === runId) activeRunId = null;
            await session.release(73140922);
        }).catch(error => console.error('[AiStockSelection] lock cleanup failed:', error));
        return { runId, status: 'generating' };
    } finally {
        if (!handedOff) {
            await session.release(locked ? 73140922 : undefined);
        }
    }
}

export async function aiEntryPerformance(tradeDate: string, symbols: string[], runId: number) {
    const entries = new Map(symbols.map(symbol => [symbol, { date: tradeDate, sessions: 1,
        price: null as number | null, closeReturn: null as number | null, liveBasePrice: null as number | null }]));
    const active = new Set(symbols);
    let before = tradeDate;
    let expected = previousQuoteTradeDate(tradeDate);
    // Read membership only for the displayed symbols, not every candidate payload. Calendar holes stop the streak.
    scan: while (active.size && expected) {
        const history = await pool.query<{ date: string; members: string[] }>(`
            WITH published AS (
                SELECT DISTINCT ON (trade_date) id, trade_date FROM ai_stock_selection_runs
                WHERE trade_date < $1::date AND status='ready'
                ORDER BY trade_date DESC, generated_at DESC NULLS LAST, id DESC LIMIT 20
            ) SELECT p.trade_date::text AS date,
                COALESCE(array_agg(r.symbol) FILTER (WHERE r.symbol IS NOT NULL), ARRAY[]::text[]) AS members
            FROM published p LEFT JOIN ai_stock_selection_results r ON r.run_id=p.id
                AND r.rank <= $3 AND r.symbol=ANY($2::text[])
            GROUP BY p.trade_date ORDER BY p.trade_date DESC`, [before, [...active], RESULT_LIMIT]);
        if (!history.rows.length) break;
        for (const day of history.rows) {
            if (day.date !== expected) break scan;
            const members = new Set(day.members);
            for (const symbol of active) {
                if (!members.has(symbol)) active.delete(symbol);
                else { const entry = entries.get(symbol)!; entry.date = day.date; entry.sessions++; }
            }
            expected = previousQuoteTradeDate(day.date);
            if (!active.size || !expected) break scan;
        }
        before = history.rows[history.rows.length - 1].date;
    }
    const latest = await pool.query<{ date: string }>(`SELECT trade_date::text AS date FROM stock_selection_market_days
        WHERE trade_date <= $1::date ORDER BY trade_date DESC LIMIT 1`, [tradeDate]);
    const closeDate = latest.rows[0]?.date;
    const dates = new Set([...(closeDate ? [closeDate] : []), ...[...entries.values()].map(entry => entry.date)]);
    const snapshots = new Map(await Promise.all([...dates].map(async date => [date, await selectionSnapshots.snapshotBars(date, symbols)] as const)));
    // Today's snapshot may not exist at 09:40. Frozen generation-time opening prices cover that case.
    const openings = await pool.query<{ symbol: string; date: string; open: unknown }>(`
        WITH published AS (
            SELECT DISTINCT ON (trade_date) id, trade_date FROM ai_stock_selection_runs
            WHERE trade_date=ANY($1::date[]) AND status='ready' AND (trade_date<>$3::date OR id=$4)
            ORDER BY trade_date DESC, generated_at DESC NULLS LAST, id DESC
        ) SELECT c.symbol, p.trade_date::text AS date, c.candidate_payload->'market'->>'open' AS open
        FROM published p JOIN ai_stock_selection_candidates c ON c.run_id=p.id
        WHERE c.symbol=ANY($2::text[])`, [[...dates], symbols, tradeDate, runId]);
    for (const [symbol, entry] of entries) {
        const first = snapshots.get(entry.date)?.bars[symbol];
        const last = closeDate ? snapshots.get(closeDate)?.bars[symbol] : null;
        const captured = numberOrNull(openings.rows.find(row => row.symbol === symbol && row.date === entry.date)?.open);
        const opening = first?.open ?? captured;
        if (!opening || opening <= 0 || !Number.isFinite(opening)) continue;
        entry.price = opening;
        if (closeDate && closeDate >= entry.date && first && last && first.factor > 0 && last.factor > 0) {
            entry.closeReturn = (last.close * last.factor / (opening * first.factor) - 1) * 100;
        } else if (entry.date === tradeDate) {
            // Frontend uses today's valid quote directly against today's opening, never yesterday's close.
            entry.liveBasePrice = opening;
        }
    }
    return { entries, quoteDate: closeDate ? nextQuoteTradeDate(closeDate) : tradeDate };
}

async function getLatest(date?: string): Promise<Record<string, unknown> | null> {
    await ensureAiStockSelectionSchema();
    const where = date ? 'WHERE trade_date = $1' : '';
    const run = await pool.query(
        `SELECT id, trade_date::text, status, candidate_count, data_as_of, generated_at, summary, model, prompt_version, error_message
         FROM ai_stock_selection_runs ${where}
         ORDER BY CASE WHEN status = 'ready' THEN 0 WHEN status = 'generating' THEN 1 ELSE 2 END,
           trade_date DESC, generated_at DESC NULLS LAST, id DESC LIMIT 1`, date ? [date] : [],
    );
    const row = run.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const stocks = await pool.query(
        `SELECT r.rank, r.symbol, r.stock_name, r.industry, r.recommendation_level, r.reasons, r.risk_tip,
                c.candidate_payload->'market' AS market, c.candidate_payload->'technical' AS technical
         FROM ai_stock_selection_results r
         LEFT JOIN ai_stock_selection_candidates c ON c.run_id = r.run_id AND c.symbol = r.symbol
         WHERE r.run_id = $1 ORDER BY r.rank ASC`, [row.id],
    );
    const performance = row.status === 'ready' && stocks.rows.length
        ? await (async () => {
            const key = String(row.id);
            return performanceCache.get(key) ?? performanceCache.set(key, await aiEntryPerformance(String(row.trade_date), stocks.rows.map(stock => stock.symbol), Number(row.id)));
        })().catch(error => {
            console.warn('[AiStockSelection] 入选表现读取失败:', error instanceof Error ? error.message : String(error));
            return null;
        })
        : null;
    return {
        runId: Number(row.id), tradeDate: String(row.trade_date), status: row.status,
        nextQuoteTradeDate: performance?.quoteDate ?? null,
        candidateCount: Number(row.candidate_count || 0), dataAsOf: row.data_as_of, generatedAt: row.generated_at,
        summary: row.summary, model: row.model, promptVersion: row.prompt_version, errorMessage: row.error_message,
        stocks: stocks.rows.map(item => {
            const market = item.market && typeof item.market === 'object' ? item.market as Record<string, unknown> : {};
            const technical = item.technical && typeof item.technical === 'object' ? item.technical as Record<string, unknown> : {};
            return {
                rank: Number(item.rank), symbol: item.symbol, entry: performance?.entries.get(item.symbol), name: item.stock_name, industry: item.industry,
                recommendationLevel: item.recommendation_level, reason: Array.isArray(item.reasons) ? item.reasons : [], riskTip: item.risk_tip,
                price: numberOrNull(market.price), changePct: numberOrNull(market.changePct),
                sparkline: Array.isArray(technical.sparkline) ? technical.sparkline.map(numberOrNull).filter((value): value is number => value !== null) : [],
            };
        }),
    };
}

export const aiStockSelectionRouter: Router = Router();

aiStockSelectionRouter.get('/latest', async (req: Request, res: Response) => {
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    try {
        const result = await getLatest(date);
        if (!result) { createResponse(res, 404, '暂无AI选股结果，请等待定时任务生成或手动生成'); return; }
        createResponse(res, 200, 'success', result);
    } catch (error) {
        const dbError = error as { code?: string; message?: string };
        if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(String(dbError.code))) {
            createResponse(res, 503, 'AI选股数据暂不可用：数据库连接失败，请检查数据库服务或 SSH 隧道');
            return;
        }
        createResponse(res, 500, error instanceof Error ? error.message : '读取AI选股结果失败');
    }
});

aiStockSelectionRouter.post('/generate', requireInternalTrigger, async (req: Request, res: Response) => {
    const tradeDate = text(req.body?.tradeDate);
    if (tradeDate && !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) { createResponse(res, 400, 'tradeDate 必须为 YYYY-MM-DD'); return; }
    try {
        const result = await triggerAiStockSelection('manual', tradeDate || shanghaiDateStr(), req.body?.force === true);
        createResponse(res, 202, 'AI选股任务已启动', result);
    } catch (error) { createResponse(res, 500, error instanceof Error ? error.message : '启动AI选股任务失败'); }
});
