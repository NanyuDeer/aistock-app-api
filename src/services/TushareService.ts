import { getStockIdentity } from '../utils/stock';
import { createThrottler } from '../utils/throttle';
import { sessionFetch } from '../utils/httpAgent';

const TUSHARE_MIN_INTERVAL_MS = 320;
const tushareThrottler = createThrottler(TUSHARE_MIN_INTERVAL_MS);

function toTsCode(symbol: string): string {
    const identity = getStockIdentity(symbol);
    return `${symbol}.${identity.market.toUpperCase()}`;
}

interface TushareResponse {
    request_id: string;
    code: number;
    msg: string;
    data: {
        fields: string[];
        items: any[][];
    };
}

export async function tushareRequest(
    apiName: string,
    params: Record<string, any>,
    requestedFields: string = '',
): Promise<Record<string, any>[]> {
    await tushareThrottler.throttle();

    const body = {
        api_name: apiName,
        token: process.env.TUSHARE_TOKEN,
        params,
        fields: requestedFields,
    };

    const response = await sessionFetch('https://api.tushare.pro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000), // 30秒超时
    });

    if (!response.ok) throw new Error(`Tushare ${apiName} HTTP错误: ${response.status}`);

    const json = await response.json() as TushareResponse;
    if (json.code !== 0) throw new Error(`Tushare ${apiName} 业务错误: ${json.msg}`);
    if (!json.data?.fields || !json.data?.items) return [];

    const { fields, items } = json.data;
    return items.map(row => {
        const obj: Record<string, any> = {};
        fields.forEach((f, i) => { obj[f] = row[i]; });
        return obj;
    });
}

export interface IncomeRow {
    ts_code: string; ann_date: string; end_date: string; report_type: string;
    total_revenue: number; n_income: number; n_income_attr_p: number;
    total_profit: number; int_exp: number; rd_exp: number;
    revenue_ps: number; basic_eps: number;
}

export async function getIncome(symbol: string, startDate?: string): Promise<IncomeRow[]> {
    const params: Record<string, any> = { ts_code: toTsCode(symbol) };
    if (startDate) params.start_date = startDate;
    const rows = await tushareRequest(
        'income',
        params,
        'ts_code,ann_date,end_date,report_type,total_revenue,n_income,n_income_attr_p,total_profit,int_exp,rd_exp,revenue_ps,basic_eps',
    );
    return rows as IncomeRow[];
}

export interface FinaIndicatorRow {
    ts_code: string; ann_date: string; end_date: string;
    roe: number; roic: number; grossprofit_margin: number;
    netprofit_margin: number; current_ratio: number; quick_ratio: number;
    debt_to_assets: number; ocfps: number; eps: number;
}

export async function getFinaIndicator(symbol: string, startDate?: string): Promise<FinaIndicatorRow[]> {
    const params: Record<string, any> = { ts_code: toTsCode(symbol) };
    if (startDate) params.start_date = startDate;
    const rows = await tushareRequest(
        'fina_indicator',
        params,
        'ts_code,ann_date,end_date,roe,roe_dt,roic,grossprofit_margin,netprofit_margin,current_ratio,quick_ratio,debt_to_assets,ocfps,eps',
    );
    return rows as FinaIndicatorRow[];
}

export interface CashflowRow {
    ts_code: string; ann_date: string; end_date: string;
    n_cashflow_act: number; c_pay_for_fix_assets: number;
}

export async function getCashflow(symbol: string, startDate?: string): Promise<CashflowRow[]> {
    const params: Record<string, any> = { ts_code: toTsCode(symbol) };
    if (startDate) params.start_date = startDate;
    const rows = await tushareRequest(
        'cashflow',
        params,
        'ts_code,ann_date,end_date,n_cashflow_act,c_pay_for_fix_assets',
    );
    return rows as CashflowRow[];
}

export interface BalanceSheetRow {
    ts_code: string; ann_date: string; end_date: string;
    contract_liab: number; total_assets: number; total_liab: number;
    intan_assets: number; goodwill: number; total_hldr_eqy_exc_min_int: number;
}

export async function getBalanceSheet(symbol: string, startDate?: string): Promise<BalanceSheetRow[]> {
    const params: Record<string, any> = { ts_code: toTsCode(symbol) };
    if (startDate) params.start_date = startDate;
    const rows = await tushareRequest(
        'balancesheet',
        params,
        'ts_code,ann_date,end_date,contract_liab,total_assets,total_liab,intan_assets,goodwill,total_hldr_eqy_exc_min_int',
    );
    return rows as BalanceSheetRow[];
}

export interface DailyBasicRow {
    ts_code: string; trade_date: string;
    pe: number; pb: number; ps: number;
    total_mv: number; circ_mv: number;
    turnover_rate: number;
}

export async function getDailyBasic(symbol: string, startDate: string): Promise<DailyBasicRow[]> {
    const rows = await tushareRequest(
        'daily_basic',
        {
            ts_code: toTsCode(symbol),
            start_date: startDate,
        },
        'ts_code,trade_date,pe,pb,ps,total_mv,circ_mv,turnover_rate',
    );
    return rows as DailyBasicRow[];
}

