/**
 * EmSnapshotService — 东方财富实时快照数据源（15:30 收盘后可精确获取 A 股快照字段）。
 *
 * 背景（见 design: 2026-08-20-ths-snapshot-source-swap-design.md）：
 * - 同花顺 funds/ 域名触发 Chameleon 反爬（401），跌停/炸板/连板/资金流无法免逆向获取；
 * - 东方财富 push2ex 涨跌停池 + push2 板块资金流为开放 JSON API，全部免逆向实测可用；
 * - 本服务封装东财接口，作为 quick 快照的主源；腾讯近似值仅作兜底（在 TencentSnapshotService 侧协调）。
 *
 * 设计要点：
 * - 复用 eastmoneyThrottler（限速）+ sessionFetch（keepAlive 连接池）+ EASTMONEY_UT 配置化，
 *   与项目既有 EmTagLeaderService（push2 clist）同源。
 * - 涨跌停/炸板/连板来自 push2ex getTopicZ*Pool；概念/行业资金流来自 push2 clist。
 * - 每个方法宽松失败：返回数据 + availability 标注，由调用方 allSettled 兜底，不因单项缺失阻断快照。
 * - 只聚事实，禁止导入任何 LLM、新闻或 Agent 模块（与 MarketSnapshotService 一致）。
 */

import { eastmoneyThrottler } from '../../shared/utils/throttlers';
import { sessionFetch } from '../../shared/utils/httpAgent';
import { shanghaiDateStr } from '../../shared/utils/shanghaiTime';
import type { SectorFact, QuickDataAvailability } from './MarketSnapshotService';

// 概念/行业板块各取 Top N（领涨/领跌/净流入/净流出），与 full 版 TOP_SECTOR_COUNT 保持一致
const TOP_SECTOR_COUNT = 5;

// 概念板块拉取数量（东财 clist 每页上限足够覆盖前 N 的筛选范围）
const SECTOR_PAGE_SIZE = 60;

// 行业板块拉取数量（全市场主力净额=行业板块净额求和，需尽量覆盖全行业）
const INDUSTRY_PAGE_SIZE = 300;

/** 东财数据请求公共头（与 EmTagLeaderService 一致，模拟浏览器）。 */
const EASTMONEY_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    Accept: '*/*',
    Referer: 'https://quote.eastmoney.com/',
};

/**
 * 东财 UT token 配置化（对齐 EmTagLeaderService 约定）：优先读环境变量 EASTMONEY_UT，
 * 缺失时回退内置默认值并打 warning。此处内置默认值为 POC 实测对 push2ex 涨停池可用的 token
 * （见 tmp_em_alt_poc.mjs）；token 被东财轮换时仅改配置/env，免发版。
 */
const EASTMONEY_UT: string = (() => {
    const fromEnv = process.env.EASTMONEY_UT;
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    console.warn('[EmSnapshot] EASTMONEY_UT 未配置，使用内置默认 UT token（建议配置环境变量以便失效时免改代码刷新）');
    return '7eea3edcaed734bea9cbfc24409ed989';
})();

/** 东财 push2ex 涨跌停/炸板池基址。 */
const PUSH2EX_BASE = 'https://push2ex.eastmoney.com';
/** 东财 push2 板块资金流 clist 接口。 */
const PUSH2_CLIST = 'https://push2.eastmoney.com/api/qt/clist/get';

/** 涨跌停池某一条记录的原始字段（仅声明用到的最小字段，字段名以东财返回为准）。 */
interface EmPoolItem {
    /** 证券代码 */
    c?: string | number;
    /** 证券名称 */
    n?: string;
    /** 连板数（连续涨停天数，仅涨停池含） */
    lbc?: number;
}

/** 涨跌停/炸板/连板池聚合结果。 */
export interface EmLimitPoolsResult {
    up_count: number | null;
    down_count: number | null;
    broken_count: number | null;
    /** 最高连板数（取自涨停池 lbc 最大值）。 */
    highest_board: number | null;
    availability: QuickDataAvailability;
}

/** 东财 clist 板块资金流单条记录。 */
interface EmBoardRow {
    /** 板块代码 */
    f12?: string | number;
    /** 板块名称 */
    f14?: string;
    /** 涨跌幅 % */
    f3?: number | null;
    /** 主力净流入（元） */
    f62?: number | null;
}

/** 概念板块资金流聚合结果（涨跌与净额各自独立排序）。 */
export interface EmConceptFlowResult {
    gainers: SectorFact[];
    losers: SectorFact[];
    inflows: SectorFact[];
    outflows: SectorFact[];
    availability: QuickDataAvailability;
}

