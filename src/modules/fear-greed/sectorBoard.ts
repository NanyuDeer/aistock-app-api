/**
 * 恐贪指数「配置方向」的板块行情数据组装。
 * 主源：东财概念板块 clist（getConceptFlow，实时）；兜底：腾讯板块榜（fetchTencentSectors，仅涨跌幅榜）。
 * 纯函数 + 注入 loaders，便于单元测试；不依赖 PG/Redis。
 */
import { EmSnapshotService } from '../quote/EmSnapshotService';
import { TencentSnapshotService } from '../quote/TencentSnapshotService';
import type { SectorFact } from '../quote/MarketSnapshotService';

export interface FgSectorFact {
    tsCode: string;
    name: string;
    pctChange: number;
    netAmount: number;
    leadStock: string;
}

export interface FgSectorBoardData {
    availability: boolean;
    tradeDate: string; // YYYY-MM-DD
    source: 'eastmoney' | 'tencent' | '';
    sectors: {
        topGainers: FgSectorFact[];
        topInflows: FgSectorFact[];
        topLosers: FgSectorFact[];
        topOutflows: FgSectorFact[];
    };
}

export interface FgSectorLoaders {
    concept: () => Promise<{ gainers: SectorFact[]; losers: SectorFact[]; inflows: SectorFact[]; outflows: SectorFact[]; available: boolean }>;
    tencent: () => Promise<{ gainers: SectorFact[]; losers: SectorFact[]; available: boolean }>;
}

function toFact(f: SectorFact): FgSectorFact {
    return { tsCode: f.ts_code, name: f.name, pctChange: f.pct_change, netAmount: f.net_amount, leadStock: f.lead_stock };
}

function pickTradeDate(facts: SectorFact[]): string {
    const raw = facts.find((f) => f.trade_date && f.trade_date.length === 8);
    if (!raw) {
        const d = new Date();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${m}-${day}`;
    }
    const t = raw.trade_date;
    return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

export const EMPTY_BOARD: FgSectorBoardData = {
    availability: false,
    tradeDate: '',
    source: '',
    sectors: { topGainers: [], topInflows: [], topLosers: [], topOutflows: [] },
};

/** 生产默认 loaders（包住现有快照服务的异常，避免整次组装抛错） */
export const defaultLoaders: FgSectorLoaders = {
    concept: async () => {
        try {
            const r = await EmSnapshotService.getConceptFlow();
            const available = r.availability.state === 'available'
                && (r.gainers.length > 0 || r.inflows.length > 0);
            return { gainers: r.gainers, losers: r.losers, inflows: r.inflows, outflows: r.outflows, available };
        } catch {
            return { gainers: [], losers: [], inflows: [], outflows: [], available: false };
        }
    },
    tencent: async () => {
        try {
            const r = await TencentSnapshotService.fetchTencentSectors();
            const available = r.availability.state === 'available'
                && (r.gainers.length > 0 || r.losers.length > 0);
            return { gainers: r.gainers, losers: r.losers, available };
        } catch {
            return { gainers: [], losers: [], available: false };
        }
    },
};

export async function buildSectorBoardData(loaders: FgSectorLoaders = defaultLoaders): Promise<FgSectorBoardData> {
    const em = await loaders.concept();
    if (em.available) {
        return {
            availability: true,
            tradeDate: pickTradeDate(em.gainers.length ? em.gainers : em.inflows),
            source: 'eastmoney',
            sectors: {
                topGainers: em.gainers.slice(0, 5).map(toFact),
                topInflows: em.inflows.slice(0, 5).map(toFact),
                topLosers: em.losers.slice(0, 5).map(toFact),
                topOutflows: em.outflows.slice(0, 5).map(toFact),
            },
        };
    }

    const ten = await loaders.tencent();
    if (ten.available) {
        return {
            availability: true,
            tradeDate: pickTradeDate(ten.gainers),
            source: 'tencent',
            sectors: {
                topGainers: ten.gainers.slice(0, 5).map(toFact),
                topInflows: [],
                topLosers: ten.losers.slice(0, 5).map(toFact),
                topOutflows: [],
            },
        };
    }

    return { ...EMPTY_BOARD, tradeDate: pickTradeDate([]) };
}