export interface DailyPriceRow {
    ts_code: string; trade_date: string;
    open: number; high: number; low: number; close: number;
    pre_close: number; change: number; pct_chg: number;
    vol: number; amount: number;
}

export async function getDailyPrices(symbol: string, startDate: string): Promise<DailyPriceRow[]> {
    const rows = await tushareRequest(
        'daily',
        {
            ts_code: toTsCode(symbol),
            start_date: startDate,
        },
        'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount',
    );
    return rows as DailyPriceRow[];
}

export interface DividendRow {
    ts_code: string; end_date: string; ann_date: string;
    div_proc: string; stk_div: number; stk_bo_rate: number;
    stk_co_rate: number; cash_div: number; cash_div_tax: number;
    record_date: string;
}

export async function getDividend(symbol: string): Promise<DividendRow[]> {
    const rows = await tushareRequest('dividend', { ts_code: toTsCode(symbol) });
    return rows as DividendRow[];
}

export interface HolderTradeRow {
    ts_code: string; ann_date: string; holder_name: string;
    holder_type: string; in_de: string; change_vol: number;
    change_ratio: number; after_share: number; after_ratio: number;
    avg_price: number; total_share: number;
}

export async function getStkHoldertrade(symbol: string, startDate?: string): Promise<HolderTradeRow[]> {
    const params: Record<string, any> = { ts_code: toTsCode(symbol) };
    if (startDate) params.start_date = startDate;
    const rows = await tushareRequest('stk_holdertrade', params);
    return rows as HolderTradeRow[];
}

export interface StkManagerRow {
    ts_code: string; ann_date: string; name: string;
    gender: string; lev: string; title: string; edu: string;
}

export async function getStkManagers(symbol: string): Promise<StkManagerRow[]> {
    const rows = await tushareRequest('stk_managers', { ts_code: toTsCode(symbol) });
    return rows as StkManagerRow[];
}

export interface Top10HolderRow {
    ts_code: string; ann_date: string; end_date: string;
    holder_name: string; hold_amount: number; hold_ratio: number;
    hold_float_ratio: number; holder_type: string;
}

export async function getTop10Holders(symbol: string, period?: string): Promise<Top10HolderRow[]> {
    const params: Record<string, any> = { ts_code: toTsCode(symbol) };
    if (period) params.period = period;
    const rows = await tushareRequest('top10_holders', params);
    return rows as Top10HolderRow[];
}

export interface PledgeRow {
    ts_code: string; end_date: string; pledge_count: number;
    unrest_pledge: number; rest_pledge: number;
    total_share: number; pledge_ratio: number;
}

export async function getPledgeDetail(symbol: string): Promise<PledgeRow[]> {
    const rows = await tushareRequest('pledge_stat', { ts_code: toTsCode(symbol) });
    return rows as PledgeRow[];
}

export interface IndexClassifyRow {
    index_code: string; industry_name: string; level: string;
}

export async function getIndexClassify(level: string = 'L1'): Promise<IndexClassifyRow[]> {
    const rows = await tushareRequest('index_classify', { level, src: 'SW2021' });
    return rows as IndexClassifyRow[];
}

export interface IndexMemberRow {
    index_code: string; con_code: string;
}

export async function getIndexMember(indexCode: string): Promise<string[]> {
    const rows = await tushareRequest('index_member', { index_code: indexCode });
    return (rows as IndexMemberRow[]).map(r => {
        const code = r.con_code || '';
        return code.split('.')[0];
    }).filter(c => c.length === 6);
}

export interface IndexDailyRow {
    ts_code: string; trade_date: string; close: number;
    pre_close: number; change: number; pct_chg: number;
    vol: number; amount: number; open: number; high: number; low: number;
}

export async function getIndexDaily(indexCode: string, startDate: string): Promise<IndexDailyRow[]> {
    const rows = await tushareRequest('index_daily', { ts_code: indexCode, start_date: startDate });
    return rows as IndexDailyRow[];
}

export interface StockIndustryRow {
    ts_code: string; industry_name: string; industry_code: string;
}

