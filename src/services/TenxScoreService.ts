import * as TushareService from './TushareService';
import { TushareInfoService } from './TushareInfoService';

// ==================== THS增强数据全局缓存 ====================
// 批量评分时，limit_list_ths/ths_hot/moneyflow_ths是全市场接口，
// 只需调用1次即可覆盖所有股票，避免每只股票重复调用

interface ThsEnhanceCache {
    limitListMap: Map<string, TushareService.LimitListThsRow>;
    thsHotMap: Map<string, TushareService.ThsHotRow>;
    moneyflowThsMap: Map<string, TushareService.MoneyflowThsRow>;
    loadedAt: string;  // 加载时的交易日期
}

let _thsCache: ThsEnhanceCache | null = null;
let _thsCacheDate = '';

// kpl_concept_cons缓存（同行业代码共享，避免重复调用）
const _kplConceptCache = new Map<string, TushareService.KplConceptConsRow[]>();

function getThsEnhanceCache(): ThsEnhanceCache {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    if (_thsCache && _thsCacheDate === today) return _thsCache;

    // 首次访问时初始化空缓存，异步加载
    if (!_thsCache) {
        _thsCache = {
            limitListMap: new Map(),
            thsHotMap: new Map(),
            moneyflowThsMap: new Map(),
            loadedAt: '',
        };
    }
    return _thsCache;
}

/** 异步预加载THS增强数据（批量评分开始前调用1次） */
export async function preloadThsEnhanceCache(): Promise<void> {
    const today = new Date();
    const tradeDateStr = today.toISOString().slice(0, 10).replace(/-/g, '');

    if (_thsCache && _thsCacheDate === tradeDateStr && _thsCache.loadedAt === tradeDateStr) {
        console.log('[TenxScore] THS增强缓存已存在，跳过加载');
        return;
    }

    const cache: ThsEnhanceCache = {
        limitListMap: new Map(),
        thsHotMap: new Map(),
        moneyflowThsMap: new Map(),
        loadedAt: tradeDateStr,
    };

    // limit_list_ths：全市场涨停数据（1次调用）
    try {
        let limitRows = await TushareService.getLimitListThs(tradeDateStr);
        if (limitRows.length === 0) {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            limitRows = await TushareService.getLimitListThs(yesterday.toISOString().slice(0, 10).replace(/-/g, ''));
        }
        for (const row of limitRows) {
            cache.limitListMap.set(row.ts_code, row);
        }
        console.log(`[TenxScore] THS缓存: limit_list_ths=${cache.limitListMap.size}只`);
    } catch (e) { console.warn('[TenxScore] limit_list_ths缓存失败:', (e as Error).message); }

    // ths_hot：全市场热度数据（1次调用）
    try {
        let hotRows = await TushareService.getThsHot(tradeDateStr);
        if (hotRows.length === 0) {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            hotRows = await TushareService.getThsHot(yesterday.toISOString().slice(0, 10).replace(/-/g, ''));
        }
        for (const row of hotRows) {
            cache.thsHotMap.set(row.ts_code, row);
        }
        console.log(`[TenxScore] THS缓存: ths_hot=${cache.thsHotMap.size}只`);
    } catch (e) { console.warn('[TenxScore] ths_hot缓存失败:', (e as Error).message); }

    // moneyflow_ths：全市场资金流向（1次调用）
    try {
        let mfRows = await TushareService.getMoneyflowThsByDate(tradeDateStr);
        if (mfRows.length === 0) {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            mfRows = await TushareService.getMoneyflowThsByDate(yesterday.toISOString().slice(0, 10).replace(/-/g, ''));
        }
        for (const row of mfRows) {
            cache.moneyflowThsMap.set(row.ts_code, row);
        }
        console.log(`[TenxScore] THS缓存: moneyflow_ths=${cache.moneyflowThsMap.size}只`);
    } catch (e) { console.warn('[TenxScore] moneyflow_ths缓存失败:', (e as Error).message); }

    _thsCache = cache;
    _thsCacheDate = tradeDateStr;
}

/**
 * 十倍股评分体系 v4：前瞻爆发版（百分制）
 * 
 * 设计逻辑：参考十倍股评分系统结构文档，6维度18指标
 * 1. 业绩爆发力 30% - 未来预期增速、营收增速、利润加速
 * 2. 赛道景气度 25% - 行业资本开支、渗透率、政策趋势
 * 3. 估值弹性 15% - PEG、市值、估值空间
 * 4. 盈利质量 15% - 毛利率、净利率提升、现金流
 * 5. 竞争壁垒 10% - 市占率、合同负债、行业地位
 * 6. 消息催化 5% - 机构调研、股东集中度、硬催化
 * 
 * 百分制换算：原5分制 → 1分=20, 2分=40, 3分=60, 4分=80, 5分=100
 */

interface DimDef {
    name: string;
    weight: number;
    indicators: { name: string; key: string }[];
}

const TENX_DIMS: DimDef[] = [
    { name: '业绩爆发力', weight: 30, indicators: [
        { name: '未来2年预期净利润复合增速', key: 'profit_forecast_cagr' },
        { name: '最近单季营收同比增速', key: 'rev_yoy_latest' },
        { name: '最近一季利润同比加速', key: 'earnings_accel' },
    ]},
    { name: '赛道景气度', weight: 25, indicators: [
        { name: '市场认可度', key: 'market_recognition' },
        { name: '行业渗透率位置', key: 'industry_penetration' },
        { name: '政策/产业趋势强度', key: 'policy_trend_score' },
    ]},
    { name: '估值弹性', weight: 15, indicators: [
        { name: 'PEG', key: 'peg' },
        { name: '当前总市值(亿)', key: 'market_cap' },
        { name: '估值双击空间(倍)', key: 'valuation_upside' },
    ]},
    { name: '盈利质量', weight: 15, indicators: [
        { name: '毛利率(%)', key: 'gross_margin' },
        { name: '净利率同比提升(pct)', key: 'net_margin_improve' },
        { name: '经营现金流/净利润', key: 'ocf_to_profit' },
    ]},
    { name: '竞争壁垒', weight: 10, indicators: [
        { name: '细分赛道市占率趋势', key: 'market_share_trend' },
        { name: '合同负债环比增速', key: 'contract_liab_growth' },
        { name: '行业地位不可替代性', key: 'industry_position' },
    ]},
    { name: '消息催化', weight: 5, indicators: [
        { name: '近1月机构调研家数', key: 'research_visit_count' },
        { name: '股东户数较上期变化率', key: 'holder_change_rate' },
        { name: '硬催化(政策/订单)', key: 'hard_catalyst' },
    ]},
];

function scoreByRange(value: number, ranges: [number, number][]): number {
    if (value >= ranges[0][0]) return ranges[0][1];
    for (let i = 1; i < ranges.length; i++) {
        if (value >= ranges[i][0]) {
            const ratio = (value - ranges[i][0]) / (ranges[i - 1][0] - ranges[i][0]);
            return Math.round(ranges[i][1] + ratio * (ranges[i - 1][1] - ranges[i][1]));
        }
    }
    return ranges[ranges.length - 1][1];
}

function scoreByRangeLowBetter(value: number, ranges: [number, number][]): number {
    if (value <= ranges[0][0]) return ranges[0][1];
    for (let i = 1; i < ranges.length; i++) {
        if (value <= ranges[i][0]) {
            const ratio = (ranges[i][0] - value) / (ranges[i][0] - ranges[i - 1][0]);
            return Math.round(ranges[i][1] + ratio * (ranges[i - 1][1] - ranges[i][1]));
        }
    }
    return ranges[ranges.length - 1][1];
}

const LOW_BETTER_KEYS = new Set(['peg', 'market_cap', 'holder_change_rate', 'industry_penetration']);

/**
 * 百分制评分映射表
 * 原文档5分制 → 百分制换算：1分=20, 2分=40, 3分=60, 4分=80, 5分=100
 * 在区间之间做线性插值
 */
