import { Bar, Batch, Candidate, Evidence, HISTORY_DAYS, Method, METHODS, METHOD_NAMES, MethodStats, SelectionResultItem, Stock } from './types';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (a: number, b: number) => (a / b - 1) * 100;
const round = (n: number) => Math.round(n * 10000) / 10000;
const clamp = (n: number, low = 0, high = 100) => Math.max(low, Math.min(high, n));
const ma = (bars: Bar[], end: number, n: number) => mean(bars.slice(end - n + 1, end + 1).map(b => b.close));
function drawdown(bars: Bar[]): number {
    let peak = bars[0].close, worst = 0;
    for (const b of bars) { peak = Math.max(peak, b.close); worst = Math.max(worst, (1 - b.close / peak) * 100); }
    return worst;
}

/** Adjust only with factors available through the signal date. Never fall back to unadjusted prices. */
export function adjustBars(raw: Bar[], dates: string[]): Bar[] | null {
    const byDate = new Map(raw.map(b => [b.date, b]));
    if (raw.length !== byDate.size) return null;
    const ordered = dates.map(d => byDate.get(d));
    if (ordered.some(b => !b || ![b.open, b.high, b.low, b.close, b.volume, b.amount, b.factor, b.changePct].every(Number.isFinite)
        || Math.min(b.open, b.high, b.low, b.close, b.factor) <= 0 || b.volume <= 0 || b.amount <= 0
        || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close))) return null;
    const bars = ordered as Bar[];
    const anchor = bars[bars.length - 1].factor;
    return bars.map(b => ({ ...b,
        open: b.open * b.factor / anchor, high: b.high * b.factor / anchor,
        low: b.low * b.factor / anchor, close: b.close * b.factor / anchor,
        volume: b.volume * anchor / b.factor,
    }));
}

