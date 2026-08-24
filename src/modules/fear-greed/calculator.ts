/**
 * 韭圈儿（funddb）风格 A 股恐贪指数 —— 6 个子指标计算。
 * 从 Python 版 fear-greed（indices/jq.py）翻译，指标口径与 tushare 调用保持一致。
 * 通过 TushareClient / BreadthCache 依赖注入，便于单元测试。
 */
import {
    clamp,
    labelOf,
    levelOf,
    pctRankOrNeutral,
    percentileRank,
    sparkline,
} from './indicators';

/** tushare 客户端抽象（生产用 TushareService.tushareRequest） */
export interface TushareClient {
    request(apiName: string, params: Record<string, unknown>, fields?: string): Promise<Record<string, unknown>[]>;
}

/** breadth 指标逐日缓存（PG 表 breadth_daily） */
export interface BreadthCache {
    getAll(): Promise<Map<string, number>>;
    upsert(rows: { tradeDate: string; upRatio: number }[]): Promise<void>;
}

export interface JqIndicator {
    key: string;
    name: string;
    desc: string;
    score: number;
    raw: number;
    label: string;
    history: { dates: string[]; scores: number[] };
    excluded?: boolean;
}

export interface JqResult {
    key: string;
    name: string;
    composite: number;
    label: string;
    history: { dates: string[]; scores: number[] };
    indicators: JqIndicator[];
}

const HIST = 500;   // 历史回看窗口（交易日，支持近两年百分位）
const SPARK = 500;  // 折线图历史窗口（交易日）
const NEUTRAL = { score: 50, raw: 0, label: '中性', history: { dates: [], scores: [] } };