/** 行业主力净额聚合结果（全市场主力=行业板块 f62 求和）。 */
export interface EmIndustryMainForceResult {
    large_and_extra_large_net_yuan: number | null;
    availability: QuickDataAvailability;
}

function toFiniteNumber(val: unknown): number | null {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
}

function toBoardSectorFact(row: EmBoardRow, tradeDate: string): SectorFact {
    return {
        ts_code: String(row.f12 ?? ''),
        name: String(row.f14 ?? ''),
        pct_change: toFiniteNumber(row.f3) ?? 0,
        // 东财 clist f62 为净流入（元），与 quick 腾讯路径（元）口径一致。
        net_amount: Math.round(toFiniteNumber(row.f62) ?? 0),
        lead_stock: '',
        company_num: 0,
        trade_date: tradeDate,
    };
}

export class EmSnapshotService {
    /**
     * 拉取 push2ex 涨跌停/炸板/连板池。
     *
     * @param yyyymmdd 交易日 YYYYMMDD（默认上海当前日）。
     * @returns 聚合后的 up/down/broken count 与 highest_board（涨停池 lbc 最大值）。
     *          单个池失败时该字段为 null，availability 标注 partial/unavailable。
     */
    static async getLimitPools(yyyymmdd?: string): Promise<EmLimitPoolsResult> {
        const date = yyyymmdd ?? shanghaiDateStr(new Date()).replace(/-/g, '');
        // 顺序固定（涨停 → 跌停 → 炸板），独立 settled，任一失败不阻断其余（宽松失败）。
        const [upRes, downRes, brokenRes] = await Promise.allSettled([
            EmSnapshotService.fetchPool('getTopicZTPool', 'fbt', date),
            EmSnapshotService.fetchPool('getTopicDTPool', 'zdp', date),
            EmSnapshotService.fetchPool('getTopicZBPool', 'zbc', date),
        ]);

        const up = upRes.status === 'fulfilled' ? upRes.value : null;
        const down = downRes.status === 'fulfilled' ? downRes.value : null;
        const broken = brokenRes.status === 'fulfilled' ? brokenRes.value : null;

        // highest_board = 涨停池所有记录的 lbc 最大值（无封板时长场景为 0/缺失，返回 null）
        let highestBoard: number | null = null;
        if (up) {
            let max = 0;
            for (const item of up) {
                const lbc = toFiniteNumber(item.lbc);
                if (lbc !== null && lbc > max) max = lbc;
            }
            highestBoard = max > 0 ? max : null;
        }

        const states: string[] = [];
        if (upRes.status === 'fulfilled') states.push('up');
        if (downRes.status === 'fulfilled') states.push('down');
        if (brokenRes.status === 'fulfilled') states.push('broken');
        const availability: QuickDataAvailability =
            states.length === 3
                ? { state: 'available' }
                : states.length > 0
                    ? {
                        state: 'partial',
                        available_fields: states,
                        reason: `eastmoney pools partially fetched (missing: ${['up', 'down', 'broken']
                            .filter((s) => !states.includes(s)).join(', ')})`,
                    }
                    : { state: 'unavailable', reason: 'eastmoney push2ex pools all failed' };

        return {
            up_count: up ? up.length : null,
            down_count: down ? down.length : null,
            broken_count: broken ? broken.length : null,
            highest_board: highestBoard,
            availability,
        };
    }

    /**
     * 拉取 push2 概念板块资金流（m:90+t:3），本地按涨跌幅/净额各自独立排序。
     * 概念板块名与 Tushare cnt_ths 存在分类体系差异（约 38% 精确同名），仅供展示层——
     * 若要严格对齐板块名，应优先用行业板块（与 Tushare ind_dc 100% 同名）。
     */
    static async getConceptFlow(): Promise<EmConceptFlowResult> {
        const tradeDate = shanghaiDateStr(new Date()).replace(/-/g, '');
        const rows = await EmSnapshotService.fetchBoardRows('m:90+t:3', SECTOR_PAGE_SIZE, 'f62');
        if (!rows) {
            return {
                gainers: [], losers: [], inflows: [], outflows: [],
                availability: { state: 'unavailable', reason: 'eastmoney concept clist returned no rows' },
            };
        }
        const facts = rows.map((row) => toBoardSectorFact(row, tradeDate));
        const byPctDesc = [...facts].sort((a, b) => b.pct_change - a.pct_change);
        const byPctAsc = [...facts].sort((a, b) => a.pct_change - b.pct_change);
        const byNetDesc = [...facts].sort((a, b) => b.net_amount - a.net_amount);
        const byNetAsc = [...facts].sort((a, b) => a.net_amount - b.net_amount);
        return {
            gainers: byPctDesc.slice(0, TOP_SECTOR_COUNT),
            losers: byPctAsc.slice(0, TOP_SECTOR_COUNT),
            inflows: byNetDesc.slice(0, TOP_SECTOR_COUNT),
            outflows: byNetAsc.slice(0, TOP_SECTOR_COUNT),
            availability: { state: 'available' },
        };
    }

