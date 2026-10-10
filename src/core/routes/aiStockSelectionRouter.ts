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
const PROMPT_VERSION = 'ai-stock-selection.v1';

type RankKey = 'trendRank' | 'institutionRank' | 'netProfitForecastRank' | 'epsForecastRank' | 'netProfitGrowthRank' | 'epsGrowthRank';
type SourceRanks = Record<RankKey, number | null>;

interface Candidate {
    symbol: string;
    name: string;
    industry: string;
    sourceRanks: SourceRanks;
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
}

interface SelectionOutput { summary: string; stocks: SelectionItem[]; }

let schemaPromise: Promise<void> | null = null;
let activeRunId: number | null = null;

const numberOrNull = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const newRanks = (): SourceRanks => ({ trendRank: null, institutionRank: null, netProfitForecastRank: null, epsForecastRank: null, netProfitGrowthRank: null, epsGrowthRank: null });

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
    return Object.values(candidate.sourceRanks).reduce<number>((sum, rank) => sum + (rank ? TOP_PER_SOURCE + 1 - rank : 0), 0);
}

async function loadCandidates(): Promise<Candidate[]> {
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
    const [trends, institutionRows, netProfit, eps, netGrowth, epsGrowth] = await Promise.all([
        pool.query(`
            SELECT t.symbol, COALESCE(s.name, '') AS name, COALESCE(s.industry, '') AS industry,
              t.score, t.label, t.score_date
            FROM trend_scores t LEFT JOIN stocks s ON s.symbol = t.symbol
            WHERE t.score_date = (SELECT MAX(score_date) FROM trend_scores)
              AND t.label <> 'D' AND (t.ma60_excluded IS NULL OR t.ma60_excluded = false)
            ORDER BY t.score DESC, t.symbol ASC LIMIT $1`, [TOP_PER_SOURCE]),
        pool.query(`
            SELECT DISTINCT ON (h.symbol) h.symbol, h.stock_name AS name, COALESCE(s.industry, '') AS industry,
              h.resonance_score, h.resonance_level, h.resonance_count, h.detected_at,
              h.sector_info, h.keywords, h.news_count, h.feishu_count
            FROM institution_research_history h LEFT JOIN stocks s ON s.symbol = h.symbol
            WHERE h.resonance_count >= 2 AND h.detected_at >= NOW() - INTERVAL '3 days'
            ORDER BY h.symbol, h.detected_at DESC, h.resonance_score DESC`),
        pool.query(`${latestForecast} WHERE forecast_netprofit IS NOT NULL ORDER BY forecast_netprofit DESC NULLS LAST, symbol ASC LIMIT $1`, [TOP_PER_SOURCE]),
        pool.query(`${latestForecast} WHERE forecast_eps IS NOT NULL ORDER BY forecast_eps DESC NULLS LAST, symbol ASC LIMIT $1`, [TOP_PER_SOURCE]),
        pool.query(`${latestForecast} WHERE forecast_netprofit_yoy IS NOT NULL ORDER BY forecast_netprofit_yoy DESC NULLS LAST, symbol ASC LIMIT $1`, [TOP_PER_SOURCE]),
        pool.query(`${latestForecast} WHERE forecast_eps_yoy IS NOT NULL ORDER BY forecast_eps_yoy DESC NULLS LAST, symbol ASC LIMIT $1`, [TOP_PER_SOURCE]),
    ]);

    trends.rows.forEach((row: Record<string, unknown>, index: number) => {
        const candidate = ensureCandidate(candidates, row); if (!candidate) return;
        setRank(candidate, 'trendRank', index + 1);
        candidate.trend = { score: numberOrNull(row.score), label: text(row.label) || null, scoreDate: text(row.score_date) || null };
    });
    const hotTop = [...institutionRows.rows].sort((a, b) => Number(b.resonance_score || 0) - Number(a.resonance_score || 0)
        || String(b.detected_at).localeCompare(String(a.detected_at))).slice(0, TOP_PER_SOURCE);
    hotTop.forEach((row: Record<string, unknown>, index: number) => {
        const candidate = ensureCandidate(candidates, row); if (!candidate) return;
        setRank(candidate, 'institutionRank', index + 1);
        candidate.institution = {
            resonanceScore: numberOrNull(row.resonance_score), resonanceLevel: text(row.resonance_level) || null,
            resonanceCount: numberOrNull(row.resonance_count), detectedAt: text(row.detected_at) || null,
            themes: [text(row.sector_info), ...text(row.keywords).split(/[、,，|]/)].filter(Boolean).slice(0, 5),
            newsCount: numberOrNull(row.news_count), feishuCount: numberOrNull(row.feishu_count),
        };
    });
    const addForecast = (rows: Array<Record<string, unknown>>, key: RankKey) => rows.forEach((row, index) => {
        const candidate = ensureCandidate(candidates, row); if (!candidate) return;
        setRank(candidate, key, index + 1);
        candidate.forecast = {
            netProfitForecast: numberOrNull(row.forecast_netprofit), epsForecast: numberOrNull(row.forecast_eps),
            netProfitGrowthPct: numberOrNull(row.forecast_netprofit_yoy), epsGrowthPct: numberOrNull(row.forecast_eps_yoy),
            updatedAt: text(row.update_time) || null, summary: text(row.summary),
        };
    });
    addForecast(netProfit.rows, 'netProfitForecastRank');
    addForecast(eps.rows, 'epsForecastRank');
    addForecast(netGrowth.rows, 'netProfitGrowthRank');
    addForecast(epsGrowth.rows, 'epsGrowthRank');
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

async function enrichCandidates(candidates: Candidate[]): Promise<void> {
    const symbols = candidates.map(candidate => candidate.symbol);
    const [activityQuotes, fundamentalQuotes] = await Promise.all([
        TencentQuoteService.getBatchQuotes(symbols, 'activity').catch(() => []),
        TencentQuoteService.getBatchQuotes(symbols, 'fundamental').catch(() => []),
    ]);
    const activityBySymbol = new Map(activityQuotes.map(row => [String(row['股票代码'] || ''), row]));
    const fundamentalBySymbol = new Map(fundamentalQuotes.map(row => [String(row['股票代码'] || ''), row]));
    let cursor = 0;
    const worker = async () => {
        while (cursor < candidates.length) {
            const candidate = candidates[cursor++];
            const activity = activityBySymbol.get(candidate.symbol) || {};
            const fundamental = fundamentalBySymbol.get(candidate.symbol) || {};
            candidate.market = {
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
                getCapitalFlow(candidate.symbol),
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
            const pct = numberOrNull(candidate.market.changePct);
            candidate.riskFlags = {
                isST: /(^|\*)ST/.test(candidate.name.toUpperCase()),
                isSuspended: !numberOrNull(candidate.market.price),
                isLimitUp: pct !== null && pct >= 9.8,
                isLimitDown: pct !== null && pct <= -9.8,
                hasAbnormalVolatility: pct !== null && Math.abs(pct) >= 8,
            };
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, worker));
}

const SYSTEM_PROMPT = `你是一名严谨、克制的A股多因子选股分析助手。仅能从输入候选池中选择股票，只能引用输入字段，不得虚构数据。
综合趋势评分、机构调研热度、盈利预测、行情、技术面、资金流和近期资讯，选出最多10只股票。
多因子共振优先；ST、停牌、跌停不得推荐；涨停、异常波动或资金流出必须降低排序或提示风险；同一行业最多3只。
每只股票的 reason 必须是“综合判断理由”：优先写盈利预期、趋势位置/均线、资金流、近期事件或行情强弱之间的关系，并尽量引用输入中的数值或事实。
reason 不得出现“进入榜单”“入选榜单”“候选池”“排名第几”“趋势榜/热门榜/预测榜”等候选来源措辞；这些仅用于你内部排序，不能作为展示理由。
禁止使用必涨、稳赚、强烈买入等承诺性表达。字段缺失时只能说明数据不足。
严格只输出JSON：{"summary":"不超过100字，含数据时效和整体风险","stocks":[{"rank":1,"symbol":"6位代码","recommendationLevel":"较高|中等|关注","reason":["事实理由1","事实理由2"],"riskTip":"主要风险"}]}`;

function fallbackReasons(candidate: Candidate): string[] {
    const reasons: string[] = [];
    const forecast = candidate.forecast;
    const technical = candidate.technical;
    const flow = candidate.capitalFlow;
    const market = candidate.market;
    const growth = numberOrNull(forecast.netProfitGrowthPct);
    const epsGrowth = numberOrNull(forecast.epsGrowthPct);
    if (growth !== null && growth > 0) reasons.push(`机构预测净利润同比增长${growth.toFixed(2)}%，盈利预期保持改善`);
    else if (epsGrowth !== null && epsGrowth > 0) reasons.push(`机构预测每股收益同比增长${epsGrowth.toFixed(2)}%，盈利预期向好`);
    const aboveMa20 = technical.aboveMa20;
    const return20 = numberOrNull(technical.return20dPct);
    if (aboveMa20 === true && return20 !== null) reasons.push(`股价位于20日均线之上，近20日上涨${return20.toFixed(2)}%，趋势相对稳定`);
    else if (return20 !== null) reasons.push(`近20日涨跌幅为${return20.toFixed(2)}%，需结合后续趋势确认`);
    const mainRatio = numberOrNull(flow.mainNetRatio);
    if (mainRatio !== null && mainRatio > 0) reasons.push(`主力资金净流入占比${mainRatio.toFixed(2)}%，资金面有所支持`);
    const changePct = numberOrNull(market.changePct);
    if (!reasons.length && changePct !== null) reasons.push(`当日涨跌幅${changePct.toFixed(2)}%，需结合成交与后续市场表现观察`);
    if (!reasons.length) reasons.push('盈利、趋势或资金数据存在缺口，建议结合后续披露信息持续观察');
    return reasons.slice(0, 2);
}

function fallback(candidates: Candidate[]): SelectionOutput {
    const industryCount = new Map<string, number>();
    const stocks: SelectionItem[] = [];
    for (const candidate of candidates) {
        if (candidate.riskFlags.isST || candidate.riskFlags.isSuspended || candidate.riskFlags.isLimitDown) continue;
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

async function selectWithAi(candidates: Candidate[]): Promise<{ output: SelectionOutput; model: string | null }> {
    const baseUrl = (process.env.QWEN_BASE_URL || '').replace(/\/+$/, '');
    const apiKey = process.env.QWEN_API_KEY || ''; const model = process.env.QWEN_MODEL || '';
    if (!baseUrl || !apiKey || !model) return { output: fallback(candidates), model: null };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 90_000);
    try {
        const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
        const response = await sessionFetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, signal: controller.signal,
            body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: `数据截至 ${shanghaiDateTimeStr()}，候选股数 ${candidates.length}。候选池：${JSON.stringify(candidates)}` },
            ] }),
        });
        if (!response.ok) throw new Error(`模型请求失败: ${response.status}`);
        const json: any = await response.json();
        const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? '';
        const parsed = parseModelJson(String(content));
        const candidateBySymbol = new Map(candidates.map(candidate => [candidate.symbol, candidate]));
        const industryCount = new Map<string, number>(); const stocks: SelectionItem[] = [];
        const rawStocks = Array.isArray(parsed?.stocks) ? parsed.stocks : [];
        for (const raw of rawStocks) {
            if (!raw || typeof raw !== 'object') continue;
            const item = raw as Record<string, unknown>;
            const symbol = text(item.symbol ?? item.stockCode ?? item['股票代码']); const candidate = candidateBySymbol.get(symbol);
            if (!candidate || candidate.riskFlags.isST || candidate.riskFlags.isSuspended || candidate.riskFlags.isLimitDown || stocks.some(stock => stock.symbol === symbol)) continue;
            const industry = candidate.industry || '未分类'; if ((industryCount.get(industry) || 0) >= 3) continue;
            industryCount.set(industry, (industryCount.get(industry) || 0) + 1);
            const rawReason = item.reason ?? item.reasons ?? item['推荐理由'];
            const reason = Array.isArray(rawReason) ? rawReason.map(text).filter(Boolean).slice(0, 3)
                : text(rawReason) ? [text(rawReason)] : [];
            stocks.push({
                rank: stocks.length + 1, symbol,
                recommendationLevel: ['较高', '中等', '关注'].includes(text(item.recommendationLevel)) ? text(item.recommendationLevel) : '关注',
                reason: reason.length ? reason : fallbackReasons(candidate),
                riskTip: text(item.riskTip ?? item.risk_tip ?? item['风险提示']) || '以上信息仅供参考，注意市场波动和业绩变化',
            });
            if (stocks.length === RESULT_LIMIT) break;
        }
        if (stocks.length) return { output: { summary: text(parsed?.summary).slice(0, 160) || '综合趋势、机构关注与盈利预测形成的候选结果，仅供信息参考。', stocks }, model };
        const output = fallback(candidates);
        output.summary = '模型输出未通过结构校验，结果按多因子规则生成；数据仅供信息参考，不构成投资建议。';
        return { output, model: null };
    } catch (error) {
        console.warn('[AiStockSelection] 模型调用失败，使用规则降级：', error instanceof Error ? error.message : String(error));
        return { output: fallback(candidates), model: null };
    } finally { clearTimeout(timer); }
}