const SCORE_MAPS: Record<string, [number, number][]> = {
    // 业绩爆发力
    // 未来2年预期净利润复合增速: ≥80%→100, 60-80%→80, 40-60%→60, 20-40%→40, <20%→20
    profit_forecast_cagr: [[80, 100], [60, 80], [40, 60], [20, 40], [0, 20], [-20, 10]],
    // 最近单季营收同比增速: ≥80%→100, 50-80%→80, 30-50%→60, 0-30%→40, <0→20
    rev_yoy_latest: [[80, 100], [50, 80], [30, 60], [0, 40], [-10, 20]],
    // 最近一季利润同比加速(二阶导): 明显加速+20pct→100, 小幅加速→80, 持平→60, 减速→20
    earnings_accel: [[20, 100], [10, 80], [0, 60], [-10, 40], [-30, 20], [-60, 10]],

    // 赛道景气度
    // 市场认可度(机构持股比例%): ≥40%→100, 30-40%→80, 20-30%→60, 10-20%→40, <10%→20
    market_recognition: [[40, 100], [30, 80], [20, 60], [10, 40], [0, 20]],
    // 行业渗透率位置: <10%→100, 10-20%→80, 20-40%→60, >40%→20
    industry_penetration: [[10, 100], [20, 80], [40, 60], [80, 20]],
    // 政策/产业趋势强度: 国家战略+资本开支高增→100, 有政策支持→80, 平淡→40, 压制→20
    policy_trend_score: [[5, 100], [4, 80], [3, 60], [2, 40], [1, 20]],

    // 估值弹性
    // PEG: <0.5→100, 0.5-0.8→80, 0.8-1.2→60, 1.2-2→40, >2→20
    peg: [[0.5, 100], [0.8, 80], [1.2, 60], [2, 40], [5, 20]],
    // 当前总市值(亿): <50→100, 50-100→80, 100-300→60, 300-500→40, >500→20
    market_cap: [[50, 100], [100, 80], [300, 60], [500, 40], [2000, 20]],
    // 估值双击空间(倍): ≥10→100, 5-10→80, 3-5→60, 1-3→40, <1→20
    valuation_upside: [[10, 100], [5, 80], [3, 60], [1, 40], [0, 20]],

    // 盈利质量
    // 毛利率: ≥40%→100, 30-40%→80, 20-30%→60, 10-20%→40, <10%→20
    gross_margin: [[40, 100], [30, 80], [20, 60], [10, 40], [0, 20]],
    // 净利率同比提升(pct): 提升>5pct→100, 2-5pct→80, 持平/升<2→60, 降2-5pct→40, 降>5pct→20
    net_margin_improve: [[5, 100], [2, 80], [0, 60], [-2, 40], [-5, 20], [-20, 10]],
    // 经营现金流/净利润: ≥1.2→100, 1.0-1.2→80, 0.8-1.0→60, 0.5-0.8→40, <0.5→20
    ocf_to_profit: [[1.2, 100], [1.0, 80], [0.8, 60], [0.5, 40], [0, 20], [-0.5, 10]],

    // 竞争壁垒
    // 细分赛道市占率趋势: 龙一且快速提升→100, 龙一稳步提升→80, 龙二且提升→60, 龙一下滑/跟随者→40, 同质化→20
    market_share_trend: [[5, 100], [4, 80], [3, 60], [2, 40], [1, 20]],
    // 合同负债环比增速: 环比增>30%→100, 10-30%→80, 0-10%→60, -10%~0→40, <-10%→20
    contract_liab_growth: [[30, 100], [10, 80], [0, 60], [-10, 40], [-30, 20]],
    // 行业地位不可替代性: 绝对龙头+卡脖子→100, 细分龙头→80, 跟随者→40, 同质化→20
    industry_position: [[5, 100], [4, 80], [2, 40], [1, 20]],

    // 消息催化
    // 近1月机构调研家数: ≥50→100, 20-50→80, 5-20→60, 1-5→40, 0→20
    research_visit_count: [[50, 100], [20, 80], [5, 60], [1, 40], [0, 20]],
    // 股东户数较上期变化率: 下降≥30%→100, 降15-30%→80, 持平→60, 增加≥15%→20
    holder_change_rate: [[-30, 100], [-15, 80], [0, 60], [15, 40], [30, 20]],
    // 硬催化(政策/订单): 明确未兑现硬催化→100, 催化偏弱→60, 无催化→40, 利空→20
    hard_catalyst: [[5, 100], [3, 60], [2, 40], [1, 20]],
};

/**
 * 数据缺失时的默认评分
 * 策略：核心维度缺失给中等偏低分，辅助维度缺失给中等分
 */
const DEFAULT_SCORE_WHEN_MISSING: Record<string, number> = {
    // 业绩爆发力 - 核心维度，缺失给中等分
    profit_forecast_cagr: 55,   // 无预期数据给55（中性偏上）
    rev_yoy_latest: 55,
    earnings_accel: 55,
    // 赛道景气度 - 核心维度
    market_recognition: 60,     // 市场认可度缺失给60（有交易活跃度兜底一般不会缺失）
    industry_penetration: 60,   // 无渗透率数据给60
    policy_trend_score: 60,     // 无政策趋势给60
    // 估值弹性 - 辅助维度
    peg: 60,
    market_cap: 60,
    valuation_upside: 60,
    // 盈利质量 - 核心维度
    gross_margin: 55,
    net_margin_improve: 55,
    ocf_to_profit: 55,
    // 竞争壁垒 - 辅助维度
    market_share_trend: 55,
    contract_liab_growth: 55,
    industry_position: 55,
    // 消息催化
    research_visit_count: 50,   // 无调研数据默认中等
    holder_change_rate: 55,
    hard_catalyst: 50,          // 无催化默认中等
};

function avg(nums: number[]): number { if (!nums.length) return 0; return nums.reduce((a, b) => a + b, 0) / nums.length; }
function percentile(arr: number[], value: number): number { if (!arr.length) return 50; const sorted = [...arr].sort((a, b) => a - b); let count = 0; for (const v of sorted) { if (v <= value) count++; else break; } return Math.round((count / sorted.length) * 100); }

function formatValue(key: string, raw: number | string | null | undefined): string {
    if (raw === null || raw === undefined) return '--';
    if (typeof raw === 'string') return raw;
    const pctKeys = new Set(['profit_forecast_cagr', 'rev_yoy_latest', 'earnings_accel', 'market_recognition', 'gross_margin', 'net_margin_improve', 'contract_liab_growth', 'holder_change_rate']);
    const ratioKeys = new Set(['ocf_to_profit', 'peg', 'valuation_upside']);
    const pctileKeys = new Set(['industry_penetration']);
    if (pctKeys.has(key)) return raw.toFixed(1) + '%';
    if (ratioKeys.has(key)) return raw.toFixed(2);
    if (pctileKeys.has(key)) return raw.toFixed(1) + '%';
    if (key === 'market_cap') return raw.toFixed(0) + '亿';
    if (key === 'policy_trend_score' || key === 'market_share_trend' || key === 'industry_position' || key === 'hard_catalyst') return Math.round(raw).toString();
    if (key === 'research_visit_count') return Math.round(raw).toString() + '家';
    return raw.toFixed(2);
}

interface RawIndicators { [key: string]: number | string | null | undefined; stockName?: string; }

export interface IndustryCache { [industryCode: string]: { industryName: string; market_recognition: number; policy_trend_score: number; members: string[]; }; }

interface PrefetchedData {
    income: TushareService.IncomeRow[]; fina: TushareService.FinaIndicatorRow[]; cashflow: TushareService.CashflowRow[];
    balance: TushareService.BalanceSheetRow[]; daily: TushareService.DailyBasicRow[];
    prices: TushareService.DailyPriceRow[];
    forecast: TushareService.ForecastRow[];
    holderNumber: TushareService.HolderNumberRow[];
    institutionalHold: TushareService.InstitutionalHoldRow[];
    hkHold: TushareService.HkHoldRow[];
    survival: TushareService.StkSurvivalRow[];
    analystRating: TushareService.AnalystRatingRow[];
    industry: { ts_code: string; industry_name: string; industry_code: string } | null;
    // THS增强数据
    limitListThs: TushareService.LimitListThsRow | null;
    thsHot: TushareService.ThsHotRow | null;
    moneyflowThs: TushareService.MoneyflowThsRow | null;
    kplConceptCons: TushareService.KplConceptConsRow[];
}

