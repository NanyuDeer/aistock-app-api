/**
 * 归因输入聚合 —— MCRE M1 的批量数据出口。
 *
 * 职责：
 *   给定「交易日 + 标的集 + 窗口」，一次性返回四路检验器所需的全部输入：
 *   价格序列、板块收益、资金流、一致预期，以及各类数据的完整度。
 *
 * 为什么要有这个接口：
 *   Python 侧禁止重复实现 A 股数据获取（见根 AGENTS.md）。四路检验器需要
 *   行情与资金数据，只能由 Node 侧聚合后一次性下发，避免 Python 逐项回调。
 *
 * 关键设计：
 *   - 依赖全部可注入（CausalInputsDeps），单测不打真实网络
 *   - completeness 用布尔标记每类数据是否可用；缺失返回 null 而不是空对象，
 *     否则「没数据」会被投票逻辑误判为「无反应」
 *   - 一致预期按 as_of <= 当日收盘 回溯，避免用到事后修订的数据
 */

import pool from '../../core/db';
import { ForecastVersionStore } from '../monitor/ForecastVersionStore';
import type { ForecastVersionRow } from '../monitor/ForecastVersionStore';
import { TencentKlineService } from '../quote/TencentKlineService';
import type { KLineOptions } from '../quote/TencentKlineService';
import { getSinaMoneyflow } from '../quote/SinaMoneyFlowService';

export type CausalInputKind = 'prices' | 'sector_returns' | 'flows' | 'consensus';

export interface CausalInputsRequest {
    tradeDate: string;
    window?: { pre?: number; post?: number };
    symbols: string[];
    need?: CausalInputKind[];
}

export interface PricePoint {
    date: string;
    close: number;
    /** 相对前一交易日收盘的涨跌幅（%）。窗口首条无前值时返回 null。 */
    pctChg: number | null;
}

export interface CausalInputsResult {
    asOf: string;
    prices: Record<string, PricePoint[]>;
    sectorReturns: Record<string, number> | null;
    flows: Record<string, number | null> | null;
    consensus: Record<string, Record<string, unknown>> | null;
    completeness: Record<CausalInputKind, boolean>;
}

export interface CausalInputsDeps {
    getKLine: (options: KLineOptions) => Promise<Record<string, unknown>[]>;
    getMoneyflow: (symbol: string) => Promise<Record<string, unknown> | null>;
    querySectorReturns: (tradeDate: string) => Promise<Record<string, number>>;
    findConsensusAsOf: (symbol: string, at: string) => Promise<ForecastVersionRow | null>;
}

const ALL_KINDS: CausalInputKind[] = ['prices', 'sector_returns', 'flows', 'consensus'];

export const defaultDeps: CausalInputsDeps = {
    getKLine: (options) => TencentKlineService.getKLine(options),
    getMoneyflow: async (symbol) => {
        const flow = await getSinaMoneyflow(symbol);
        // 展开为普通对象，避免把具体接口类型直接当作 Record 使用
        return flow ? ({ ...flow } as Record<string, unknown>) : null;
    },
    querySectorReturns: async (tradeDate) => {
        const result = await pool.query<{ board_name: string; pct_change: string | number }>(
            `SELECT board_name, pct_change
               FROM board_rotation_daily
              WHERE trading_date = $1::date`,
            [tradeDate],
        );
        const returns: Record<string, number> = {};
        for (const row of result.rows) {
            const value = Number(row.pct_change);
            if (Number.isFinite(value)) returns[row.board_name] = value;
        }
        return returns;
    },
    findConsensusAsOf: (symbol, at) => ForecastVersionStore.findAsOf(symbol, at),
};