const SW_INDUSTRY_MAP: Record<string, string> = {
    '农林牧渔': '801010.SI', '种植业': '801010.SI', '渔业': '801010.SI', '饲料': '801010.SI', '农产品加工': '801010.SI',
    '基础化工': '801030.SI', '化学制品': '801030.SI', '化学原料': '801030.SI', '塑料': '801030.SI', '橡胶': '801030.SI', '农药': '801030.SI',
    '钢铁': '801040.SI', '普钢': '801040.SI', '特钢': '801040.SI',
    '有色金属': '801050.SI', '工业金属': '801050.SI', '贵金属': '801050.SI', '能源金属': '801050.SI',
    '电子': '801080.SI', '半导体': '801080.SI', '元件': '801080.SI', '光学光电子': '801080.SI', '消费电子': '801080.SI', '电子化学品': '801080.SI', '其他电子': '801080.SI',
    '家用电器': '801110.SI', '白色家电': '801110.SI', '黑色家电': '801110.SI', '小家电': '801110.SI', '照明设备': '801110.SI',
    '食品饮料': '801120.SI', '白酒': '801120.SI', '非白酒': '801120.SI', '饮料乳品': '801120.SI', '休闲食品': '801120.SI', '调味发酵品': '801120.SI',
    '纺织服饰': '801130.SI', '服装家纺': '801130.SI', '纺织制造': '801130.SI', '饰品': '801130.SI',
    '轻工制造': '801140.SI', '造纸': '801140.SI', '包装印刷': '801140.SI', '家居用品': '801140.SI', '文娱用品': '801140.SI',
    '医药生物': '801150.SI', '化学制药': '801150.SI', '中药': '801150.SI', '生物制品': '801150.SI', '医药商业': '801150.SI', '医疗器械': '801150.SI', '医疗服务': '801150.SI',
    '公用事业': '801160.SI', '电力': '801160.SI', '燃气': '801160.SI', '水务': '801160.SI',
    '交通运输': '801170.SI', '物流': '801170.SI', '港口': '801170.SI', '高速公路': '801170.SI', '机场': '801170.SI', '航空机场': '801170.SI', '铁路公路': '801170.SI',
    '房地产': '801180.SI', '房地产开发': '801180.SI', '房地产服务': '801180.SI',
    '商贸零售': '801200.SI', '一般零售': '801200.SI', '专业零售': '801200.SI', '贸易': '801200.SI', '互联网电商': '801200.SI',
    '社会服务': '801210.SI', '酒店餐饮': '801210.SI', '旅游及景区': '801210.SI', '教育': '801210.SI', '专业服务': '801210.SI',
    '银行': '801780.SI',
    '非银金融': '801790.SI', '证券': '801790.SI', '保险': '801790.SI', '多元金融': '801790.SI',
    '建筑材料': '801710.SI', '水泥': '801710.SI', '玻璃玻纤': '801710.SI', '装修建材': '801710.SI',
    '建筑装饰': '801720.SI', '房屋建设': '801720.SI', '装修装饰': '801720.SI', '基础建设': '801720.SI', '专业工程': '801720.SI', '园林工程': '801720.SI',
    '电力设备': '801730.SI', '电池': '801730.SI', '光伏设备': '801730.SI', '风电设备': '801730.SI', '电机': '801730.SI', '电网设备': '801730.SI',
    '机械设备': '801890.SI', '通用设备': '801890.SI', '专用设备': '801890.SI', '仪器仪表': '801890.SI', '自动化设备': '801890.SI',
    '国防军工': '801740.SI', '航空装备': '801740.SI', '航天装备': '801740.SI', '军工电子': '801740.SI', '地面兵装': '801740.SI', '航海装备': '801740.SI',
    '计算机': '801750.SI', '软件开发': '801750.SI', '计算机设备': '801750.SI', 'IT服务': '801750.SI',
    '传媒': '801760.SI', '游戏': '801760.SI', '广告营销': '801760.SI', '影视院线': '801760.SI', '数字媒体': '801760.SI', '出版': '801760.SI', '电视广播': '801760.SI',
    '通信': '801770.SI', '通信设备': '801770.SI', '通信服务': '801770.SI',
    '煤炭': '801950.SI', '焦炭': '801950.SI', '煤炭开采加工': '801950.SI',
    '石油石化': '801960.SI', '油气开采': '801960.SI', '炼化及贸易': '801960.SI', '油服工程': '801960.SI',
    '环保': '801970.SI',
    '美容护理': '801980.SI', '个护用品': '801980.SI', '化妆品': '801980.SI', '医疗美容': '801980.SI',
    '综合': '801230.SI',
    '汽车': '801880.SI', '乘用车': '801880.SI', '商用车': '801880.SI', '汽车零部件': '801880.SI', '摩托车': '801880.SI', '汽车服务': '801880.SI',
};

export async function getStockIndustry(symbol: string): Promise<StockIndustryRow | null> {
    const tsCode = toTsCode(symbol);
    try {
        const rows = await tushareRequest('stock_basic', { ts_code: tsCode }, 'ts_code,industry');
        if (rows.length > 0 && rows[0].industry) {
            const industryName = rows[0].industry as string;
            const industryCode = SW_INDUSTRY_MAP[industryName] || '';
            return { ts_code: tsCode, industry_name: industryName, industry_code: industryCode };
        }
    } catch {}
    try {
        const rows = await tushareRequest('concept', { src: 'SW', ts_code: tsCode });
        if (rows.length > 0) {
            return { ts_code: tsCode, industry_name: rows[0]?.name || '', industry_code: rows[0]?.code || '' };
        }
    } catch {}
    return null;
}