async function prefetchAllData(symbol: string): Promise<PrefetchedData> {
    const threeYearsAgo = new Date(); threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 4);
    const startDate = threeYearsAgo.toISOString().slice(0, 10).replace(/-/g, '');
    const fiveYearsAgo = new Date(); fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
    const startDate5y = fiveYearsAgo.toISOString().slice(0, 10).replace(/-/g, '');
    const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const startDate1y = oneYearAgo.toISOString().slice(0, 10).replace(/-/g, '');
    const emptyArr: any[] = [];
    const catchEmpty = (label: string) => (e: any) => { console.warn(`[TenxScore] ${label} failed:`, e?.message); return emptyArr; };

    const [income, fina, cashflow, balance, daily, prices, forecast, holderNumber, institutionalHold, hkHold, survival, analystRating] = await Promise.all([
        TushareService.getIncome(symbol, startDate).catch(catchEmpty('getIncome')),
        TushareService.getFinaIndicator(symbol, startDate).catch(catchEmpty('getFinaIndicator')),
        TushareService.getCashflow(symbol, startDate).catch(catchEmpty('getCashflow')),
        TushareService.getBalanceSheet(symbol, startDate).catch(catchEmpty('getBalanceSheet')),
        TushareService.getDailyBasic(symbol, startDate5y).catch(catchEmpty('getDailyBasic')),
        TushareService.getDailyPrices(symbol, startDate5y).catch(catchEmpty('getDailyPrices')),
        TushareService.getForecast(symbol, startDate1y).catch(catchEmpty('getForecast')),
        TushareService.getHolderNumber(symbol, startDate1y).catch(catchEmpty('getHolderNumber')),
        TushareService.getInstitutionalHold(symbol, startDate1y).catch(catchEmpty('getInstitutionalHold')),
        TushareService.getHkHold(symbol, startDate1y).catch(catchEmpty('getHkHold')),
        TushareService.getStkSurvival(symbol, startDate1y).catch(catchEmpty('getStkSurvival')),
        TushareService.getAnalystRating(symbol, startDate1y).catch(catchEmpty('getAnalystRating')),
    ]);
    const industry = await TushareService.getStockIndustry(symbol).catch(e => { console.warn('[TenxScore] getStockIndustry failed:', e?.message); return null; }) as any;

    // THS增强数据（使用全局缓存，避免每只股票重复调用全市场接口）
    // 如果缓存未加载，自动触发一次加载
    if (!_thsCache || (_thsCache.limitListMap.size === 0 && _thsCache.thsHotMap.size === 0 && _thsCache.moneyflowThsMap.size === 0)) {
        await preloadThsEnhanceCache();
    }
    const thsCache = getThsEnhanceCache();
    const tsCode = symbol.includes('.') ? symbol : (symbol.startsWith('6') || symbol.startsWith('9') ? symbol + '.SH' : symbol + '.SZ');
    const limitListThs = thsCache.limitListMap.get(tsCode) || null;
    const thsHot = thsCache.thsHotMap.get(tsCode) || null;
    const moneyflowThs = thsCache.moneyflowThsMap.get(tsCode) || null;

    // kpl_concept_cons：按股票代码查询所属概念（带缓存）
    let kplConceptCons: TushareService.KplConceptConsRow[] = [];
    {
        if (_kplConceptCache.has(tsCode)) {
            kplConceptCons = _kplConceptCache.get(tsCode)!;
        } else {
            try {
                kplConceptCons = await TushareService.getKplConceptCons({ con_code: tsCode });
                _kplConceptCache.set(tsCode, kplConceptCons);
            } catch (e) { console.warn('[TenxScore] kpl_concept_cons failed:', (e as Error).message); }
        }
    }

    console.log(`[TenxScore] ${symbol} 数据获取: income=${income.length}, fina=${fina.length}, cashflow=${cashflow.length}, balance=${balance.length}, daily=${daily.length}, prices=${prices.length}, forecast=${forecast.length}, holderNumber=${holderNumber.length}, instHold=${institutionalHold.length}, hkHold=${hkHold.length}, survival=${survival.length}, analyst=${analystRating.length}, industry=${industry ? industry.industry_name : 'null'}, limitList=${limitListThs ? 'Y' : 'N'}, thsHot=${thsHot ? 'Y' : 'N'}, mfThs=${moneyflowThs ? 'Y' : 'N'}, kplCons=${kplConceptCons.length}`);

    return { income: income as any[], fina: fina as any[], cashflow: cashflow as any[], balance: balance as any[], daily: daily as any[], prices: prices as any[], forecast: forecast as any[], holderNumber: holderNumber as any[], institutionalHold: institutionalHold as any[], hkHold: hkHold as any[], survival: survival as any[], analystRating: analystRating as any[], industry, limitListThs, thsHot, moneyflowThs, kplConceptCons };
}

async function prefetchDynamicData(symbol: string, cached: PrefetchedData): Promise<PrefetchedData> {
    const fiveYearsAgo = new Date(); fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
    const startDate5y = fiveYearsAgo.toISOString().slice(0, 10).replace(/-/g, '');
    const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const startDate1y = oneYearAgo.toISOString().slice(0, 10).replace(/-/g, '');
    const emptyArr: any[] = [];
    const catchEmpty = (label: string) => (e: any) => { console.warn(`[TenxScore] ${label} failed:`, e?.message); return emptyArr; };
    const [daily, prices, holderNumber, institutionalHold, hkHold, survival, analystRating] = await Promise.all([
        TushareService.getDailyBasic(symbol, startDate5y).catch(catchEmpty('getDailyBasic(quick)')),
        TushareService.getDailyPrices(symbol, startDate5y).catch(catchEmpty('getDailyPrices(quick)')),
        TushareService.getHolderNumber(symbol, startDate1y).catch(catchEmpty('getHolderNumber(quick)')),
        TushareService.getInstitutionalHold(symbol, startDate1y).catch(catchEmpty('getInstitutionalHold(quick)')),
        TushareService.getHkHold(symbol, startDate1y).catch(catchEmpty('getHkHold(quick)')),
        TushareService.getStkSurvival(symbol, startDate1y).catch(catchEmpty('getStkSurvival(quick)')),
        TushareService.getAnalystRating(symbol, startDate1y).catch(catchEmpty('getAnalystRating(quick)')),
    ]);
    return {
        income: cached.income, fina: cached.fina, cashflow: cached.cashflow, balance: cached.balance,
        daily: daily as any[], prices: prices as any[], forecast: cached.forecast,
        holderNumber: holderNumber as any[], industry: cached.industry,
        institutionalHold: institutionalHold as any[], hkHold: hkHold as any[],
        survival: survival as any[], analystRating: analystRating as any[],
        limitListThs: cached.limitListThs, thsHot: cached.thsHot, moneyflowThs: cached.moneyflowThs,
        kplConceptCons: cached.kplConceptCons,
    };
}

/**
 * 维度1：业绩爆发力 (30%)
 * 指标：未来2年预期净利润复合增速、最近单季营收同比增速、最近一季利润同比加速
 */
