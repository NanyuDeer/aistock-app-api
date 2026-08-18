import { Request, Response, NextFunction } from 'express';
import { CacheService } from '../../shared/utils/CacheService';
import { createResponse } from '../../shared/utils/response';
import {
    getFinaIndicator,
    getCashflow,
    getHolderNumber,
    getBalanceSheet,
    getSemiAnnualReport,
    type FinaIndicatorRow,
    type CashflowRow,
    type HolderNumberRow,
    type BalanceSheetRow,
} from './TushareService';

// 聚合接口缓存：财报数据更新频率低，缓存 6 小时
const ANNUAL_FINANCIAL_CACHE_KEY_PREFIX = 'annual_financial:v1:';
const ANNUAL_FINANCIAL_TTL_SECONDS = 6 * 60 * 60;

// 仅取最近 2 年数据，避免拉取过多历史
const START_DATE_2Y_AGO = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 2);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
})();

function formatPercent(value: number | null | undefined, digits = 1): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '--';
    return `${value.toFixed(digits)}%`;
}

function formatYoyPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '--';
    const sign = value >= 0 ? '+' : '';
    return `同比${sign}${value.toFixed(1)}%`;
}

function formatMoney(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '--';
    // 转为亿元展示
    if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
    if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
    return value.toFixed(2);
}

interface AnnualItem {
    value: string;
    note: string;
}

interface AnnualFinancialData {
    symbol: string;
    updatedAt: string;
    reportPeriod: string | null;
    annual: {
        rdExpense: AnnualItem;          // 研发投入
        shareholder: AnnualItem;        // 股东结构
        returnOnCapital: AnnualItem;    // 资本回报率
        cashflow: AnnualItem;           // 现金流质量
        eps: AnnualItem;                // 每股收益
        netProfitYoy: AnnualItem;       // 净利同比
    };
    moat: {
        grossMargin: number | null;
        netMargin: number | null;
        roe: number | null;
        roic: number | null;
        contractLiab: number | null;
        debtToAssets: number | null;
    };
    raw: {
        finaIndicator: FinaIndicatorRow | null;
        cashflow: CashflowRow | null;
        holderNumber: HolderNumberRow | null;
        balanceSheet: BalanceSheetRow | null;
    };
}