export async function getIndustryRevenueGrowth(indexCode: string): Promise<{
    totalRevenue: number; prevRevenue: number; growthRate: number;
}> {
    const members = await getIndexMember(indexCode);
    if (!members.length) return { totalRevenue: 0, prevRevenue: 0, growthRate: 0 };

    const sample = members.length > 30
        ? members.filter((_, i) => i % Math.ceil(members.length / 30) === 0)
        : members;

    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 3);
    const startDate = twoYearsAgo.toISOString().slice(0, 10).replace(/-/g, '');

    let totalRevenue = 0;
    let prevRevenue = 0;

    for (const sym of sample) {
        try {
            const income = await getIncome(sym, startDate);
            const annualReports = income
                .filter(r => r.end_date && r.end_date.endsWith('1231') && r.total_revenue)
                .sort((a, b) => b.end_date.localeCompare(a.end_date));
            if (annualReports.length >= 2) {
                totalRevenue += annualReports[0].total_revenue || 0;
                prevRevenue += annualReports[1].total_revenue || 0;
            }
        } catch {}
    }

    const growthRate = prevRevenue > 0 ? ((totalRevenue / prevRevenue) - 1) * 100 : 0;
    return { totalRevenue, prevRevenue, growthRate };
}

export interface HolderNumberRow {
    ts_code: string; ann_date: string; end_date: string; holder_num: number;
}

export async function getHolderNumber(symbol: string, startDate?: string): Promise<HolderNumberRow[]> {
    const params: Record<string, any> = { ts_code: toTsCode(symbol) };
    if (startDate) params.start_date = startDate;
    const rows = await tushareRequest(
        'stk_holdernumber',
        params,
        'ts_code,ann_date,end_date,holder_num',
    );
    return rows as HolderNumberRow[];
}

export interface ForecastRow {
    ts_code: string; ann_date: string; end_date: string;
    type: string; p_change_min: number; p_change_max: number;
    net_profit_min: number; net_profit_max: number;
    summary: string; change_reason: string;
}

export async function getForecast(symbol: string, startDate?: string): Promise<ForecastRow[]> {
    const params: Record<string, any> = { ts_code: toTsCode(symbol) };
    if (startDate) params.start_date = startDate;
    const rows = await tushareRequest(
        'forecast',
        params,
        'ts_code,ann_date,end_date,type,p_change_min,p_change_max,net_profit_min,net_profit_max,summary,change_reason',
    );
    return rows as ForecastRow[];
}

export interface StkSurvivalRow {
    ts_code: string; ann_date: string; visit_date: string;
    visitors: number; institution_name: string; institution_type: string;
}

export async function getStkSurvival(symbol: string, startDate?: string): Promise<StkSurvivalRow[]> {
    const params: Record<string, any> = { ts_code: toTsCode(symbol) };
    if (startDate) params.start_date = startDate;
    const rows = await tushareRequest(
        'stk_survival',
        params,
        'ts_code,ann_date,visit_date,visitors,institution_name,institution_type',
    );
    return rows as StkSurvivalRow[];
}

/**
 * 获取股票ST状态
 * 通过 daily_basic 接口的 is_st 字段判断
 */
export async function getStStatus(symbol: string, tradeDate?: string): Promise<boolean> {
    const params: Record<string, any> = { ts_code: toTsCode(symbol) };
    if (tradeDate) params.trade_date = tradeDate;
    const rows = await tushareRequest(
        'daily_basic',
        params,
        'ts_code,trade_date,is_st',
    );
    if (rows.length === 0) return false;
    // 取最新一条，is_st=1表示ST
    const latest = rows.sort((a, b) => String(b.trade_date).localeCompare(String(a.trade_date)))[0];
    return latest.is_st === 1;
}

/**
 * 获取近N日日均成交额（千元）
 * 返回 null 表示数据不足
 */
export async function getAvgAmount(symbol: string, days: number = 20): Promise<number | null> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days * 2); // 多取一些确保有足够交易日
    const startDateStr = startDate.toISOString().slice(0, 10).replace(/-/g, '');
    const rows = await tushareRequest(
        'daily',
        { ts_code: toTsCode(symbol), start_date: startDateStr },
        'ts_code,trade_date,amount',
    );
    if (rows.length === 0) return null;
    // 取最近N个交易日
    const sorted = rows.sort((a, b) => String(b.trade_date).localeCompare(String(a.trade_date)));
    const recent = sorted.slice(0, days);
    if (recent.length < Math.min(days, 10)) return null; // 至少10个交易日
    const totalAmount = recent.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    return totalAmount / recent.length;
}

/**
 * 获取机构持股比例（季度数据）
 * 通过 stk_holdertype 接口获取机构持股汇总
 */
export interface InstitutionalHoldRow {
    ts_code: string; ann_date: string; end_date: string;
    hold_ratio: number;  // 机构持股占流通股比例
}

export async function getInstitutionalHold(symbol: string, startDate?: string): Promise<InstitutionalHoldRow[]> {
    const tsCode = toTsCode(symbol);
    try {
        const params: Record<string, any> = { ts_code: tsCode };
        if (startDate) params.start_date = startDate;
        const rows = await tushareRequest(
            'stk_holdertype',
            params,
            'ts_code,ann_date,end_date,hold_ratio',
        );
        if (rows.length > 0) return rows as InstitutionalHoldRow[];
    } catch {}

    // 回退：尝试用cyq_perf（筹码分布）或f10 Holdings
    try {
        const params: Record<string, any> = { ts_code: tsCode };
        if (startDate) params.start_date = startDate;
        const rows = await tushareRequest(
            'stk_holdertype',
            { ...params, period: '1' },
            'ts_code,ann_date,end_date,hold_ratio',
        );
        if (rows.length > 0) return rows as InstitutionalHoldRow[];
    } catch {}

    return [];
}