function calcEarningsExplosion(data: PrefetchedData): RawIndicators {
    const { income, fina, forecast } = data;

    // ① 未来2年预期净利润复合增速
    let profit_forecast_cagr: number | null = null;

    // 优先用业绩预告数据
    if (forecast.length > 0) {
        const latestForecast = forecast.sort((a, b) => b.ann_date.localeCompare(a.ann_date))[0];
        if (latestForecast.p_change_min != null && latestForecast.p_change_max != null) {
            profit_forecast_cagr = (latestForecast.p_change_min + latestForecast.p_change_max) / 2;
        }
    }

    // 如果没有业绩预告，用最近3年净利润CAGR
    if (profit_forecast_cagr === null) {
        const annualReports = income.filter(r => r.end_date && r.end_date.endsWith('1231') && r.n_income_attr_p)
            .sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 3);
        if (annualReports.length >= 2) {
            const latest = annualReports[0].n_income_attr_p || 0;
            const oldest = annualReports[annualReports.length - 1].n_income_attr_p || 0;
            const years = annualReports.length - 1;
            if (oldest > 0 && latest > 0) {
                profit_forecast_cagr = (Math.pow(latest / oldest, 1 / years) - 1) * 100;
            } else if (oldest < 0 && latest > 0) {
                profit_forecast_cagr = 100; // 扭亏
            }
        }
    }

    // ② 最近单季营收同比增速 - 改进：用Tushare的季度报告直接对比
    let rev_yoy_latest: number | null = null;
    const quarterlyIncome = income.filter(r => r.end_date && r.total_revenue)
        .sort((a, b) => b.end_date.localeCompare(a.end_date));

    // 尝试找同季度同比：比如最新2024Q3 vs 2023Q3
    if (quarterlyIncome.length >= 2) {
        const latest = quarterlyIncome[0];
        const latestQuarter = latest.end_date.slice(4); // e.g., '0331', '0630', '0930', '1231'
        // 找去年同季度
        const prevYearSameQ = quarterlyIncome.find(r =>
            r.end_date !== latest.end_date && r.end_date.endsWith(latestQuarter)
        );
        if (prevYearSameQ && prevYearSameQ.total_revenue > 0 && latest.total_revenue) {
            rev_yoy_latest = ((latest.total_revenue / prevYearSameQ.total_revenue) - 1) * 100;
        }
    }

    // 回退：用年报数据
    if (rev_yoy_latest === null) {
        const annualReports = quarterlyIncome.filter(r => r.end_date.endsWith('1231')).slice(0, 2);
        if (annualReports.length >= 2) {
            const latest = annualReports[0], prev = annualReports[1];
            if (prev.total_revenue > 0 && latest.total_revenue) {
                rev_yoy_latest = ((latest.total_revenue / prev.total_revenue) - 1) * 100;
            }
        }
    }

    // ③ 最近一季利润同比加速(二阶导)
    let earnings_accel: number | null = null;
    const accelReports = income.filter(r => r.end_date && r.end_date.endsWith('1231') && r.n_income_attr_p)
        .sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 3);
    if (accelReports.length >= 3) {
        const latest = accelReports[0].n_income_attr_p || 0;
        const prev = accelReports[1].n_income_attr_p || 0;
        const prevPrev = accelReports[2].n_income_attr_p || 0;
        let recentGrowth = 0;
        if (prev > 0) recentGrowth = ((latest / prev) - 1) * 100;
        else if (prev < 0 && latest > 0) recentGrowth = 120;
        let prevGrowth = 0;
        if (prevPrev > 0) prevGrowth = ((prev / prevPrev) - 1) * 100;
        else if (prevPrev < 0 && prev > 0) prevGrowth = 120;
        earnings_accel = recentGrowth - prevGrowth;
    }

    return { profit_forecast_cagr, rev_yoy_latest, earnings_accel };
}

/**
 * 维度2：赛道景气度 (25%)
 * 指标：市场认可度、行业渗透率位置、政策/产业趋势强度
 */
async function calcIndustryTrack(symbol: string, data: PrefetchedData, industryCache?: IndustryCache): Promise<RawIndicators> {
    let industryCode = data.industry?.industry_code || '';
    let industryName = data.industry?.industry_name || '';

    // ① 市场认可度 - 综合机构持股 + 北向资金 + 分析师覆盖 + 交易活跃度
    let market_recognition: number | null = null;

    // 1a. 机构持股比例
    const instHold = data.institutionalHold;
    let instHoldRatio: number | null = null;
    if (instHold.length > 0) {
        const latest = instHold.sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
        instHoldRatio = latest.hold_ratio;
    }

    // 1b. 北向资金持股比例
    const hkHold = data.hkHold;
    let hkHoldRatio: number | null = null;
    let hkHoldChange: number | null = null;
    if (hkHold.length > 0) {
        const sorted = hkHold.sort((a, b) => b.trade_date.localeCompare(a.trade_date));
        const latest = sorted[0];
        hkHoldRatio = (latest as any).ratio ?? (latest as any).hold_ratio ?? null;
        if (sorted.length >= 2) {
            const prev = sorted[Math.min(sorted.length - 1, 19)];
            const prevRatio = (prev as any).ratio ?? (prev as any).hold_ratio ?? 0;
            if (hkHoldRatio != null) {
                hkHoldChange = hkHoldRatio - prevRatio;
            }
        }
    }

    // 1c. 分析师覆盖数量
    const analystCount = data.analystRating.length;

    // 1d. 交易活跃度（换手率+成交额）- 作为市场认可度的替代指标
    let tradingActivityScore: number | null = null;
    if (data.daily.length > 0 || data.prices.length > 0) {
        // 换手率来自daily_basic
        const recentDaily = data.daily.slice(-20);
        const avgTurnover = recentDaily.length > 0
            ? recentDaily.reduce((s, r) => s + (r.turnover_rate || 0), 0) / recentDaily.length
            : 0;
        // 成交额来自prices（单位：千元）
        const recentPrices = data.prices.slice(-20);
        const avgAmount = recentPrices.length > 0
            ? recentPrices.reduce((s, r) => s + (r.amount || 0), 0) / recentPrices.length
            : 0;
        // 换手率评分：日均换手率8%以上为高活跃
        const turnoverScore = Math.min(avgTurnover / 8, 1) * 60;
        // 成交额评分：日均成交额10亿以上为高关注
        const amountScore = Math.min(avgAmount / 100000, 1) * 40;
        tradingActivityScore = turnoverScore + amountScore;
    }

    // 1e. 业绩预告关注度
    let forecastAttentionScore: number | null = null;
    if (data.forecast.length > 0) {
        const positiveTypes = data.forecast.filter(r => r.type === '预增' || r.type === '扭亏' || r.type === '略增');
        forecastAttentionScore = Math.min(positiveTypes.length, 3) / 3 * 100;
    }

    // 1f. THS热榜热度（来自ths_hot，新增增强维度）
    let thsHotScore: number | null = null;
    if (data.thsHot) {
        // 热度排名越靠前越好（排名前10→100, 前50→80, 前100→60, 前200→40, 其他→20）
        const rank = data.thsHot.rank || 9999;
        if (rank <= 10) thsHotScore = 100;
        else if (rank <= 50) thsHotScore = 80;
        else if (rank <= 100) thsHotScore = 60;
        else if (rank <= 200) thsHotScore = 40;
        else thsHotScore = 20;
        // 热度值额外加分
        const hotVal = data.thsHot.hot || 0;
        if (hotVal > 0) thsHotScore = Math.min(100, (thsHotScore || 0) + Math.min(hotVal / 10, 10));
    }

    // 1g. THS资金流向热度（来自moneyflow_ths，新增增强维度）
    let mfThsScore: number | null = null;
    if (data.moneyflowThs) {
        const netRatio = data.moneyflowThs.net_mf_ratio || 0;  // 净流入占比
        const mf5day = data.moneyflowThs.mf_5day || 0;  // 5日主力净额（万元）
        // 净流入占比评分
        const ratioScore = Math.min(Math.abs(netRatio) / 5, 1) * 50;
        // 5日主力净额评分
        const mf5Score = mf5day > 0 ? Math.min(mf5day / 10000, 1) * 50 : 0;
        mfThsScore = ratioScore + mf5Score;
    }

    // 综合计算市场认可度
    let score = 0;
    let weight = 0;
    const hasCoreData = instHoldRatio != null || hkHoldRatio != null;
    const hasThsData = thsHotScore != null || mfThsScore != null;

    // 机构持股比例贡献（权重25%）
    if (instHoldRatio != null) {
        score += Math.min(instHoldRatio, 60) / 60 * 100 * 0.25;
        weight += 0.25;
    }

    // 北向资金持股比例贡献（权重15%）
    if (hkHoldRatio != null) {
        score += Math.min(hkHoldRatio, 15) / 15 * 100 * 0.15;
        if (hkHoldChange != null && hkHoldChange > 0) {
            score += Math.min(hkHoldChange * 10, 15);
        }
        weight += 0.15;
    }

    // 分析师覆盖贡献（权重15%）
    if (analystCount > 0) {
        const analystScore = Math.min(analystCount, 20) / 20 * 100;
        score += analystScore * 0.15;
        weight += 0.15;
    }

    // THS热榜热度贡献（权重15%，新增）
    if (thsHotScore != null) {
        score += thsHotScore * 0.15;
        weight += 0.15;
    }

    // THS资金流向热度贡献（权重10%，新增）
    if (mfThsScore != null) {
        score += mfThsScore * 0.1;
        weight += 0.1;
    }

    // 交易活跃度贡献 - 有核心/THS数据时权重15%，无数据时降权到10%
    const tradingWeight = (hasCoreData || hasThsData) ? 0.15 : 0.1;
    if (tradingActivityScore != null) {
        score += tradingActivityScore * tradingWeight;
        weight += tradingWeight;
    }

    // 业绩预告关注度贡献（权重5%）- 替代指标
    if (forecastAttentionScore != null) {
        score += forecastAttentionScore * 0.05;
        weight += 0.05;
    }

    if (weight > 0) {
        market_recognition = Math.min(100, Math.round(score / weight * 10) / 10);
    }

    // ② 行业渗透率位置 - 基于行业名称判断
    const industry_penetration = calcPenetrationScore(industryName);

    // ③ 政策/产业趋势强度
    let policy_trend_score: number | null = null;
    if (industryName) {
        for (const [keyword, score] of Object.entries(policyTrendMap)) {
            if (industryName.includes(keyword)) { policy_trend_score = score; break; }
        }
    }

    // ③b. 概念人气值增强（来自kpl_concept_cons，新增增强维度）
    // 如果该股票所在概念板块有高人气成分股，提升赛道景气度
    if (data.kplConceptCons.length > 0) {
        const avgPopularity = data.kplConceptCons.reduce((s, r) => s + (r.hot_num || 0), 0) / data.kplConceptCons.length;
        // 人气值>50→加分，>100→显著加分
        const popularityBoost = Math.min(avgPopularity / 50, 1);  // 0-1
        if (policy_trend_score != null) {
            // 有政策趋势数据时，人气值作为加分项
            policy_trend_score = Math.min(5, policy_trend_score + popularityBoost * 0.5);
        } else {
            // 无政策趋势数据时，人气值直接映射为趋势强度
            if (avgPopularity > 100) policy_trend_score = 4;
            else if (avgPopularity > 50) policy_trend_score = 3;
            else policy_trend_score = 2;
        }
    }

    if (industryCode && industryCache) {
        industryCache[industryCode] = {
            industryName,
            market_recognition: market_recognition ?? 0,
            policy_trend_score: policy_trend_score ?? 3,
            members: [],
        };
    }

    return { market_recognition, industry_penetration, policy_trend_score };
}