async function buildAnnualFinancial(symbol: string): Promise<AnnualFinancialData> {
    // 并行拉取多源数据，单个失败不阻断整体
    const [finaIndicatorRows, cashflowRows, holderNumberRows, balanceSheetRows, semiAnnual] = await Promise.all([
        getFinaIndicator(symbol, START_DATE_2Y_AGO).catch(() => [] as FinaIndicatorRow[]),
        getCashflow(symbol, START_DATE_2Y_AGO).catch(() => [] as CashflowRow[]),
        getHolderNumber(symbol, START_DATE_2Y_AGO).catch(() => [] as HolderNumberRow[]),
        getBalanceSheet(symbol, START_DATE_2Y_AGO).catch(() => [] as BalanceSheetRow[]),
        getSemiAnnualReport(symbol).catch(() => null),
    ]);

    // 取最新一期数据（按 end_date 降序）
    const sortByEndDateDesc = <T extends { end_date?: string }>(arr: T[]): T | null =>
        arr.length > 0 ? [...arr].sort((a, b) => (b.end_date || '').localeCompare(a.end_date || ''))[0] : null;

    const fina = sortByEndDateDesc(finaIndicatorRows);
    const cash = sortByEndDateDesc(cashflowRows);
    const holder = sortByEndDateDesc(holderNumberRows);
    const balance = sortByEndDateDesc(balanceSheetRows);

    // 半年报数据（已有同比计算）
    const latestReport = semiAnnual?.reports?.[0] || null;
    const revenueYoy = semiAnnual?.total_revenue_yoy ?? null;
    const netProfitYoy = semiAnnual?.n_income_attr_p_yoy ?? null;

    // 股东户数变化率
    let holderNumChangePct: number | null = null;
    if (holderNumberRows.length >= 2) {
        const sorted = [...holderNumberRows].sort((a, b) => (b.end_date || '').localeCompare(a.end_date || ''));
        const latest = sorted[0].holder_num;
        const prev = sorted[1].holder_num;
        if (prev && prev > 0) {
            holderNumChangePct = ((latest - prev) / prev) * 100;
        }
    }

    // 现金流/净利润比（经营现金流 / 归母净利润）
    let ocfToProfitRatio: number | null = null;
    if (cash?.n_cashflow_act != null && latestReport?.n_income_attr_p && latestReport.n_income_attr_p !== 0) {
        ocfToProfitRatio = (cash.n_cashflow_act / latestReport.n_income_attr_p) * 100;
    }

    const reportPeriod = latestReport?.end_date || fina?.end_date || cash?.end_date || null;

    // 年报对比 6 项
    const rdExpense: AnnualItem = latestReport?.rd_exp != null
        ? { value: formatMoney(latestReport.rd_exp), note: `报告期 ${latestReport.end_date || '--'}` }
        : { value: '--', note: '待接半年报' };

    const shareholder: AnnualItem = holder
        ? {
            value: holderNumChangePct !== null
                ? `股东户数${holderNumChangePct <= 0 ? '减少' : '增加'}${Math.abs(holderNumChangePct).toFixed(1)}%`
                : '户数稳定',
            note: `户数 ${holder.holder_num}（截至 ${holder.end_date || '--'}）`,
        }
        : { value: '--', note: '待接股东户数' };

    const returnOnCapital: AnnualItem = fina
        ? {
            value: fina.roe != null ? `ROE ${formatPercent(fina.roe)}` : '--',
            note: fina.roic != null ? `ROIC ${formatPercent(fina.roic)}` : `报告期 ${fina.end_date || '--'}`,
        }
        : { value: '--', note: '待接ROE' };

    const cashflow: AnnualItem = cash
        ? {
            value: ocfToProfitRatio !== null
                ? (ocfToProfitRatio >= 80 ? '现金流充裕' : ocfToProfitRatio >= 0 ? '现金流为正' : '现金流承压')
                : '待计算',
            note: `经营现金流 ${formatMoney(cash.n_cashflow_act)}（${cash.end_date || '--'}）`,
        }
        : { value: '--', note: '待接现金流' };

    const eps: AnnualItem = latestReport?.basic_eps != null
        ? { value: `${latestReport.basic_eps.toFixed(3)} 元`, note: `报告期 ${latestReport.end_date || '--'}` }
        : { value: '--', note: '待接EPS' };

    const netProfitYoyItem: AnnualItem = netProfitYoy != null
        ? { value: formatYoyPercent(netProfitYoy), note: `归母净利（${latestReport?.end_date || '--'}）` }
        : { value: '--', note: '待接净利同比' };

    return {
        symbol,
        updatedAt: new Date().toISOString(),
        reportPeriod,
        annual: {
            rdExpense,
            shareholder,
            returnOnCapital,
            cashflow,
            eps,
            netProfitYoy: netProfitYoyItem,
        },
        moat: {
            grossMargin: fina?.grossprofit_margin ?? null,
            netMargin: fina?.netprofit_margin ?? null,
            roe: fina?.roe ?? null,
            roic: fina?.roic ?? null,
            contractLiab: balance?.contract_liab ?? null,
            debtToAssets: fina?.debt_to_assets ?? null,
        },
        raw: {
            finaIndicator: fina,
            cashflow: cash,
            holderNumber: holder,
            balanceSheet: balance,
        },
    };
}

export class AnnualFinancialController {
    static async getAnnualFinancial(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const rawSymbol = req.params.symbol;
        const symbol = Array.isArray(rawSymbol) ? rawSymbol[0] : rawSymbol;
        if (!symbol || !/^\d{6}$/.test(symbol)) {
            createResponse(res, 400, 'Invalid symbol - A股代码必须是6位数字');
            return;
        }

        const cacheKey = `${ANNUAL_FINANCIAL_CACHE_KEY_PREFIX}${symbol}`;
        try {
            const cached = await CacheService.get<AnnualFinancialData>(cacheKey);
            if (cached) {
                createResponse(res, 200, 'success (cached)', cached);
                return;
            }
        } catch {}

        try {
            const data = await buildAnnualFinancial(symbol);
            try {
                await CacheService.put(cacheKey, data as unknown as Record<string, unknown>, ANNUAL_FINANCIAL_TTL_SECONDS);
            } catch {}
            createResponse(res, 200, 'success', data);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : '获取年报财务数据失败';
            console.error(`[AnnualFinancial] ${symbol} error:`, message);
            createResponse(res, 500, message);
        }
    }
}