export function evaluateMarket(stocks: Stock[], raw: Map<string, Bar[]>, dates: string[], benchmark: Bar[]): Batch {
    if (dates.length !== HISTORY_DAYS || new Set(dates).size !== dates.length || dates.some((d, i) => i > 0 && d <= dates[i - 1])) throw new Error('交易日窗口必须为90个连续且升序的交易日');
    const indexByDate = new Map(benchmark.map(b => [b.date, b.close]));
    const index = dates.map(d => indexByDate.get(d));
    if (index.some(v => v === undefined || !Number.isFinite(v) || v <= 0)) throw new Error('基准指数历史不完整');
    const end = dates.length - 1;
    const index20 = pct(index[end]!, index[end - 20]!);
    const index60 = pct(index[end]!, index[end - 60]!);
    const prepared = new Map<string, Bar[]>();
    const stats = Object.fromEntries(METHODS.map(m => [m, { pass: 0, fail: 0, unavailable: 0, notApplicable: 0 }])) as Record<Method, MethodStats>;
    const applicable = stocks.filter(s => /^\d{6}$/.test(s.symbol) && !/ST|退/i.test(s.name) && s.listDate && s.listDate <= dates[0].replace(/-/g, ''));
    const applicableSymbols = new Set(applicable.map(s => s.symbol));
    for (const stock of applicable) {
        const bars = adjustBars(raw.get(stock.symbol) || [], dates);
        if (bars) prepared.set(stock.symbol, bars);
    }
    // Equal-weight current industry peers; explicitly a cohort comparison, not an industry index.
    const industryReturns = new Map<string, number[]>();
    for (const stock of applicable) {
        const bars = prepared.get(stock.symbol);
        if (bars && stock.industry) {
            const values = industryReturns.get(stock.industry) || [];
            values.push(pct(bars[end].close, bars[end - 20].close));
            industryReturns.set(stock.industry, values);
        }
    }
    let eligibleCount = 0;
    const candidates: Candidate[] = [];
    for (const stock of stocks) {
        const bars = prepared.get(stock.symbol);
        const isApplicable = applicableSymbols.has(stock.symbol);
        if (!isApplicable || !bars) {
            for (const m of METHODS) stats[m][isApplicable ? 'unavailable' : 'notApplicable']++;
            continue;
        }
        const b = bars[end], previous = bars[end - 1];
        const avgAmount20 = mean(bars.slice(-20).map(v => v.amount));
        if (b.amount < 50_000_000 || avgAmount20 < 50_000_000) {
            for (const m of METHODS) stats[m].notApplicable++;
            continue;
        }
        eligibleCount++;
        const ma20 = ma(bars, end, 20), ma60 = ma(bars, end, 60);
        const slope20 = pct(ma20, ma(bars, end - 5, 20)), slope60 = pct(ma60, ma(bars, end - 5, 60));
        const return20 = pct(b.close, bars[end - 20].close), return60 = pct(b.close, bars[end - 60].close);
        const excess20 = return20 - index20, excess60 = return60 - index60;
        const bias20 = pct(b.close, ma20), dd20 = drawdown(bars.slice(-20)), dd60 = drawdown(bars.slice(-60));
        const volumeRatio = b.volume / mean(bars.slice(end - 20, end).map(v => v.volume));
        const priorHigh20 = Math.max(...bars.slice(end - 20, end).map(v => v.high));
        const breakoutPct = pct(b.close, priorHigh20);
        const closeLocation = b.high > b.low ? (b.close - b.low) / (b.high - b.low) : 0;
        const metrics = { ma20, ma60, slope20, slope60, return20, return60, excess20, excess60, bias20, dd20, dd60, volumeRatio, priorHigh20, breakoutPct, avgAmount20 };
        const signals: Evidence[] = [];
        const add = (method: Method, pass: boolean, score: number, reason: string[], invalidation: string, extra = {}) => {
            stats[method][pass ? 'pass' : 'fail']++;
            if (pass) signals.push({ method, score: round(score), rank: 0, reason, invalidation, metrics: Object.fromEntries(Object.entries({ ...metrics, ...extra }).map(([k, v]) => [k, round(v)])) });
        };
        const trend = b.close > ma20 && ma20 > ma60 && slope20 > 0 && slope60 > 0;
        add('volume_breakout', breakoutPct >= 0.5 && breakoutPct <= 8 && volumeRatio >= 1.5 && volumeRatio <= 5 && b.close > ma20 && bias20 <= 15 && closeLocation >= 0.65,
            clamp(40 + volumeRatio * 8 + closeLocation * 15 + breakoutPct * 2 - Math.max(0, bias20 - 8)),
            [`收盘突破此前20个交易日高点${breakoutPct.toFixed(2)}%`, `成交量为此前20日均量的${volumeRatio.toFixed(2)}倍`],
            `收盘跌回突破位${priorHigh20.toFixed(2)}元下方时重新评估`);
        add('trend_following', trend && excess60 > 0 && dd60 <= 18 && bias20 <= 15,
            clamp(50 + excess60 * 0.7 + slope20 * 2 + slope60 * 2 - dd60),
            [`收盘价高于MA20、MA20高于MA60，且两条均线均向上`, `近60日相对沪深300收益${excess60.toFixed(2)}个百分点，最大回撤${dd60.toFixed(2)}%`],
            '收盘跌破MA60或中期均线转弱时重新评估');
        const peers = industryReturns.get(stock.industry) || [];
        if (peers.length < 5) stats.momentum_continuation.unavailable++;
        else {
            const industryExcess20 = return20 - mean(peers);
            const persistence = bars.slice(-10).filter((v, i) => v.close > ma(bars, end - 9 + i, 20)).length;
            add('momentum_continuation', trend && return20 >= 5 && excess20 >= 3 && industryExcess20 >= 0 && persistence >= 8 && dd20 <= 10 && bias20 <= 12 && return20 <= 35,
                clamp(50 + excess20 + industryExcess20 * 0.5 + persistence * 2 - dd20 - Math.max(0, bias20 - 8)),
                [`近20日相对沪深300收益${excess20.toFixed(2)}个百分点、相对同行等权样本${industryExcess20.toFixed(2)}个百分点`, `近10日有${persistence}日收盘高于MA20，当前偏离MA20为${bias20.toFixed(2)}%`],
                '跌破MA20、相对强弱转负或明显过热时重新评估', { industryExcess20, industryPeerCount: peers.length, persistence });
        }
        // The previous 10 sessions must contain a pullback from an earlier peak and a support test.
        const peak = Math.max(...bars.slice(end - 20, end - 5).map(v => v.high));
        const recent = bars.slice(end - 5, end);
        const trough = Math.min(...recent.map(v => v.low));
        const pullbackPct = (1 - trough / peak) * 100;
        const testedSupport = recent.some((v, i) => {
            const support = ma(bars, end - 5 + i, 20);
            return v.low / support >= 0.97 && v.low / support <= 1.02;
        });
        const contraction = mean(recent.map(v => v.volume)) / mean(bars.slice(end - 20, end - 5).map(v => v.volume));
        const confirmation = b.close > previous.high && b.close > b.open && b.volume >= previous.volume;
        add('pullback_stabilization', trend && pullbackPct >= 3 && pullbackPct <= 12 && testedSupport && contraction <= 0.9 && confirmation && bias20 <= 8,
            clamp(60 + (1 - contraction) * 20 + closeLocation * 10 + excess20 * 0.5 - Math.abs(pullbackPct - 6)),
            [`前期上涨后回撤${pullbackPct.toFixed(2)}%，回踩期间触及MA20附近且缩量`, `今日收盘突破昨日高点，阳线且成交量不低于昨日`],
            `收盘跌破本轮回踩低点${trough.toFixed(2)}元时重新评估`, { pullbackPct, contraction, supportLow: trough });
        if (signals.length) candidates.push({ ...stock, price: b.close, changePct: b.changePct, sparkline: bars.slice(-20).map(v => round(v.close)), signals });
    }
    for (const method of METHODS) {
        const matched = candidates.filter(c => c.signals.some(s => s.method === method)).sort((a, b) => b.signals.find(s => s.method === method)!.score - a.signals.find(s => s.method === method)!.score || a.symbol.localeCompare(b.symbol));
        matched.forEach((c, i) => { c.signals.find(s => s.method === method)!.rank = i + 1; });
    }
    return { stocks: candidates, universeCount: stocks.length, eligibleCount, methodStats: stats };
}