/**
 * 获取北向资金持股（沪港通/深港通）
 */
export interface HkHoldRow {
    ts_code: string; trade_date: string; vol: number;
    amount: number; ratio: number; hold_change: number;
}

export async function getHkHold(symbol: string, startDate?: string): Promise<HkHoldRow[]> {
    // hk_hold接口优先用ts_code查询，如果失败则按trade_date查询最近数据
    const tsCode = toTsCode(symbol);
    try {
        const params: Record<string, any> = { ts_code: tsCode };
        if (startDate) params.start_date = startDate;
        const rows = await tushareRequest(
            'hk_hold',
            params,
            'ts_code,trade_date,vol,amount,ratio',
        );
        if (rows.length > 0) return rows as HkHoldRow[];
    } catch {}

    // 回退：按最近交易日查询，然后筛选该股票
    try {
        const today = new Date();
        const params: Record<string, any> = {};
        // 尝试最近几个交易日
        for (let i = 0; i < 5; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            // 跳过周末
            if (d.getDay() === 0 || d.getDay() === 6) continue;
            const tradeDate = d.toISOString().slice(0, 10).replace(/-/g, '');
            params.trade_date = tradeDate;
            const rows = await tushareRequest(
                'hk_hold',
                params,
                'ts_code,trade_date,vol,amount,ratio',
            );
            const filtered = rows.filter((r: any) => r.ts_code === tsCode);
            if (filtered.length > 0) return filtered as HkHoldRow[];
        }
    } catch {}

    return [];
}

/**
 * 获取分析师评级数据
 */
export interface AnalystRatingRow {
    ts_code: string; ann_date: string;
    org_name: string; rating: string;
}

export async function getAnalystRating(symbol: string, startDate?: string): Promise<AnalystRatingRow[]> {
    const tsCode = toTsCode(symbol);
    // 方式1：stk_analyst接口
    try {
        const params: Record<string, any> = { ts_code: tsCode };
        if (startDate) params.start_date = startDate;
        const rows = await tushareRequest(
            'stk_analyst',
            params,
            'ts_code,ann_date,org_name,rating',
        );
        if (rows.length > 0) return rows as AnalystRatingRow[];
    } catch {}

    // 方式2：broker_recommend接口（研报推荐）
    try {
        const params: Record<string, any> = { ts_code: tsCode };
        if (startDate) params.start_date = startDate;
        const rows = await tushareRequest(
            'broker_recommend',
            params,
            'ts_code,ann_date,org_name,rating',
        );
        if (rows.length > 0) return rows as AnalystRatingRow[];
    } catch {}

    // 方式3：news_content接口（新闻/研报标题）
    try {
        const params: Record<string, any> = { ts_code: tsCode };
        if (startDate) params.start_date = startDate;
        const rows = await tushareRequest(
            'major_news',
            params,
            'ts_code,ann_date,org_name,rating',
        );
        if (rows.length > 0) return rows as AnalystRatingRow[];
    } catch {}

    return [];
}

// ==================== 风口爆发股专用接口 ====================

export interface MoneyflowRow {
    ts_code: string; trade_date: string;
    buy_sm_amount: number; sell_sm_amount: number;
    buy_md_amount: number; sell_md_amount: number;
    buy_lg_amount: number; sell_lg_amount: number;
    buy_elg_amount: number; sell_elg_amount: number;
    net_mf_amount: number;  // 净流入额（万元）
}

/** 获取个股资金流向 */
export async function getMoneyflow(symbol: string, startDate?: string, endDate?: string): Promise<MoneyflowRow[]> {
    const params: Record<string, any> = { ts_code: toTsCode(symbol) };
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;
    const rows = await tushareRequest(
        'moneyflow',
        params,
        'ts_code,trade_date,buy_sm_amount,sell_sm_amount,buy_md_amount,sell_md_amount,buy_lg_amount,sell_lg_amount,buy_elg_amount,sell_elg_amount,net_mf_amount',
    );
    return rows as MoneyflowRow[];
}

/** 获取单日全市场资金流向（用于批量选股） */
export async function getMoneyflowByDate(tradeDate: string): Promise<MoneyflowRow[]> {
    const rows = await tushareRequest(
        'moneyflow',
        { trade_date: tradeDate },
        'ts_code,trade_date,buy_lg_amount,sell_lg_amount,buy_elg_amount,sell_elg_amount,net_mf_amount',
    );
    return rows as MoneyflowRow[];
}

export interface DailyBasicFullRow {
    ts_code: string; trade_date: string;
    close: number; turnover_rate: number; turnover_rate_f: number;
    volume_ratio: number; pe: number; pe_ttm: number;
    pb: number; ps: number; ps_ttm: number;
    total_share: number; float_share: number; free_share: number;
    total_mv: number; circ_mv: number;
}

/** 获取单日全市场每日指标（用于批量选股） */
export async function getDailyBasicByDate(tradeDate: string): Promise<DailyBasicFullRow[]> {
    const rows = await tushareRequest(
        'daily_basic',
        { trade_date: tradeDate },
        'ts_code,trade_date,close,turnover_rate,turnover_rate_f,volume_ratio,pe,pe_ttm,pb,ps,ps_ttm,total_share,float_share,free_share,total_mv,circ_mv',
    );
    return rows as DailyBasicFullRow[];
}