/** YYYYMMDD（上海时区，服务端已设 TZ=Asia/Shanghai） */
function todayYyyymmdd(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

function daysAgoYyyymmdd(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

/** 最近 n 个交易日（YYYYMMDD，升序） */
async function tradeDates(client: TushareClient, n: number): Promise<string[]> {
    const end = todayYyyymmdd();
    const start = daysAgoYyyymmdd(n * 2 + 30);
    const rows = await client.request('trade_cal', { start_date: start, end_date: end }, 'cal_date,is_open');
    const dates = rows.filter((r) => r.is_open === 1).map((r) => String(r.cal_date));
    dates.sort();
    return dates.slice(-n);
}

/** 指数/基金日线（升序，近 days 个交易日） */
async function indexDaily(client: TushareClient, tsCode: string, days: number): Promise<Record<string, unknown>[]> {
    const dates = await tradeDates(client, days);
    const rows = await client.request(
        'index_daily',
        { ts_code: tsCode, start_date: dates[0], end_date: dates[dates.length - 1] },
        'trade_date,close',
    );
    rows.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
    return rows;
}

/** 波动率：50ETF 近 20 日年化波动率；波动越低越贪婪（方向反转） */
async function volatility(client: TushareClient): Promise<JqIndicator> {
    const dates = await tradeDates(client, HIST + 20);
    const rows = await client.request(
        'fund_daily',
        { ts_code: '510050.SH', start_date: dates[0], end_date: dates[dates.length - 1] },
        'trade_date,close',
    );
    rows.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
    const closes = rows.map((r) => Number(r.close));

    const vols: number[] = [];
    for (let i = 20; i < closes.length; i++) {
        const rets: number[] = [];
        for (let j = i - 19; j <= i; j++) {
            rets.push(closes[j] / closes[j - 1] - 1);
        }
        const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
        const variance = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1);
        vols.push(Math.sqrt(variance) * Math.sqrt(252));
    }
    if (vols.length < 2) return { key: 'volatility', name: '指数波动', desc: '50ETF 年化波动率，反映市场对波动的预期', ...NEUTRAL };
    const current = vols[vols.length - 1];
    const score = Math.round((100 - pctRankOrNeutral(vols.slice(0, -1), current)) * 100) / 100;
    return {
        key: 'volatility',
        name: '指数波动',
        desc: '50ETF 年化波动率，反映市场对波动的预期',
        score,
        raw: Math.round(current * 10000) / 100,
        label: levelOf(score),
        history: sparkline(vols, dates, SPARK, true),
    };
}

/** 北向资金：净流入相对 20 日均线偏离度；流入多 → 贪婪 */
async function northFlow(client: TushareClient): Promise<JqIndicator> {
    const dates = await tradeDates(client, HIST + 20);
    const rows = await client.request(
        'moneyflow_hsgt',
        { start_date: dates[0], end_date: dates[dates.length - 1] },
        'trade_date,north_money',
    );
    rows.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
    const values = rows.map((r) => Number(r.north_money ?? 0));
    if (values.length < 21) return { key: 'north_flow', name: '北上资金', desc: '陆股通净流入偏离度，反映外资态度', ...NEUTRAL };

    const devs: number[] = [];
    for (let i = 20; i < values.length; i++) {
        const ma = values.slice(i - 20, i).reduce((s, v) => s + v, 0) / 20;
        devs.push(ma !== 0 ? (values[i] - ma) / Math.abs(ma) : 0);
    }
    const current = devs[devs.length - 1];
    const score = Math.round(pctRankOrNeutral(devs.slice(0, -1), current) * 100) / 100;
    return {
        key: 'north_flow',
        name: '北上资金',
        desc: '陆股通净流入偏离度，反映外资态度',
        score,
        raw: Math.round(current * 10000) / 100,
        label: levelOf(score),
        history: sparkline(devs, dates.slice(20), SPARK),
    };
}

/** 沪深300 最新成分股代码列表 */
async function hs300Members(client: TushareClient): Promise<string[]> {
    const rows = await client.request('index_weight', { index_code: '000300.SH' }, 'con_code,trade_date');
    if (!rows.length) return [];
    const latest = rows.reduce((mx, r) => (String(r.trade_date) > mx ? String(r.trade_date) : mx), '');
    return [...new Set(rows.filter((r) => String(r.trade_date) === latest).map((r) => String(r.con_code)))].sort();
}

/** 市场宽度：沪深300 成分股上涨家数占比（增量缓存到 breadth_daily 表） */
async function breadth(client: TushareClient, cache: BreadthCache): Promise<JqIndicator> {
    const dates = await tradeDates(client, SPARK); // 升序
    const start = dates[0];
    const end = dates[dates.length - 1];

    const cached = await cache.getAll();
    const missing = dates.filter((d) => !cached.has(d));

    if (missing.length > 0) {
        const members = await hs300Members(client);
        if (!members.length) return { key: 'breadth', name: '股价强度', desc: '上涨家数占比，反映市场宽度', ...NEUTRAL };

        const up = new Map<string, number>();
        const total = new Map<string, number>();
        const batchSize = 20; // 20 只 × 约 500 交易日 ≈ 1 万行，低于 daily 单次上限
        for (let i = 0; i < members.length; i += batchSize) {
            const batch = members.slice(i, i + batchSize).join(',');
            const rows = await client.request(
                'daily',
                { ts_code: batch, start_date: start, end_date: end },
                'ts_code,trade_date,pct_chg',
            );
            for (const r of rows) {
                const d = String(r.trade_date);
                const p = Number(r.pct_chg ?? 0);
                total.set(d, (total.get(d) ?? 0) + 1);
                if (p > 0) up.set(d, (up.get(d) ?? 0) + 1);
            }
        }

        const newRows: { tradeDate: string; upRatio: number }[] = [];
        for (const d of missing) {
            const ratio = total.get(d) ? (up.get(d) ?? 0) / total.get(d)! * 100 : 50;
            cached.set(d, ratio);
            newRows.push({ tradeDate: d, upRatio: ratio });
        }
        await cache.upsert(newRows);
    }

    const ordered = dates.map((d) => Math.round(clamp(cached.get(d) ?? 50) * 100) / 100);
    const current = ordered[ordered.length - 1];
    return {
        key: 'breadth',
        name: '股价强度',
        desc: '上涨家数占比，反映市场宽度',
        score: current,
        raw: Math.round((cached.get(dates[dates.length - 1]) ?? 50) * 100) / 100,
        label: levelOf(current),
        history: { dates: dates.slice().reverse(), scores: ordered.slice().reverse() },
    };
}

/** 沪深300 股指期货升贴水率；升水 → 看多（贪婪） */
async function futuresBasis(client: TushareClient): Promise<JqIndicator> {
    const dates = await tradeDates(client, HIST);
    const fut = await client.request(
        'fut_daily',
        { ts_code: 'IF.CFX', start_date: dates[0], end_date: dates[dates.length - 1] },
        'trade_date,close',
    );
    const spot = await indexDaily(client, '000300.SH', HIST);
    fut.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
    const spotMap = new Map(spot.map((r) => [String(r.trade_date), Number(r.close)]));

    const basis: number[] = [];
    const basisDates: string[] = [];
    for (const r of fut) {
        const d = String(r.trade_date);
        const sp = spotMap.get(d);
        if (sp !== undefined && sp !== 0) {
            basis.push((Number(r.close) - sp) / sp);
            basisDates.push(d);
        }
    }
    if (basis.length < 2) return { key: 'futures', name: '升贴水率', desc: '沪深300 股指期货升贴水，反映期货预期', ...NEUTRAL };
    const current = basis[basis.length - 1];
    const score = Math.round(pctRankOrNeutral(basis.slice(0, -1), current) * 100) / 100;
    return {
        key: 'futures',
        name: '升贴水率',
        desc: '沪深300 股指期货升贴水，反映期货预期',
        score,
        raw: Math.round(current * 10000) / 100,
        label: levelOf(score),
        history: sparkline(basis, basisDates, SPARK),
    };
}

/** 股债回报差（近 20 日沪深300 回报 - 国债指数回报）；正 → 股票强 */
async function equityBond(client: TushareClient): Promise<JqIndicator> {
    const stock = await indexDaily(client, '000300.SH', HIST + 20);
    const bond = await indexDaily(client, '000012.SH', HIST + 20);
    const stockMap = new Map(stock.map((r) => [String(r.trade_date), Number(r.close)]));
    const bondMap = new Map(bond.map((r) => [String(r.trade_date), Number(r.close)]));

    const common = [...stockMap.keys()].filter((d) => bondMap.has(d)).sort();
    const spreads: number[] = [];
    const spreadDates: string[] = [];
    for (let i = 20; i < common.length; i++) {
        const sRet = stockMap.get(common[i])! / stockMap.get(common[i - 20])! - 1;
        const bRet = bondMap.get(common[i])! / bondMap.get(common[i - 20])! - 1;
        spreads.push(sRet - bRet);
        spreadDates.push(common[i]);
    }
    if (spreads.length < 2) return { key: 'equity_bond', name: '避险天堂', desc: '股债回报差，反映风险偏好', ...NEUTRAL };
    const current = spreads[spreads.length - 1];
    const score = Math.round(pctRankOrNeutral(spreads.slice(0, -1), current) * 100) / 100;
    return {
        key: 'equity_bond',
        name: '避险天堂',
        desc: '股债回报差，反映风险偏好',
        score,
        raw: Math.round(current * 10000) / 100,
        label: levelOf(score),
        history: sparkline(spreads, spreadDates, SPARK),
    };
}

// ===== 涨跌停微观结构指标 =====

/**
 * 每日涨跌停聚合数据。
 * 数据来源：Tushare `daily` 全市场按日推导（涨停=收盘达涨停价、炸板=触板未封、跌停=收盘达跌停价），
 * 替代 `limit_list_d`（该接口的 limit_status 字段需 2000 积分，当前账号被置空）。
 */
export interface DailyLimit {
    date: string;
    sealCount: number;   // 涨停封板数
    breakCount: number;  // 炸板数
    downCount: number;   // 跌停数
    maxStreak: number;   // 最高连板数（由封板序列回放计算）
    sealCodes: string[]; // 当日封板 ts_code 列表（连板回放用，落库缓存字段）
}

/** limit 指标逐日缓存（PG 表 limit_daily） */
export interface LimitCache {
    getAll(): Promise<Map<string, DailyLimit>>;
    upsert(rows: DailyLimit[]): Promise<void>;
}

/** 板块涨跌停幅度（不含 ST 的 5%，近似处理：ST 涨停会被漏计，占比小可接受） */
function limitCapOf(tsCode: string): number {
    // 创业板 300/301、科创板 688/689 → 20%
    if (tsCode.startsWith('300') || tsCode.startsWith('301')
        || tsCode.startsWith('688') || tsCode.startsWith('689')) return 0.2;
    // 北交所 43/83/87/88/92 → 30%
    if (tsCode.startsWith('8') || tsCode.startsWith('4')) return 0.3;
    return 0.1;
}

function round2(v: number): number {
    return Math.round(v * 100) / 100;
}

/** 从 daily 全市场数据推导某交易日的涨跌停聚合 */
async function deriveDailyLimit(client: TushareClient, date: string): Promise<DailyLimit> {
    const rows = await client.request(
        'daily',
        { trade_date: date },
        'ts_code,pre_close,close,high',
    );
    let seal = 0, broken = 0, down = 0;
    const sealCodes: string[] = [];
    for (const r of rows) {
        const tsCode = String(r.ts_code);
        const pre = Number(r.pre_close ?? 0);
        const close = Number(r.close ?? 0);
        const high = Number(r.high ?? 0);
        if (pre <= 0) continue;
        const cap = limitCapOf(tsCode);
        const limitUp = round2(pre * (1 + cap));
        const limitDown = round2(pre * (1 - cap));
        // 收盘达涨停价 → 封板；盘中触板但未封 → 炸板；收盘达跌停价 → 跌停
        if (close >= limitUp - 0.005) { seal++; sealCodes.push(tsCode); }
        else if (high >= limitUp - 0.005) broken++;
        if (close <= limitDown + 0.005) down++;
    }
    return { date, sealCount: seal, breakCount: broken, downCount: down, maxStreak: 0, sealCodes };
}

/**
 * 获取涨跌停聚合数据（daily 推导 + 增量缓存）。
 * 只拉取缺失日期，其余从 limit_daily 缓存读取；
 * 连板高度按全窗口封板序列回放（某股连续封板则连板数累加，断板归 1）。
 */
async function fetchLimitData(client: TushareClient, dates: string[], cache: LimitCache): Promise<DailyLimit[]> {
    const cached = await cache.getAll();
    const missing = dates.filter((d) => !cached.has(d));
    for (const d of missing) {
        cached.set(d, await deriveDailyLimit(client, d));
    }
    if (missing.length) {
        await cache.upsert(missing.map((d) => cached.get(d)!));
    }

    // 按日期升序回放连板
    const ordered = dates.map((d) => cached.get(d)).filter((x): x is DailyLimit => !!x);
    const streakInfo = new Map<string, { s: number; d: string }>();
    for (let i = 0; i < ordered.length; i++) {
        const agg = ordered[i];
        const prevDate = i > 0 ? ordered[i - 1].date : '';
        let maxS = 0;
        for (const code of agg.sealCodes) {
            const info = streakInfo.get(code);
            const s = info && info.d === prevDate ? info.s + 1 : 1;
            streakInfo.set(code, { s, d: agg.date });
            if (s > maxS) maxS = s;
        }
        agg.maxStreak = maxS;
    }
    return ordered;
}

/** 涨停封板率：封板数 / (封板+炸板)；高=贪婪 */
function sealRateIndicator(daily: DailyLimit[]): JqIndicator {
    const raws = daily.map(d => d.sealCount + d.breakCount > 0
        ? (d.sealCount / (d.sealCount + d.breakCount)) * 100 : 50);
    if (raws.length < 30) return { key: 'seal_rate', name: '封板率', desc: '涨停封板数占触板总数比，反映买盘强度', ...NEUTRAL };
    const current = raws[raws.length - 1];
    const score = Math.round(pctRankOrNeutral(raws.slice(0, -1), current) * 100) / 100;
    return {
        key: 'seal_rate', name: '封板率', desc: '涨停封板数占触板总数比，反映买盘强度',
        score, raw: Math.round(current * 100) / 100, label: levelOf(score),
        history: { dates: daily.map(d => d.date).reverse(), scores: raws.slice().reverse() },
    };
}

/** 炸板率：炸板数 / (封板+炸板)；高=恐惧（反向） */
function breakRateIndicator(daily: DailyLimit[]): JqIndicator {
    const raws = daily.map(d => d.sealCount + d.breakCount > 0
        ? (d.breakCount / (d.sealCount + d.breakCount)) * 100 : 50);
    if (raws.length < 30) return { key: 'break_rate', name: '炸板率', desc: '炸板数占触板总数比，反映抛压强度', ...NEUTRAL };
    const current = raws[raws.length - 1];
    const score = Math.round((100 - pctRankOrNeutral(raws.slice(0, -1), current)) * 100) / 100;
    return {
        key: 'break_rate', name: '炸板率', desc: '炸板数占触板总数比，反映抛压强度',
        score, raw: Math.round(current * 100) / 100, label: levelOf(score),
        history: { dates: daily.map(d => d.date).reverse(), scores: raws.slice().reverse() },
    };
}

/** 涨跌停数量比：(涨停-跌停)/(涨停+跌停) × 50+50；涨停多=贪婪 */
function limitRatioIndicator(daily: DailyLimit[]): JqIndicator {
    const raws = daily.map(d => {
        const up = d.sealCount + d.breakCount;
        const total = up + d.downCount;
        return total > 0 ? ((up - d.downCount) / total) * 50 + 50 : 50;
    });
    if (raws.length < 30) return { key: 'limit_ratio', name: '涨跌停比', desc: '涨停与跌停数量比，反映多空力量对比', ...NEUTRAL };
    const current = raws[raws.length - 1];
    const score = Math.round(pctRankOrNeutral(raws.slice(0, -1), current) * 100) / 100;
    return {
        key: 'limit_ratio', name: '涨跌停比', desc: '涨停与跌停数量比，反映多空力量对比',
        score, raw: Math.round(current * 100) / 100, label: levelOf(score),
        history: { dates: daily.map(d => d.date).reverse(), scores: raws.slice().reverse() },
    };
}

/** 连板高度：当日最高连板数；高=投机情绪旺盛（贪婪） */
function streakIndicator(daily: DailyLimit[]): JqIndicator {
    const raws = daily.map(d => d.maxStreak);
    if (raws.length < 30) return { key: 'streak', name: '连板高度', desc: '当日最高连续涨停天数，反映投机热度', ...NEUTRAL };
    const current = raws[raws.length - 1];
    const score = Math.round(pctRankOrNeutral(raws.slice(0, -1), current) * 100) / 100;
    return {
        key: 'streak', name: '连板高度', desc: '当日最高连续涨停天数，反映投机热度',
        score, raw: current, label: levelOf(score),
        history: { dates: daily.map(d => d.date).reverse(), scores: raws.slice().reverse() },
    };
}

/** 融资买入额 250 日百分位（杠杆水平代理，不计入综合指数） */
async function margin(client: TushareClient): Promise<JqIndicator> {
    const dates = await tradeDates(client, HIST);
    const rows = await client.request(
        'margin',
        { start_date: dates[0], end_date: dates[dates.length - 1] },
        'trade_date,rzmre',
    );
    const daily = new Map<string, number>();
    for (const r of rows) {
        const d = String(r.trade_date);
        daily.set(d, (daily.get(d) ?? 0) + Number(r.rzmre ?? 0));
    }
    if (!daily.size) return { key: 'margin', name: '杠杆水平', desc: '融资买入占比（不计入指数）', ...NEUTRAL };
    const orderedDates = [...daily.keys()].sort();
    const values = orderedDates.map((d) => daily.get(d)!);
    const current = values[values.length - 1];
    const score = Math.round(pctRankOrNeutral(values.slice(0, -1), current) * 100) / 100;
    return {
        key: 'margin',
        name: '杠杆水平',
        desc: '融资买入占比（不计入指数）',
        score,
        raw: Math.round(current / 1e8 * 100) / 100, // 亿元
        label: levelOf(score),
        excluded: true,
        history: sparkline(values, orderedDates, SPARK),
    };
}

/** 计算韭圈儿恐贪指数（完整结构，含各指标历史序列） */
export async function computeJq(client: TushareClient, breadthCache: BreadthCache, limitCache: LimitCache): Promise<JqResult> {
    const inds = {
        volatility: await volatility(client),
        north_flow: await northFlow(client),
        breadth: await breadth(client, breadthCache),
        futures: await futuresBasis(client),
        equity_bond: await equityBond(client),
        margin: await margin(client),
    };

    // 涨跌停微观指标（daily 推导 + 增量缓存；数据源不可用时降级为中性）
    const micro = await (async () => {
        try {
            const limitDates = await tradeDates(client, HIST);
            const daily = await fetchLimitData(client, limitDates, limitCache);
            return {
                seal_rate: sealRateIndicator(daily),
                break_rate: breakRateIndicator(daily),
                limit_ratio: limitRatioIndicator(daily),
                streak: streakIndicator(daily),
            };
        } catch (err) {
            console.error('[FearGreed] daily limit derivation failed, micro indicators neutral:', err instanceof Error ? err.message : String(err));
            const neutral = { ...NEUTRAL };
            return {
                seal_rate: { key: 'seal_rate', name: '封板率', desc: '涨停封板数占触板总数比，反映买盘强度', ...neutral },
                break_rate: { key: 'break_rate', name: '炸板率', desc: '炸板数占触板总数比，反映抛压强度', ...neutral },
                limit_ratio: { key: 'limit_ratio', name: '涨跌停比', desc: '涨停与跌停数量比，反映多空力量对比', ...neutral },
                streak: { key: 'streak', name: '连板高度', desc: '当日最高连续涨停天数，反映投机热度', ...neutral },
            };
        }
    })();

    // 综合指数 = 有真实数据的指标等权（杠杆水平不计入，与韭圈儿口径扩展）
    // 中性兜底指标（数据源不可用/样本不足，history 为空）不参与平均，
    // 否则缺失的微观指标恒为 50 会把指数往中性拉，掩盖真实恐惧/贪婪
    const compositeInds = [
        inds.volatility, inds.north_flow, inds.breadth,
        inds.futures, inds.equity_bond,
        micro.seal_rate, micro.break_rate, micro.limit_ratio, micro.streak,
    ].filter((k) => k.history.scores.length > 0);
    const composite = compositeInds.length > 0
        ? Math.round(
            compositeInds.reduce((s, k) => s + k.score, 0) / compositeInds.length * 100,
        ) / 100
        : 50;

    const indicators: JqIndicator[] = [
        inds.volatility, inds.north_flow, inds.breadth, inds.futures, inds.equity_bond,
        micro.seal_rate, micro.break_rate, micro.limit_ratio, micro.streak,
        inds.margin,
    ];

    // 综合指数历史（只用有历史的指标等权，避免 fallback 中性指标的空 history 导致历史断裂）
    const histKeys = compositeInds.filter(k => k.history.scores.length > 0);
    const histLen = Math.min(...histKeys.map((k) => k.history.scores.length));
    const histScores: number[] = [];
    for (let i = 0; i < histLen; i++) {
        const avg = histKeys.reduce((s, k) => s + k.history.scores[i], 0) / histKeys.length;
        histScores.push(Math.round(avg * 100) / 100);
    }
    const histDates = inds.breadth.history.dates.slice(0, histLen);

    return {
        key: 'jq',
        name: '韭圈儿恐贪指数',
        composite,
        label: labelOf(composite),
        history: { dates: histDates, scores: histScores },
        indicators,
    };
}