/**
 * 政策/产业趋势强度映射（1-5分，对应百分制20-100）
 * 5=国家战略+资本开支高增, 4=有政策支持, 3=一般, 2=平淡, 1=压制
 */
const policyTrendMap: Record<string, number> = {
    // 5分：国家战略+资本开支高增
    '半导体': 5, '芯片': 5, '人工智能': 5, '新能源': 5, '储能': 5, '信创': 5, '数字经济': 5, '机器人': 5, '量子': 5, '脑机': 5,
    'CPO': 5, '光模块': 5, '算力': 5, '数据中心': 5, '物理AI': 5, '人形机器人': 5, '固态电池': 5, '低空经济': 5, 'eVTOL': 5,
    '大模型': 5, 'AIGC': 5, '智算': 5, '国产替代': 5, '先进封装': 5, 'HBM': 5, '硅光': 5, 'Agent': 5,
    // 4分：有政策支持
    '光伏': 4, '军工': 4, '航天': 4, '创新药': 4, '电池': 4, '风电': 4, '氢能': 4, '软件': 4, '云计算': 4, '大数据': 4,
    '网络安全': 4, '生物': 4, '基因': 4, '航空': 4, '新材料': 4, '稀土': 4, '碳中和': 4, '环保': 4, '核电': 4, '卫星': 4,
    '存储': 4, 'PCB': 4, '光纤': 4, '碳化硅': 4, '特高压': 4, '智能驾驶': 4, '自动驾驶': 4, '激光雷达': 4,
    '工业母机': 4, '3D打印': 4, '超导': 4, '合成生物': 4, '商业航天': 4, '6G': 4,
    // 3分：一般
    '医疗器械': 3, '消费电子': 3, '汽车': 3, '物联网': 3, '通信': 3, '5G': 3, '半导体材料': 3, '显示': 3, '面板': 3,
    '智能家居': 3, '工业互联': 3, '智能制造': 3, '宠物': 3, '医美': 3, '养老': 3, '体育': 3, '文化': 3, '教育': 3,
    '游戏': 3, '影视': 3, '食品': 3, '饮料': 3, '家电': 3, '建材': 3, '装饰': 3, '农业': 3, '种业': 3,
    '培育钻石': 3, 'VR': 3, 'AR': 3, 'MR': 3, 'XR': 3, 'MiniLED': 3, 'MicroLED': 3,
    '充电桩': 3, '换电': 3, '钠电池': 3, '钒电池': 3,
    // 2分：平淡
    '银行': 2, '保险': 2, '证券': 2, '地产': 2, '钢铁': 2, '煤炭': 2, '石油': 2, '化工': 2, '有色': 2,
    '港口': 2, '公路': 2, '铁路': 2, '电力': 2, '水务': 2, '燃气': 2, '纺织': 2, '服装': 2, '造纸': 2,
    '包装': 3, '家居': 3, '白酒': 2, '零售': 2, '贸易': 2,
};

/**
 * 行业渗透率位置评分
 * 基于行业名称判断渗透率阶段
 * <10%→100分(早期), 10-20%→80分(成长初期), 20-40%→60分(成长中期), >40%→20分(成熟期)
 */
function calcPenetrationScore(industryName: string): number | null {
    if (!industryName) return null;
    // 早期渗透率行业（<10%）→ 100分
    const earlyStage = ['量子', '脑机', '物理AI', '人形机器人', '固态电池', '氢能', 'CPO', '共封装', '玻璃基板',
        '算力Token', '算电协同', '低空经济', 'eVTOL', '硅光', 'HBM', '先进封装', '合成生物', 'Agent'];
    // 成长初期行业（10-20%）→ 80分
    const growthEarly = ['人工智能', '机器人', '储能', '创新药', '培育钻石', '碳化硅', '虚拟现实', 'MR',
        'AIGC', '大模型', '智算', '信创', '数字经', '6G', '商业航天', '超导'];
    // 成长中期行业（20-40%）→ 60分
    const growthMid = ['新能源', '光伏', '半导体', '芯片', '电池', '风电', '5G', '物联网', '消费电子',
        '光模块', '算力', '数据中心', '自动驾驶', '智能驾驶', '激光雷达', '工业母机', '3D打印', '充电桩'];
    // 成熟期行业（>40%）→ 20分
    const mature = ['银行', '保险', '证券', '地产', '钢铁', '煤炭', '石油', '化工', '食品', '饮料', '家电',
        '汽车', '白酒', '零售', '贸易', '纺织', '造纸', '燃气', '水务', '电力'];

    if (earlyStage.some(k => industryName.includes(k))) return 8;
    if (growthEarly.some(k => industryName.includes(k))) return 15;
    if (growthMid.some(k => industryName.includes(k))) return 30;
    if (mature.some(k => industryName.includes(k))) return 60;
    return 25;
}

/**
 * 维度3：估值弹性 (15%)
 * 指标：PEG、当前总市值、估值双击空间
 */