/** 获取个股近N日日线行情（用于计算连续上涨天数等） */
export async function getStockDailyRecent(symbol: string, days: number = 10): Promise<DailyPriceRow[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days * 2);
    const startDateStr = startDate.toISOString().slice(0, 10).replace(/-/g, '');
    const rows = await tushareRequest(
        'daily',
        { ts_code: toTsCode(symbol), start_date: startDateStr },
        'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount',
    );
    // 取最近N个交易日
    const sorted = rows.sort((a, b) => String(b.trade_date).localeCompare(String(a.trade_date)));
    return sorted.slice(0, days) as DailyPriceRow[];
}

// ==================== 同花顺板块指数接口 ====================

export interface ThsIndexRow {
    ts_code: string;
    name: string;
    count: number;
    exchange: string;
    list_date: string;
    type: string;
}

/** 获取同花顺概念/行业指数列表 */
export async function getThsIndex(type: string = 'N', exchange: string = 'A'): Promise<ThsIndexRow[]> {
    const rows = await tushareRequest(
        'ths_index',
        { type, exchange },
        'ts_code,name,count,exchange,list_date,type',
    );
    return rows as ThsIndexRow[];
}

export interface ThsDailyRow {
    ts_code: string;
    trade_date: string;
    close: number;
    open: number;
    high: number;
    low: number;
    pre_close: number;
    change: number;
    pct_change: number;
    vol: number;
    turnover_rate: number;
    total_mv?: number;
    float_mv?: number;
}

/** 获取同花顺板块指数日线行情 */
export async function getThsDaily(tsCode: string, startDate: string, endDate?: string): Promise<ThsDailyRow[]> {
    const params: Record<string, any> = { ts_code: tsCode, start_date: startDate };
    if (endDate) params.end_date = endDate;
    const rows = await tushareRequest(
        'ths_daily',
        params,
        'ts_code,trade_date,close,open,high,low,pre_close,change,pct_change,vol,turnover_rate',
    );
    return rows as ThsDailyRow[];
}

export interface ThsMemberRow {
    ts_code: string;
    con_code: string;
    con_name: string;
    is_new: string;
}

/** 获取概念板块成分股列表 */
export async function getThsMember(tsCode: string): Promise<ThsMemberRow[]> {
    const rows = await tushareRequest(
        'ths_member',
        { ts_code: tsCode },
        'ts_code,con_code,con_name,is_new',
    );
    return rows as ThsMemberRow[];
}

/** 按交易日期获取全市场股票日线行情（用于批量获取成分股涨幅）
 * 频率限制：500次/分钟，单次最大5000行
 */
export async function getDailyByDate(tradeDate: string): Promise<DailyPriceRow[]> {
    const rows = await tushareRequest(
        'daily',
        { trade_date: tradeDate },
        'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount',
    );
    return rows as DailyPriceRow[];
}

// ==================== 打板专题 & THS增强接口 ====================

/** 涨停板块统计 - 每天涨停股最多的概念板块 */
export interface LimitCptListRow {
    trade_date: string;       // 交易日期
    ts_code: string;          // 概念代码
    name: string;             // 概念名称
    up_stat: string;          // 涨跌统计 涨/平/跌
    limit_times: number;      // 涨停家数
    con_up_stat: string;      // 连板统计 连板/涨停
    up_type: string;          // 涨停类型
    limit: number;            // 涨停数量
}

/** 获取涨停板块统计（替代同花顺概念涨幅排序爬虫）
 * 频率限制：500次/分钟，单次最大2000行
 */
export async function getLimitCptList(tradeDate: string): Promise<LimitCptListRow[]> {
    const rows = await tushareRequest(
        'limit_cpt_list',
        { trade_date: tradeDate },
        'trade_date,ts_code,name,up_stat,limit_times,con_up_stat,up_type,limit',
    );
    return rows as LimitCptListRow[];
}

/** 同花顺热榜 */
export interface ThsHotRow {
    ts_code: string;          // 代码
    ts_name: string;          // 名称
    data_type: string;        // 数据类型
    rank: number;             // 排行
    pct_change: number;       // 涨跌幅%
    current_price: number;    // 当前价格
    concept: string;          // 标签（JSON数组字符串，如 '["钠离子电池", "同花顺漂亮100"]'）
    rank_reason: string;      // 上榜解读
    hot: number;              // 热度值
    rank_time: string;        // 排行榜获取时间
    trade_date: string;       // 交易日期
}

/** 获取同花顺热榜数据
 * market: 热股/ETF/可转债/行业板块/概念板块/期货/港股/热基/美股
 * 频率限制：2000条/次，需6000积分
 */
export async function getThsHot(tradeDate: string, market?: string): Promise<ThsHotRow[]> {
    const params: Record<string, any> = { trade_date: tradeDate, is_new: 'Y' };
    if (market) params.market = market;
    const rows = await tushareRequest(
        'ths_hot',
        params,
        'ts_code,ts_name,data_type,rank,pct_change,current_price,concept,rank_reason,hot,rank_time,trade_date',
    );
    return rows as ThsHotRow[];
}