    /**
     * 拉取 push2 行业板块主力净额（m:90+t:2）并求和，作为全市场主力净流入近似（元）。
     * 行业板块与 Tushare ind_dc/BK 100% 同名（POC 实测 50/50），可放心用于对齐。
     */
    static async getIndustryMainForce(): Promise<EmIndustryMainForceResult> {
        // 失败宽松：返回 null + unavailable，由调用方降级到腾讯行业板块求和近似。
        try {
            const rows = await EmSnapshotService.fetchBoardRows('m:90+t:2', INDUSTRY_PAGE_SIZE, 'f62');
            if (!rows || rows.length === 0) {
                return { large_and_extra_large_net_yuan: null, availability: { state: 'unavailable', reason: 'eastmoney industry clist returned no rows' } };
            }
            let totalYuan = 0;
            for (const row of rows) {
                totalYuan += toFiniteNumber(row.f62) ?? 0;
            }
            return {
                large_and_extra_large_net_yuan: Math.round(totalYuan),
                availability: { state: 'available' },
            };
        } catch (e) {
            return {
                large_and_extra_large_net_yuan: null,
                availability: { state: 'unavailable', reason: e instanceof Error ? e.message : 'eastmoney industry clist fetch failed' },
            };
        }
    }

    /** 拉取单个涨跌停/炸板池。pool 为空数组不算失败（当日可能确实为 0）。 */
    private static async fetchPool(
        endpoint: 'getTopicZTPool' | 'getTopicDTPool' | 'getTopicZBPool',
        sortField: 'fbt' | 'zdp' | 'zbc',
        yyyymmdd: string,
    ): Promise<EmPoolItem[]> {
        const url = new URL(`${PUSH2EX_BASE}/${endpoint}`);
        url.searchParams.set('ut', EASTMONEY_UT);
        url.searchParams.set('dpt', 'wz.ztzt');
        url.searchParams.set('Pageindex', '0');
        url.searchParams.set('pagesize', '500');
        // 跌停池默认 fbt 排序无效，需用 zdp（涨跌幅）排序才能拿到数据（POC 实测修正）。
        url.searchParams.set('sort', `${sortField}:asc`);
        url.searchParams.set('date', yyyymmdd);
        // 东财会校验秒级时间戳，缺省会返回空
        url.searchParams.set('_', String(Date.now()));

        await eastmoneyThrottler.throttle();
        const res = await sessionFetch(url.toString(), { headers: EASTMONEY_HEADERS });
        if (!res.ok) throw new Error(`eastmoney ${endpoint} HTTP ${res.status}`);
        const json = (await res.json()) as { data?: { pool?: EmPoolItem[] } };
        const pool = json?.data?.pool;
        if (!Array.isArray(pool)) throw new Error(`eastmoney ${endpoint} returned no pool`);
        return pool;
    }

    /** 拉取 push2 板块 clist 行。失败返回 null（宽松失败，由调用方判定 availability）。 */
    private static async fetchBoardRows(
        fs: string,
        pageSize: number,
        fid: string,
    ): Promise<EmBoardRow[] | null> {
        try {
            const url = new URL(PUSH2_CLIST);
            url.searchParams.set('pn', '1');
            url.searchParams.set('pz', String(pageSize));
            url.searchParams.set('po', '1');
            url.searchParams.set('np', '1');
            url.searchParams.set('fltt', '2');
            url.searchParams.set('invt', '2');
            url.searchParams.set('fid', fid);
            url.searchParams.set('fs', fs);
            url.searchParams.set('fields', 'f12,f14,f3,f62');
            url.searchParams.set('ut', EASTMONEY_UT);

            await eastmoneyThrottler.throttle();
            const res = await sessionFetch(url.toString(), { headers: EASTMONEY_HEADERS });
            if (!res.ok) throw new Error(`eastmoney clist HTTP ${res.status}`);
            const json = (await res.json()) as { data?: { diff?: EmBoardRow[] } };
            const diff = json?.data?.diff;
            if (!Array.isArray(diff)) return null;
            return diff;
        } catch (e) {
            console.warn('[EmSnapshot] 东财板块 clist 获取失败:', e instanceof Error ? e.message : String(e));
            return null;
        }
    }
}