/** Fixed rank mapping: rank 1 = 100; fusion uses only the two strongest selected signals. */
export function combine(stocks: Candidate[], methods: Method[], limit: number): SelectionResultItem[] {
    const selected = [...new Set(methods)];
    const rows: SelectionResultItem[] = [];
    for (const stock of stocks) {
        const signals = stock.signals.filter(s => selected.includes(s.method)).sort((a, b) => a.rank - b.rank || a.method.localeCompare(b.method));
        if (!signals.length) continue;
        const points = signals.map(s => 2100 / (20 + s.rank));
        const score = points[0] + (points[1] || 0) * 0.1;
        rows.push({ ...stock, signals, rank: 0, compositeScore: round(score),
            matchedMethods: signals.map(s => s.method), matchedTags: signals.map(s => METHOD_NAMES[s.method]),
            recommendationLevel: '关注', reason: signals.flatMap(s => s.reason.map(r => `${METHOD_NAMES[s.method]}：${r}`)),
            riskTip: `盘后确认观察名单，不代表可按收盘价成交。${signals.map(s => s.invalidation).join('；')}`,
        });
    }
    return rows.sort((a, b) => b.compositeScore - a.compositeScore || a.symbol.localeCompare(b.symbol)).slice(0, limit).map((s, i) => ({ ...s, rank: i + 1 }));
}