/** 涨跌停板块 - 涨停池/连板池/炸板池 */
export interface LimitListThsRow {
    trade_date: string;           // 交易日期
    ts_code: string;              // 股票代码
    name: string;                 // 股票名称
    price: number;                // 收盘价(元)
    pct_chg: number;              // 涨跌幅%
    open_num: number;             // 打开次数
    lu_desc: string;              // 涨停原因
    limit_type: string;           // 板单类别
    tag: string;                  // 涨停标签
    status: string;               // 涨停状态（如"N天N板"、"一字板"、"换手板"）
    first_lu_time: string;        // 首次涨停时间
    last_lu_time: string;         // 最后涨停时间
    limit_order: number;          // 封单量(元)
    limit_amount: number;         // 封单额(元)
    turnover_rate: number;        // 换手率%
    free_float: number;           // 实际流通(元)
    lu_limit_order: number;       // 最大封单(元)
    limit_up_suc_rate: number;    // 近一年涨停封板率
    turnover: number;             // 成交额
    rise_rate: number;            // 涨速
    sum_float: number;            // 总市值（亿元）
    market_type: string;          // 股票类型：HS/GEM/STAR
}

/** 获取涨跌停榜单
 * limit_type: '涨停池'|'连板池'|'炸板池'|'跌停池'
 * 频率限制：500次/分钟，单次最大4000条，需8000积分
 */
export async function getLimitListThs(tradeDate: string, limitType?: string): Promise<LimitListThsRow[]> {
    const params: Record<string, any> = { trade_date: tradeDate };
    if (limitType) params.limit_type = limitType;
    const rows = await tushareRequest(
        'limit_list_ths',
        params,
        'trade_date,ts_code,name,price,pct_chg,open_num,lu_desc,limit_type,tag,status,first_lu_time,last_lu_time,limit_order,limit_amount,turnover_rate,free_float,lu_limit_order,limit_up_suc_rate,turnover,rise_rate,sum_float,market_type',
    );
    return rows as LimitListThsRow[];
}

/** 连板天梯 */
export interface LimitStepRow {
    trade_date: string;       // 交易日期
    ts_code: string;          // 股票代码
    name: string;             // 股票名称
    close: number;            // 收盘价
    pct_chg: number;          // 涨跌幅
    limit_times: number;      // 连板数
    up_stat: string;          // 涨跌统计
    con_tag: string;          // 概念标签
}

/** 获取连板天梯
 * 频率限制：500次/分钟，单次最大2000行
 */
export async function getLimitStep(tradeDate: string): Promise<LimitStepRow[]> {
    const rows = await tushareRequest(
        'limit_step',
        { trade_date: tradeDate },
        'trade_date,ts_code,name,close,pct_chg,limit_times,up_stat,con_tag',
    );
    return rows as LimitStepRow[];
}

/** 同花顺概念板块资金流向 */
export interface MoneyflowCntThsRow {
    trade_date: string;       // 交易日期
    ts_code: string;          // 概念代码（如885748.TI）
    name: string;             // 概念名称
    lead_stock: string;       // 领涨股票名称
    close_price: number;      // 最新价
    pct_change: number;       // 行业涨跌幅
    industry_index: number;   // 板块指数点位
    company_num: number;      // 公司数量
    pct_change_stock: number; // 领涨股涨跌幅
    net_buy_amount: number;   // 流入资金（亿元）
    net_sell_amount: number;  // 流出资金（亿元）
    net_amount: number;       // 净额（亿元）
}

/** 获取概念板块资金流向
 * 频率限制：5000条/次
 * 需要6000积分
 */
export async function getMoneyflowCntThs(tradeDate: string): Promise<MoneyflowCntThsRow[]> {
    const rows = await tushareRequest(
        'moneyflow_cnt_ths',
        { trade_date: tradeDate },
        'trade_date,ts_code,name,lead_stock,close_price,pct_change,industry_index,company_num,pct_change_stock,net_buy_amount,net_sell_amount,net_amount',
    );
    return rows as MoneyflowCntThsRow[];
}

/** 同花顺个股资金流向（增强版） */
export interface MoneyflowThsRow {
    ts_code: string;          // 股票代码
    trade_date: string;       // 交易日期
    buy_sm_amount: number;    // 小单买入（万元）
    buy_md_amount: number;    // 中单买入（万元）
    buy_lg_amount: number;    // 大单买入（万元）
    buy_elg_amount: number;   // 特大单买入（万元）
    sell_sm_amount: number;   // 小单卖出（万元）
    sell_md_amount: number;   // 中单卖出（万元）
    sell_lg_amount: number;   // 大单卖出（万元）
    sell_elg_amount: number;  // 特大单卖出（万元）
    net_mf_amount: number;    // 净流入（万元）
    net_mf_vol: number;       // 净流入量（手）
    buy_sm_ratio: number;     // 小单买入占比
    buy_md_ratio: number;     // 中单买入占比
    buy_lg_ratio: number;     // 大单买入占比
    buy_elg_ratio: number;    // 特大单买入占比
    sell_sm_ratio: number;    // 小单卖出占比
    sell_md_ratio: number;    // 中单卖出占比
    sell_lg_ratio: number;    // 大单卖出占比
    sell_elg_ratio: number;   // 特大单卖出占比
    net_mf_ratio: number;     // 净流入占比
    mf_5day: number;          // 5日主力净额（万元）
}

