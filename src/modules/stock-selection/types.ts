export const METHOD_HORIZONS = {
    volume_breakout: 'short', momentum_continuation: 'short', limit_up_breakout: 'short', event_catalyst: 'short',
    trend_following: 'swing', pullback_stabilization: 'swing', industry_strength: 'swing', earnings_revision: 'swing',
    quality_growth: 'long', garp: 'long', stable_dividend: 'long',
} as const;
export type Method = keyof typeof METHOD_HORIZONS;
export type Horizon = 'short' | 'swing' | 'long';
export const METHODS = Object.keys(METHOD_HORIZONS) as Method[];
export const MARKET_METHODS = METHODS.filter(method => METHOD_HORIZONS[method] !== 'long' && method !== 'earnings_revision' && method !== 'event_catalyst');
export const METHOD_NAMES: Record<Method, string> = {
    volume_breakout: '放量突破', momentum_continuation: '强势延续', limit_up_breakout: '涨停打板', event_catalyst: '事件催化',
    trend_following: '趋势跟随', pullback_stabilization: '回踩企稳', industry_strength: '行业强势', earnings_revision: '盈利预期上修',
    quality_growth: '优质成长', garp: '合理估值成长', stable_dividend: '红利稳健',
};
export const RULE_VERSION = 'after-close.v4';
export const FUSION_VERSION = 'intersection-rank-max-second-0.1.v2';
export const HISTORY_DAYS = 90;
export interface Stock { symbol: string; name: string; industry: string; listDate: string }
/** Raw OHLC in yuan; volume in shares; amount in yuan. Dates are YYYY-MM-DD. */
export interface Bar {
    date: string; open: number; high: number; low: number; close: number;
    volume: number; amount: number; factor: number; changePct: number;
}
export interface MarketDay { date: string; bars: Record<string, Bar>; fetchedAt: string }
export interface Evidence {
    method: Method; score: number; rank: number; reason: string[];
    metrics: Record<string, number>; invalidation: string;
}
export interface Candidate extends Stock {
    price: number; changePct: number; sparkline: number[]; signals: Evidence[];
}
export interface MethodStats { pass: number; fail: number; unavailable: number; notApplicable: number }
export interface Batch {
    stocks: Candidate[]; universeCount: number; eligibleCount: number;
    methodStats: Record<Method, MethodStats>;
    inputs?: {
        provider: string; adjustment: string; benchmark: string; universeFetchedAt: string;
        universe: Stock[]; benchmarkCloses: Array<{ date: string; close: number }>;
        snapshots: Array<{ date: string; fetchedAt: string }>;
    };
}
export interface SelectionResultItem extends Stock {
    rank: number; price: number; changePct: number; sparkline: number[];
    recommendationLevel: string; reason: string[]; riskTip: string;
    compositeScore: number; matchedMethods: Method[]; matchedTags: string[]; signals: Evidence[];
}