function calcValuationElasticity(data: PrefetchedData): RawIndicators {
    const daily = data.daily;
    const fina = data.fina;
    const forecast = data.forecast;

    // ① PEG = PE_TTM / 未来2年预期增速
    let peg: number | null = null;
    const latestDaily = daily.length > 0 ? daily[daily.length - 1] : null;
    const currentPE = latestDaily?.pe;

    if (currentPE && currentPE > 0) {
        // 优先用业绩预告增速
        let growthRate: number | null = null;
        if (forecast.length > 0) {
            const latestForecast = forecast.sort((a, b) => b.ann_date.localeCompare(a.ann_date))[0];
            if (latestForecast.p_change_min != null && latestForecast.p_change_max != null) {
                growthRate = (latestForecast.p_change_min + latestForecast.p_change_max) / 2;
            }
        }

        // 回退：用最近3年净利润CAGR
        if (!growthRate) {
            const annualIncome = data.income.filter(r => r.end_date && r.end_date.endsWith('1231') && r.n_income_attr_p)
                .sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 3);
            if (annualIncome.length >= 2) {
                const latest = annualIncome[0].n_income_attr_p || 0;
                const oldest = annualIncome[annualIncome.length - 1].n_income_attr_p || 0;
                const years = annualIncome.length - 1;
                if (oldest > 0 && latest > 0) {
                    growthRate = (Math.pow(latest / oldest, 1 / years) - 1) * 100;
                }
            }
        }

        if (growthRate && growthRate > 0) {
            peg = currentPE / growthRate;
        }
    }

    // ② 当前总市值(亿)
    const total_mv = latestDaily?.total_mv;
    let market_cap: number | null = null;
    if (total_mv) market_cap = total_mv / 10000;

    // ③ 估值双击空间(倍) = (1+预期增速)^3 × (行业合理PE/当前PE)
    let valuation_upside: number | null = null;
    if (currentPE && currentPE > 0) {
        // 动态计算行业合理PE：基于行业分类取不同合理PE
        const industryName = data.industry?.industry_name || '';
        let reasonablePE = 25; // 默认
        // 高成长行业给更高合理PE
        const highPEIndustries = ['半导体', '芯片', '人工智能', '新能源', '储能', '信创', '机器人', 'CPO', '光模块', '算力', '创新药', '数字经济'];
        const midPEIndustries = ['电子', '消费电子', '通信', '软件', '云计算', '军工', '光伏', '电池', '医疗器械'];
        for (const kw of highPEIndustries) { if (industryName.includes(kw)) { reasonablePE = 45; break; } }
        for (const kw of midPEIndustries) { if (industryName.includes(kw)) { reasonablePE = 35; break; } }

        let growthRate = 0;
        if (forecast.length > 0) {
            const latestForecast = forecast.sort((a, b) => b.ann_date.localeCompare(a.ann_date))[0];
            if (latestForecast.p_change_min != null && latestForecast.p_change_max != null) {
                growthRate = ((latestForecast.p_change_min + latestForecast.p_change_max) / 2) / 100;
            }
        }
        if (growthRate === 0) {
            const annualIncome = data.income.filter(r => r.end_date && r.end_date.endsWith('1231') && r.n_income_attr_p)
                .sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 3);
            if (annualIncome.length >= 2) {
                const latest = annualIncome[0].n_income_attr_p || 0;
                const oldest = annualIncome[annualIncome.length - 1].n_income_attr_p || 0;
                const years = annualIncome.length - 1;
                if (oldest > 0 && latest > 0) {
                    growthRate = Math.pow(latest / oldest, 1 / years) - 1;
                }
            }
        }
        const earningsUpside = Math.pow(1 + growthRate, 3);
        const peUpside = reasonablePE / currentPE;
        valuation_upside = earningsUpside * peUpside;
    }

    return { peg, market_cap, valuation_upside };
}

/**
 * 维度4：盈利质量 (15%)
 * 指标：毛利率、净利率同比提升幅度、经营现金流/净利润
 */
function calcProfitQuality(data: PrefetchedData): RawIndicators {
    const { fina, cashflow, income } = data;

    // ① 毛利率(%)
    let gross_margin: number | null = null;
    const annualFina = fina.filter(r => r.end_date && r.grossprofit_margin != null)
        .sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 1);
    if (annualFina.length > 0) {
        gross_margin = annualFina[0].grossprofit_margin || 0;
    }

    // ② 净利率同比提升幅度(pct)
    let net_margin_improve: number | null = null;
    const annualFinaForMargin = fina.filter(r => r.end_date && r.end_date.endsWith('1231') && r.netprofit_margin != null)
        .sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 2);
    if (annualFinaForMargin.length >= 2) {
        net_margin_improve = (annualFinaForMargin[0].netprofit_margin || 0) - (annualFinaForMargin[1].netprofit_margin || 0);
    }

    // ③ 经营现金流/净利润
    let ocf_to_profit: number | null = null;
    const annualCashflow = cashflow.filter(r => r.end_date && r.end_date.endsWith('1231') && r.n_cashflow_act != null)
        .sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 1);
    const annualIncome = income.filter(r => r.end_date && r.end_date.endsWith('1231') && r.n_income_attr_p)
        .sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 1);

    if (annualCashflow.length > 0 && annualIncome.length > 0) {
        const ocf = annualCashflow[0].n_cashflow_act || 0;
        const profit = annualIncome[0].n_income_attr_p || 0;
        if (profit !== 0) {
            ocf_to_profit = ocf / profit;
        }
    }

    // 回退：用 fina_indicator 的 ocfps/eps 近似计算
    if (ocf_to_profit == null) {
        const annualFina = (fina as any[]).filter(r => r.end_date && r.end_date.endsWith('1231') && r.ocfps != null && r.eps != null && r.eps !== 0)
            .sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 1);
        if (annualFina.length > 0) {
            ocf_to_profit = annualFina[0].ocfps / annualFina[0].eps;
        }
    }

    return { gross_margin, net_margin_improve, ocf_to_profit };
}

/**
 * 维度5：竞争壁垒 (10%)
 * 指标：细分赛道市占率趋势、合同负债环比增速、行业地位不可替代性
 */
function calcCompetitiveMoat(data: PrefetchedData): RawIndicators {
    const { balance, fina, income } = data;

    // ① 细分赛道市占率趋势 - 综合毛利率水平、营收增速、ROE判断
    // 5=龙一且快速提升, 4=龙一稳步提升, 3=龙二且提升, 2=龙一下滑/跟随者, 1=同质化
    let market_share_trend: number | null = null;
    const latestFina = fina.filter(r => r.grossprofit_margin != null)
        .sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 1);
    const annualIncome = income.filter(r => r.end_date && r.end_date.endsWith('1231') && r.total_revenue)
        .sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 2);

    let revGrowth = 0;
    if (annualIncome.length >= 2) {
        const prev = annualIncome[1].total_revenue;
        if (prev > 0) revGrowth = ((annualIncome[0].total_revenue / prev) - 1) * 100;
    }

    const grossMargin = latestFina.length > 0 ? (latestFina[0].grossprofit_margin || 0) : 0;
    const roe = latestFina.length > 0 ? (latestFina[0].roe || 0) : 0;

    // 综合毛利率+营收增速+ROE判断市占率趋势
    if (grossMargin >= 40 && revGrowth >= 30 && roe >= 15) market_share_trend = 5;
    else if (grossMargin >= 30 && revGrowth >= 15 && roe >= 10) market_share_trend = 4;
    else if (grossMargin >= 20 && revGrowth >= 10) market_share_trend = 3;
    else if (grossMargin >= 10) market_share_trend = 2;
    else market_share_trend = 1;

    // ② 合同负债环比增速
    let contract_liab_growth: number | null = null;
    const balanceReports = balance.filter(r => r.end_date && r.contract_liab != null)
        .sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 2);
    if (balanceReports.length >= 2) {
        const latest = balanceReports[0].contract_liab || 0;
        const prev = balanceReports[1].contract_liab || 0;
        if (prev > 0) {
            contract_liab_growth = ((latest / prev) - 1) * 100;
        } else if (latest > 0 && prev === 0) {
            contract_liab_growth = 100;
        }
    }

    // ③ 行业地位不可替代性 - 综合毛利率+研发投入+营收规模判断
    // 5=绝对龙头+卡脖子, 4=细分龙头, 3=行业前列, 2=跟随者, 1=同质化
    let industry_position: number | null = null;
    const rdExpense = income.filter(r => r.end_date && r.end_date.endsWith('1231') && r.rd_exp != null && r.total_revenue)
        .sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 1);

    let rdRatio = 0;
    if (rdExpense.length > 0 && rdExpense[0].total_revenue > 0) {
        rdRatio = ((rdExpense[0].rd_exp || 0) / rdExpense[0].total_revenue) * 100;
    }

    // 营收规模（亿）
    let revenueScale = 0;
    if (annualIncome.length > 0 && annualIncome[0].total_revenue) {
        revenueScale = annualIncome[0].total_revenue / 1e8;
    }

    if (grossMargin >= 50 && rdRatio >= 10) industry_position = 5;
    else if (grossMargin >= 40 && rdRatio >= 5) industry_position = 4;
    else if ((grossMargin >= 30 && rdRatio >= 3) || (grossMargin >= 35 && revenueScale >= 100)) industry_position = 3;
    else if (grossMargin >= 20 || rdRatio >= 3) industry_position = 2;
    else industry_position = 1;

    return { market_share_trend, contract_liab_growth, industry_position };
}