/** 获取同花顺个股资金流向（增强版，替代moneyflow）
 * 频率限制：6000条/次
 * 注意：按ts_code查询时单次返回1条，按trade_date查询返回全市场
 */
export async function getMoneyflowThs(tsCode: string, startDate?: string, endDate?: string): Promise<MoneyflowThsRow[]> {
    const params: Record<string, any> = { ts_code: tsCode };
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;
    const rows = await tushareRequest(
        'moneyflow_ths',
        params,
        'ts_code,trade_date,buy_sm_amount,buy_md_amount,buy_lg_amount,buy_elg_amount,sell_sm_amount,sell_md_amount,sell_lg_amount,sell_elg_amount,net_mf_amount,net_mf_vol,buy_sm_ratio,buy_md_ratio,buy_lg_ratio,buy_elg_ratio,sell_sm_ratio,sell_md_ratio,sell_lg_ratio,sell_elg_ratio,net_mf_ratio,mf_5day',
    );
    return rows as MoneyflowThsRow[];
}

/** 获取单日全市场同花顺资金流向（用于批量选股） */
export async function getMoneyflowThsByDate(tradeDate: string): Promise<MoneyflowThsRow[]> {
    const rows = await tushareRequest(
        'moneyflow_ths',
        { trade_date: tradeDate },
        'ts_code,trade_date,buy_lg_amount,buy_elg_amount,sell_lg_amount,sell_elg_amount,net_mf_amount,net_mf_ratio,mf_5day',
    );
    return rows as MoneyflowThsRow[];
}

/** 开盘啦概念题材成分股 */
export interface StockCompanyRow {
    ts_code: string;              // 股票代码
    exchange: string;             // 交易所 SSE SZSE BSE
    chairman: string;             // 法人代表
    manager: string;              // 总经理
    secretary: string;            // 董秘
    reg_capital: number;          // 注册资本
    setup_date: string;           // 注册日期
    province: string;             // 所在省份
    city: string;                 // 所在城市
    introduction: string;         // 公司介绍
    main_business: string;        // 主要业务及产品
    website: string;              // 公司网站
    employees: number;            // 员工人数
    com_name: string;             // 公司名称
}

/** 获取上市公司基本信息（含公司介绍、主营业务）
 * 积分要求：120，频率限制：单次最大4500条
 */
export async function getStockCompany(tsCode: string): Promise<StockCompanyRow | null> {
    const rows = await tushareRequest(
        'stock_company',
        { ts_code: tsCode },
        'ts_code,exchange,chairman,manager,secretary,reg_capital,setup_date,province,city,introduction,main_business,website,employees,com_name',
    );
    return rows.length > 0 ? rows[0] as StockCompanyRow : null;
}

export interface KplConceptConsRow {
    ts_code: string;          // 题材ID（如 000111.KP）
    name: string;             // 题材名称
    con_code: string;         // 股票代码（如 600657.SH）
    con_name: string;         // 股票名称
    trade_date: string;       // 交易日期
    hot_num: number;          // 人气值
    desc: string;             // 描述
}

/** 获取开盘啦概念题材成分股
 * 支持三种查询方式：
 *   - trade_date: 按日期获取所有概念成分股
 *   - ts_code: 按概念代码获取成分股（xxxxxx.KP格式）
 *   - con_code: 按股票代码获取所属概念（xxxxxx.SH格式）
 * 频率限制：3000条/次
 */
export async function getKplConceptCons(params: { con_code?: string; ts_code?: string; trade_date?: string }): Promise<KplConceptConsRow[]> {
    const rows = await tushareRequest(
        'kpl_concept_cons',
        params,
        'ts_code,name,con_code,con_name,trade_date,hot_num,desc',
    );
    return rows as KplConceptConsRow[];
}

/** 卖方盈利预测数据 - report_rc */
export interface ReportRcRow {
    ts_code: string;
    name: string;
    report_date: string;
    report_title: string;
    report_type: string;
    classify: string;
    org_name: string;
    author_name: string;
    quarter: string;
    op_rt: number | null;
    op_pr: number | null;
    tp: number | null;
    np: number | null;
    eps: number | null;
    pe: number | null;
    rating: string;
}

/**
 * 获取卖方盈利预测数据
 * 可按 report_date 查询某天所有股票的盈利预测
 * 需要Tushare 8000积分权限
 */
export async function getReportRc(params: { ts_code?: string; report_date?: string; start_date?: string; end_date?: string }): Promise<ReportRcRow[]> {
    const rows = await tushareRequest(
        'report_rc',
        params,
        'ts_code,name,report_date,report_title,report_type,classify,org_name,author_name,quarter,op_rt,op_pr,tp,np,eps,pe,rating',
    );
    return rows as ReportRcRow[];
}