function num(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/** 腾讯 K 线返回中文键；抽成函数便于单独替换数据源。 */
function toPricePoints(rows: Record<string, unknown>[]): PricePoint[] {
    const points: PricePoint[] = [];
    for (const row of rows) {
        const date = String(row['时间'] ?? '').slice(0, 10);
        const close = num(row['收盘价']);
        if (!date || close === null) continue;
        points.push({ date, close, pctChg: null });
    }
    points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (let i = 1; i < points.length; i += 1) {
        const prev = points[i - 1].close;
        const current = points[i].close;
        if (prev > 0) {
            points[i].pctChg = Math.round(((current - prev) / prev) * 10000) / 100;
        }
    }
    return points;
}

/** 取 [事件前 pre 个交易日, 事件后 post 个交易日]；找不到基准日时返回空。 */
export function sliceWindow(points: PricePoint[], tradeDate: string, pre: number, post: number): PricePoint[] {
    let base = -1;
    for (let i = points.length - 1; i >= 0; i -= 1) {
        if (points[i].date <= tradeDate) {
            base = i;
            break;
        }
    }
    if (base < 0) return [];
    const start = Math.max(0, base - pre + 1);
    const end = Math.min(points.length - 1, base + post);
    return points.slice(start, end + 1);
}

export async function buildCausalInputs(
    request: CausalInputsRequest,
    deps: CausalInputsDeps = defaultDeps,
): Promise<CausalInputsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.tradeDate)) {
        throw new Error(`invalid tradeDate: ${request.tradeDate}`);
    }
    if (!Array.isArray(request.symbols) || request.symbols.length === 0) {
        throw new Error('symbols must not be empty');
    }

    const pre = request.window?.pre ?? 5;
    const post = request.window?.post ?? 3;
    const need = new Set<CausalInputKind>(request.need ?? ALL_KINDS);
    const asOf = `${request.tradeDate}T15:05:00+08:00`;

    const prices: Record<string, PricePoint[]> = {};
    const flows: Record<string, number | null> = {};
    const consensus: Record<string, Record<string, unknown>> = {};

    for (const symbol of request.symbols) {
        if (need.has('prices')) {
            const rows = await deps.getKLine({
                symbol,
                klt: 101,
                fqt: 1,
                limit: pre + post + 40,
            });
            const windowed = sliceWindow(toPricePoints(rows), request.tradeDate, pre, post);
            if (windowed.length > 0) prices[symbol] = windowed;
        }
        if (need.has('flows')) {
            const flow = await deps.getMoneyflow(symbol);
            const mainNet = flow ? num(flow['main_net'] ?? flow['主力净流入'] ?? null) : null;
            // 只记有效值：写入 null 会让 flows 变成 {symbol: null}，
            // 下游会把「有字段但值为空」和「完全没数据」混为一谈
            if (mainNet !== null) flows[symbol] = mainNet;
        }
        if (need.has('consensus')) {
            const row = await deps.findConsensusAsOf(symbol, asOf);
            if (row) {
                consensus[symbol] = {
                    versionDate: row.version_date,
                    updateTime: row.update_time,
                    netprofitYoy: row.forecast_netprofit_yoy,
                    netprofit: row.forecast_netprofit,
                    eps: row.forecast_eps,
                    epsYoy: row.forecast_eps_yoy,
                };
            }
        }
    }

    let sectorReturns: Record<string, number> | null = null;
    if (need.has('sector_returns')) {
        const result = await deps.querySectorReturns(request.tradeDate);
        sectorReturns = Object.keys(result).length > 0 ? result : null;
    }

    const requestedCount = request.symbols.length;
    const completeness: Record<CausalInputKind, boolean> = {
        prices: Object.keys(prices).length === requestedCount,
        sector_returns: sectorReturns !== null,
        // 资金流对指数通常为空，缺省视为「部分可用」而非失败
        flows: Object.values(flows).some((value) => value !== null),
        consensus: Object.keys(consensus).length > 0,
    };

    return {
        asOf,
        prices,
        sectorReturns,
        flows: Object.keys(flows).length > 0 ? flows : null,
        consensus: Object.keys(consensus).length > 0 ? consensus : null,
        completeness,
    };
}