/**
 * 维度6：消息催化 (5%)
 * 指标：近1月机构调研家数、股东户数较上期变化率、硬催化
 */
function calcNewsCatalyst(data: PrefetchedData): RawIndicators {
    const { holderNumber, forecast, survival, analystRating } = data;

    // ① 近1月机构调研家数 - 使用真实调研数据
    let research_visit_count: number | null = null;
    if (survival.length > 0) {
        // 统计最近1个月不同的调研机构数量
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        const oneMonthAgoStr = oneMonthAgo.toISOString().slice(0, 10).replace(/-/g, '');
        const recentVisits = survival.filter(r => r.visit_date && String(r.visit_date) >= oneMonthAgoStr);
        // 去重机构名称
        const uniqueInstitutions = new Set(recentVisits.map(r => r.institution_name).filter(Boolean));
        research_visit_count = uniqueInstitutions.size;
    }

    // 如果没有调研数据，用分析师覆盖数量近似
    if (research_visit_count === null || research_visit_count === 0) {
        if (analystRating.length > 0) {
            const uniqueOrgs = new Set(analystRating.map(r => r.org_name).filter(Boolean));
            research_visit_count = uniqueOrgs.size * 3; // 分析师数量×3近似调研家数
        } else {
            // 最后回退：用业绩预告类型近似
            const recentForecast = forecast.filter(r => r.ann_date)
                .sort((a, b) => b.ann_date.localeCompare(a.ann_date)).slice(0, 3);
            if (recentForecast.length > 0) {
                const positiveTypes = recentForecast.filter(r => r.type === '预增' || r.type === '扭亏' || r.type === '略增');
                if (positiveTypes.length >= 2) research_visit_count = 30;
                else if (positiveTypes.length >= 1) research_visit_count = 15;
                else research_visit_count = 5;
            } else {
                research_visit_count = 0;
            }
        }
    }

    // ② 股东户数较上期变化率
    let holder_change_rate: number | null = null;
    if (holderNumber.length >= 2) {
        const sorted = holderNumber.sort((a, b) => b.end_date.localeCompare(a.end_date));
        const latest = sorted[0].holder_num;
        const prev = sorted[1].holder_num;
        if (prev > 0) {
            holder_change_rate = ((latest / prev) - 1) * 100;
        }
    }

    // ③ 硬催化(政策/订单) - 综合业绩预告+分析师评级+调研热度判断
    // 5=明确未兑现硬催化, 3=催化偏弱, 2=无催化, 1=利空
    let hard_catalyst: number | null = null;

    // 3a. 业绩预告信号
    const recentForecast = forecast.filter(r => r.ann_date)
        .sort((a, b) => b.ann_date.localeCompare(a.ann_date)).slice(0, 3);
    let forecastSignal = 0; // -1=利空, 0=中性, 1=正面, 2=强正面
    if (recentForecast.length > 0) {
        const latestF = recentForecast[0];
        if (latestF.type === '预增' || latestF.type === '扭亏') forecastSignal = 2;
        else if (latestF.type === '略增' || latestF.type === '续盈') forecastSignal = 1;
        else if (latestF.type === '预减' || latestF.type === '首亏') forecastSignal = -1;
    }

    // 3b. 分析师评级信号
    let analystSignal = 0; // 0=无, 1=有买入评级
    if (analystRating.length > 0) {
        const buyKeywords = ['买入', '增持', '推荐', '强推', '强烈推荐'];
        const hasBuy = analystRating.some(r => buyKeywords.some(k => (r.rating || '').includes(k)));
        if (hasBuy) analystSignal = 1;
    }

    // 3c. 调研热度信号
    let visitSignal = 0; // 0=无, 1=有调研
    if (survival.length > 0) {
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 3);
        const threeMonthAgoStr = oneMonthAgo.toISOString().slice(0, 10).replace(/-/g, '');
        const recentVisits = survival.filter(r => r.visit_date && String(r.visit_date) >= threeMonthAgoStr);
        if (recentVisits.length >= 5) visitSignal = 1;
    }

    // 3d. 涨停催化信号（来自limit_list_ths，新增增强维度）
    let limitUpSignal = 0; // 0=无, 1=有涨停, 2=连板
    if (data.limitListThs) {
        // 从status字段解析连板数，格式如"4天4板"、"2天2板"、"首板"
        const statusStr = data.limitListThs.status || '';
        const boardMatch = statusStr.match(/(\d+)天(\d+)板/);
        const limitTimes = boardMatch ? parseInt(boardMatch[2]) : (statusStr.includes('首板') ? 1 : 0);
        if (limitTimes >= 2) limitUpSignal = 2;
        else if (limitTimes >= 1) limitUpSignal = 1;
    }

    // 综合判断
    const totalSignal = forecastSignal + analystSignal + visitSignal + limitUpSignal;
    if (totalSignal >= 4) hard_catalyst = 5;
    else if (totalSignal >= 3) hard_catalyst = 4;
    else if (totalSignal >= 1) hard_catalyst = 3;
    else if (totalSignal === 0) hard_catalyst = 2;
    else hard_catalyst = 1;

    return { research_visit_count, holder_change_rate, hard_catalyst };
}

/**
 * AI资讯分析打分注入点
 * 当AI资讯分析返回了指标打分时，会通过此函数注入到原始指标中
 */
let aiIndicatorScores: Record<string, Record<string, number>> = {};

export function setAiIndicatorScores(symbol: string, scores: Record<string, number>): void {
    aiIndicatorScores[symbol] = scores;
}

export function getAiIndicatorScores(symbol: string): Record<string, number> | null {
    return aiIndicatorScores[symbol] || null;
}

export function clearAiIndicatorScores(symbol: string): void {
    delete aiIndicatorScores[symbol];
}

/**
 * 计算单个指标的百分制评分
 */
function scoreIndicator(key: string, rawValue: number | string | null | undefined, aiScores?: Record<string, number> | null): number {
    // 优先使用AI资讯分析打分
    if (aiScores && aiScores[key] != null) {
        return Math.min(100, Math.max(0, Math.round(aiScores[key])));
    }

    if (rawValue === null || rawValue === undefined) {
        return DEFAULT_SCORE_WHEN_MISSING[key] ?? 50;
    }
    if (typeof rawValue === 'string') return DEFAULT_SCORE_WHEN_MISSING[key] ?? 50;

    const ranges = SCORE_MAPS[key];
    if (!ranges) return DEFAULT_SCORE_WHEN_MISSING[key] ?? 50;

    if (LOW_BETTER_KEYS.has(key)) {
        return Math.min(100, Math.max(0, scoreByRangeLowBetter(rawValue, ranges)));
    }
    return Math.min(100, Math.max(0, scoreByRange(rawValue, ranges)));
}

function scoreAllIndicators(raw: RawIndicators, aiScores?: Record<string, number> | null): Record<string, number> {
    const result: Record<string, number> = {};
    for (const dim of TENX_DIMS) {
        for (const ind of dim.indicators) {
            result[ind.key] = scoreIndicator(ind.key, raw[ind.key], aiScores);
        }
    }
    return result;
}

function calcDimScore(dim: DimDef, indScores: Record<string, number>): number {
    const scores = dim.indicators.map(ind => indScores[ind.key]);
    return Math.round(avg(scores));
}