export async function ensureAiStockSelectionSchema(): Promise<void> {
    if (!schemaPromise) schemaPromise = (async () => {
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
    })();
    await schemaPromise;
}

async function persistRun(runId: number, candidates: Candidate[], output: SelectionOutput, model: string | null): Promise<void> {
    for (const candidate of candidates) {
        await pool.query(
            `INSERT INTO ai_stock_selection_candidates (run_id, symbol, stock_name, industry, source_ranks, candidate_payload)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
            [runId, candidate.symbol, candidate.name, candidate.industry || null, JSON.stringify(candidate.sourceRanks), JSON.stringify(candidate)],
        );
    }
    const candidateBySymbol = new Map(candidates.map(candidate => [candidate.symbol, candidate]));
    for (const stock of output.stocks) {
        const candidate = candidateBySymbol.get(stock.symbol); if (!candidate) continue;
        await pool.query(
            `INSERT INTO ai_stock_selection_results (run_id, rank, symbol, stock_name, industry, recommendation_level, reasons, risk_tip, result_payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb)`,
            [runId, stock.rank, stock.symbol, candidate.name, candidate.industry || null, stock.recommendationLevel,
                JSON.stringify(stock.reason), stock.riskTip, JSON.stringify(stock)],
        );
    }
    await pool.query(
        `UPDATE ai_stock_selection_runs
         SET status = 'ready', candidate_count = $2, data_as_of = NOW(), generated_at = NOW(), summary = $3,
           model = $4, ai_output = $5::jsonb, error_message = NULL WHERE id = $1`,
        [runId, candidates.length, output.summary, model, JSON.stringify(output)],
    );
}

async function executeRun(runId: number): Promise<void> {
    try {
        const candidates = await loadCandidates();
        if (!candidates.length) throw new Error('六个榜单均未返回可用候选股票');
        await enrichCandidates(candidates);
        const { output, model } = await selectWithAi(candidates);
        await persistRun(runId, candidates, output, model);
        console.log(`[AiStockSelection] run=${runId} complete: ${candidates.length} candidates, ${output.stocks.length} selected`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[AiStockSelection] run=${runId} failed: ${message}`);
        await pool.query(`UPDATE ai_stock_selection_runs SET status = 'failed', generated_at = NOW(), error_message = $2 WHERE id = $1`, [runId, message]).catch(() => {});
    } finally { if (activeRunId === runId) activeRunId = null; }
}

export async function triggerAiStockSelection(triggerSource: 'schedule' | 'manual' | 'admin' = 'manual', tradeDate = shanghaiDateStr()): Promise<{ runId: number; status: 'generating' }> {
    await ensureAiStockSelectionSchema();
    if (activeRunId) return { runId: activeRunId, status: 'generating' };
    const result = await pool.query(
        `INSERT INTO ai_stock_selection_runs (trade_date, trigger_source, status, prompt_version)
         VALUES ($1, $2, 'generating', $3) RETURNING id`, [tradeDate, triggerSource, PROMPT_VERSION],
    );
    const runId = Number(result.rows[0]?.id); activeRunId = runId; void executeRun(runId);
    return { runId, status: 'generating' };
}

async function getLatest(date?: string): Promise<Record<string, unknown> | null> {
    await ensureAiStockSelectionSchema();
    const where = date ? 'WHERE trade_date = $1' : '';
    const run = await pool.query(
        `SELECT id, trade_date, status, candidate_count, data_as_of, generated_at, summary, model, prompt_version, error_message
         FROM ai_stock_selection_runs ${where}
         ORDER BY CASE WHEN status = 'ready' THEN 0 WHEN status = 'generating' THEN 1 ELSE 2 END,
           generated_at DESC NULLS LAST, created_at DESC LIMIT 1`, date ? [date] : [],
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
    return {
        runId: Number(row.id), tradeDate: String(row.trade_date), status: row.status,
        candidateCount: Number(row.candidate_count || 0), dataAsOf: row.data_as_of, generatedAt: row.generated_at,
        summary: row.summary, model: row.model, promptVersion: row.prompt_version, errorMessage: row.error_message,
        stocks: stocks.rows.map(item => {
            const market = item.market && typeof item.market === 'object' ? item.market as Record<string, unknown> : {};
            const technical = item.technical && typeof item.technical === 'object' ? item.technical as Record<string, unknown> : {};
            return {
                rank: Number(item.rank), symbol: item.symbol, name: item.stock_name, industry: item.industry,
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
    } catch (error) { createResponse(res, 500, error instanceof Error ? error.message : '读取AI选股结果失败'); }
});

aiStockSelectionRouter.post('/generate', requireInternalTrigger, async (req: Request, res: Response) => {
    const tradeDate = text(req.body?.tradeDate);
    if (tradeDate && !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) { createResponse(res, 400, 'tradeDate 必须为 YYYY-MM-DD'); return; }
    try {
        const result = await triggerAiStockSelection('manual', tradeDate || shanghaiDateStr());
        createResponse(res, 202, 'AI选股任务已启动', result);
    } catch (error) { createResponse(res, 500, error instanceof Error ? error.message : '启动AI选股任务失败'); }
});