function calcTotalScore(dimScores: number[]): number {
    let total = 0;
    for (let i = 0; i < TENX_DIMS.length; i++) {
        total += dimScores[i] * TENX_DIMS[i].weight / 100;
    }
    return Math.round(total * 10) / 10;
}

function getLabel(score: number): string {
    if (score >= 85) return 'S';
    if (score >= 75) return 'A';
    if (score >= 65) return 'B';
    if (score >= 55) return 'C';
    return 'D';
}

function getExpectedMultiple(score: number): string {
    if (score >= 85) return '5-10倍';
    if (score >= 75) return '3-5倍';
    if (score >= 65) return '2-3倍';
    if (score >= 55) return '1-2倍';
    return '<1倍';
}

function generateDescription(score: number, dimScores: number[], raw: RawIndicators): string {
    const dimNames = TENX_DIMS.map((d, i) => ({ name: d.name, score: dimScores[i] }));
    const strongest = dimNames.reduce((a, b) => a.score > b.score ? a : b);
    const weakest = dimNames.reduce((a, b) => a.score < b.score ? a : b);

    let text = '';
    text += `综合评分${score}分（${getLabel(score)}级），`;
    text += `最强维度"${strongest.name}"(${strongest.score}分)；`;
    text += `"${weakest.name}"偏弱(${weakest.score}分)。`;
    if (score >= 80) text += '整体具备十倍股核心特征，业绩爆发力与赛道景气度双轮驱动，建议持续跟踪催化剂落地节奏。';
    else if (score >= 60) text += '有亮点但存在短板，需等待关键催化因素验证，关注业绩加速与估值修复空间。';
    else text += '当前与十倍股样本差距较大，建议关注基本面拐点信号及赛道切换机会。';
    return text;
}

/**
 * 一票否决检查结果
 */
export interface VetoCheckResult {
    passed: boolean;
    reasons: string[];    // 否决原因列表
    avgAmount: number | null;  // 近20日日均成交额（千元）
    isSt: boolean;        // 是否ST
}

/** 近20日日均成交额阈值（千元）：3000万 = 300,000千元 */
const AVG_AMOUNT_THRESHOLD = 300000;

/**
 * 一票否决检查：流动性与生存底线
 * 条件：近20日日均成交额 > 3000万 且 非ST股
 */
export async function vetoCheck(symbol: string): Promise<VetoCheckResult> {
    const reasons: string[] = [];
    let avgAmount: number | null = null;
    let isSt = false;

    try {
        // 并行获取成交额和ST状态
        const [amountResult, stResult] = await Promise.allSettled([
            TushareService.getAvgAmount(symbol, 20),
            TushareService.getStStatus(symbol),
        ]);

        if (amountResult.status === 'fulfilled') {
            avgAmount = amountResult.value;
        }
        if (stResult.status === 'fulfilled') {
            isSt = stResult.value;
        }

        // 检查ST状态
        if (isSt) {
            reasons.push('该股票为ST/*ST股，存在退市风险，不符合十倍股基本生存条件');
        }

        // 检查日均成交额
        if (avgAmount !== null && avgAmount < AVG_AMOUNT_THRESHOLD) {
            const avgWan = (avgAmount / 100).toFixed(0); // 千元转万元
            reasons.push(`近20日日均成交额仅${avgWan}万元，低于3000万元阈值，机构资金无法有效进出`);
        } else if (avgAmount === null) {
            reasons.push('无法获取成交额数据，流动性无法确认');
        }

    } catch (e) {
        reasons.push('流动性数据获取失败，无法确认是否满足基本条件');
    }

    return {
        passed: reasons.length === 0,
        reasons,
        avgAmount,
        isSt,
    };
}

/** 一票否决错误 */
export class VetoError extends Error {
    symbol: string;
    reasons: string[];
    avgAmount: number | null;
    isSt: boolean;

    constructor(symbol: string, reasons: string[], avgAmount: number | null, isSt: boolean) {
        super(`十倍股否决: ${reasons.join('; ')}`);
        this.name = 'VetoError';
        this.symbol = symbol;
        this.reasons = reasons;
        this.avgAmount = avgAmount;
        this.isSt = isSt;
    }
}

export interface TenxScoreResult {
    score: number;
    label: string;
    expectedMultiple: string;
    description: string;
    aiConclusion: string;
    dimScores: number[];
    dimensions: { name: string; weight: number; score: number; indicators: { name: string; key: string; value: string; score: number }[] }[];
    rawData: PrefetchedData;
    updatedAt: string;
}

export class TenxScoreService {
    static async calculateTenxScore(symbol: string, industryCache?: IndustryCache, cachedStaticData?: any, skipVeto?: boolean): Promise<TenxScoreResult> {
        console.log(`[TenxScore] 开始计算 ${symbol} 十倍股评分 (v4 前瞻爆发版)`);

        // 一票否决检查（除非明确跳过）
        if (!skipVeto) {
            const veto = await vetoCheck(symbol);
            if (!veto.passed) {
                console.log(`[TenxScore] ${symbol} 未通过一票否决检查: ${veto.reasons.join('; ')}`);
                throw new VetoError(symbol, veto.reasons, veto.avgAmount, veto.isSt);
            }
        }

        let data: PrefetchedData;
        if (cachedStaticData) {
            data = await prefetchDynamicData(symbol, cachedStaticData);
        } else {
            data = await prefetchAllData(symbol);
        }

        // 获取AI资讯分析打分
        const aiScores = getAiIndicatorScores(symbol);

        // 计算各维度原始指标
        const rawEarnings = calcEarningsExplosion(data);
        const rawIndustry = await calcIndustryTrack(symbol, data, industryCache);
        const rawValuation = calcValuationElasticity(data);
        const rawProfit = calcProfitQuality(data);
        const rawMoat = calcCompetitiveMoat(data);
        const rawCatalyst = calcNewsCatalyst(data);

        const raw: RawIndicators = {
            ...rawEarnings,
            ...rawIndustry,
            ...rawValuation,
            ...rawProfit,
            ...rawMoat,
            ...rawCatalyst,
            stockName: data.industry?.industry_name,
        };

        // 计算所有指标百分制评分
        const indScores = scoreAllIndicators(raw, aiScores);

        // 计算维度评分
        const dimScores = TENX_DIMS.map(dim => calcDimScore(dim, indScores));

        // 计算总分
        const score = calcTotalScore(dimScores);

        // 生成标签和描述
        const label = getLabel(score);
        const expectedMultiple = getExpectedMultiple(score);
        const description = generateDescription(score, dimScores, raw);

        // 构建维度详情
        const dimensions = TENX_DIMS.map((dim, i) => ({
            name: dim.name,
            weight: dim.weight,
            score: dimScores[i],
            indicators: dim.indicators.map(ind => ({
                name: ind.name,
                key: ind.key,
                value: formatValue(ind.key, raw[ind.key]),
                score: indScores[ind.key],
            })),
        }));

        // AI结论
        let aiConclusion = '';
        try {
            const stockInfo = await TushareInfoService.getStockInfo(symbol);
            const stockName = stockInfo?.name || symbol;
            const strongDims = dimensions.filter(d => d.score >= 70).map(d => d.name);
            const weakDims = dimensions.filter(d => d.score < 50).map(d => d.name);
            aiConclusion = `${stockName}十倍股评分${score}分(${label}级)。`;
            if (strongDims.length > 0) aiConclusion += `优势维度：${strongDims.join('、')}。`;
            if (weakDims.length > 0) aiConclusion += `待改善：${weakDims.join('、')}。`;
            if (score >= 80) aiConclusion += '具备十倍股核心基因，建议重点跟踪。';
            else if (score >= 60) aiConclusion += '有潜力但需催化，关注基本面变化。';
            else aiConclusion += '当前十倍股特征不显著，需等待拐点。';
        } catch {
            aiConclusion = `十倍股评分${score}分(${label}级)。`;
        }

        // 清理AI打分缓存
        clearAiIndicatorScores(symbol);

        return {
            score,
            label,
            expectedMultiple,
            description,
            aiConclusion,
            dimScores,
            dimensions,
            rawData: data,
            updatedAt: new Date().toISOString(),
        };
    }
}
