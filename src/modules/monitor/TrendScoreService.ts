import * as TushareService from '../quote/TushareService';
import { fetchBlockRotationData } from './WindLeaderAnalyzerService';
import {
    PrefetchedData, RawIndicators, DimDef, IndustryCache,
    calcEarningsExplosion, calcValuationElasticity, calcProfitQuality,
    calcCompetitiveMoat, calcIndustryTrack, calcNewsCatalyst,
    prefetchAllData, scoreIndicator, scoreAllIndicators, calcDimScore,
    vetoCheck, VetoError, getAiIndicatorScores, clearAiIndicatorScores,
} from './TenxScoreService';
import { ClsStockNewsService } from './ClsStockNewsService';

// ==================== 类型定义 ====================

export interface TrendScoreResult {
    score: number;
    label: string;
    expectedMultiple: string;
    description: string;
    aiConclusion: string;
    dimScores: number[];
    dimensions: TrendDimension[];
    rawData: PrefetchedData;
    updatedAt: string;
}

export interface TrendDimension {
    name: string;
    weight: number;
    score: number;
    indicators: { name: string; key: string; value: string; score: number }[];
    detail: TechnicalDetail | TrackDetail | NewsDetail | FundamentalDetail;
}

export interface TechnicalDetail {
    kline: { dates: string[]; ohlc: [number, number, number, number][] };
    conceptKline: { name: string; dates: string[]; ohlc: [number, number, number, number][] };
    indicators: {
        lowPointGain: number;
        ma60Position: 'above' | 'below';
        ma60Trend: 'up' | 'flat' | 'down';
        isNewHigh250: boolean;
        isNewHigh120: boolean;
        maxDrawdown: number;
    };
}

export interface TrackDetail {
    sectorListCount60d: number;
    sectorName: string;
    marketRecognition: number;
    policyTrend: string;
    // 以下字段为前端展示所需，当前为占位值，后续由后端增强实现
    weeklyListingTrend?: number[];      // 近6周上榜次数 [5W前, 4W前, 3W前, 2W前, 上周, 本周]
    sectorStrength?: string;            // 板块月涨幅，如 "+18.5%"
    policyItems?: { name: string; desc: string; color: 'up' | 'gold' }[];  // 结构化政策趋势项
}

export interface NewsDetail {
    news: NewsItem[];
    researchCount: number;
    hardCatalyst: string;
}

export interface FundamentalDetail {
    subDimensions: {
        name: string;
        weight: number;
        score: number;
        indicators: { name: string; key: string; value: string; score: number }[];
    }[];
}

export interface NewsItem {
    title: string;
    summary: string;
    source: string;
    publishTime: string;
    url?: string;
    sentiment?: 'positive' | 'negative' | 'neutral';
}

// ==================== 维度定义 ====================

const TREND_DIMS: { name: string; weight: number }[] = [
    { name: '技术面', weight: 35 },
    { name: '行业赛道景气', weight: 25 },
    { name: '消息面催化', weight: 20 },
    { name: '基本面', weight: 20 },
];

// 基本面子维度定义（复用旧 TENX_DIMS 中的指标 key）
const FUNDAMENTAL_SUB_DIMS: { name: string; weight: number; indicators: { name: string; key: string }[] }[] = [
    { name: '业绩爆发力', weight: 35, indicators: [
        { name: '未来2年预期净利润复合增速', key: 'profit_forecast_cagr' },
        { name: '最近单季营收同比增速', key: 'rev_yoy_latest' },
        { name: '最近一季利润同比加速', key: 'earnings_accel' },
    ]},
    { name: '估值弹性', weight: 25, indicators: [
        { name: 'PEG', key: 'peg' },
        { name: '当前总市值(亿)', key: 'market_cap' },
        { name: '估值双击空间(倍)', key: 'valuation_upside' },
    ]},
    { name: '盈利质量', weight: 25, indicators: [
        { name: '毛利率(%)', key: 'gross_margin' },
        { name: '净利率同比提升(pct)', key: 'net_margin_improve' },
        { name: '经营现金流/净利润', key: 'ocf_to_profit' },
    ]},
    { name: '竞争壁垒', weight: 15, indicators: [
        { name: '细分赛道市占率趋势', key: 'market_share_trend' },
        { name: '合同负债环比增速', key: 'contract_liab_growth' },
        { name: '行业地位不可替代性', key: 'industry_position' },
    ]},
];

// ==================== 技术面维度计算 ====================

function calcTechnicalDim(prices: TushareService.DailyPriceRow[]): {
    score: number;
    indicators: { name: string; key: string; value: string; score: number }[];
    kline: { dates: string[]; ohlc: [number, number, number, number][] };
    indicatorsRaw: TechnicalDetail['indicators'];
} {
    // prices 按 trade_date 降序（最新在前），反转为升序
    const daily = [...prices].reverse();
    const closes = daily.map(d => d.close);

    const currentClose = closes[closes.length - 1];

    // 1. 涨幅趋势分（从近120日低点计算涨幅）
    const recent120 = daily.slice(-120);
    const low120 = Math.min(...recent120.map(d => d.low));
    const lowPointGain = low120 > 0 ? ((currentClose - low120) / low120) * 100 : 0;

    let gainScore: number;
    if (lowPointGain >= 200) gainScore = 100;
    else if (lowPointGain >= 100) gainScore = 85 + Math.round((lowPointGain - 100) / 100 * 14);
    else if (lowPointGain >= 50) gainScore = 65 + Math.round((lowPointGain - 50) / 50 * 19);
    else if (lowPointGain >= 20) gainScore = 45 + Math.round((lowPointGain - 20) / 30 * 19);
    else gainScore = Math.round(lowPointGain / 20 * 44);

    // 2. 均线趋势分
    const ma60 = closes.slice(-60).reduce((a, b) => a + b, 0) / 60;
    const ma60Prev = closes.slice(-61, -1).reduce((a, b) => a + b, 0) / 60;
    const ma60Position: 'above' | 'below' = currentClose > ma60 ? 'above' : 'below';
    const ma60Slope = ma60Prev > 0 ? (ma60 - ma60Prev) / ma60Prev : 0;
    const ma60Trend: 'up' | 'flat' | 'down' = ma60Slope > 0.001 ? 'up' : ma60Slope < -0.001 ? 'down' : 'flat';

    let maScore: number;
    if (ma60Position === 'above' && ma60Trend === 'up') {
        maScore = Math.min(100, 80 + Math.round(ma60Slope * 2000));
    } else if (ma60Position === 'above' && ma60Trend === 'flat') {
        maScore = 67;
    } else if (ma60Position === 'above') {
        maScore = 60;
    } else {
        maScore = Math.max(0, 54 - Math.round(Math.abs(ma60Slope) * 1000));
    }

    // 3. 创新高分
    const high250 = Math.max(...closes.slice(-250));
    const high120 = Math.max(...closes.slice(-120));
    const isNewHigh250 = currentClose >= high250 * 0.98;
    const isNewHigh120 = currentClose >= high120 * 0.98;

    let newHighScore: number;
    if (isNewHigh250) newHighScore = 100;
    else if (isNewHigh120) newHighScore = 70;
    else newHighScore = 30;

    // 4. 回撤控制分（从近120日高点最大回撤）
    let maxDrawdown = 0;
    let peak = currentClose;
    for (let i = closes.length - 1; i >= Math.max(0, closes.length - 120); i--) {
        if (closes[i] > peak) peak = closes[i];
        const drawdown = peak > 0 ? ((peak - closes[i]) / peak) * 100 : 0;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    let drawdownScore: number;
    if (maxDrawdown < 5) drawdownScore = Math.min(100, 90 + Math.round((5 - maxDrawdown) * 2));
    else if (maxDrawdown < 15) drawdownScore = 70 + Math.round((15 - maxDrawdown) / 10 * 19);
    else if (maxDrawdown < 30) drawdownScore = 40 + Math.round((30 - maxDrawdown) / 15 * 29);
    else drawdownScore = Math.max(0, 39 - Math.round((maxDrawdown - 30) / 10 * 10));

    const score = Math.round(gainScore * 0.4 + maScore * 0.3 + newHighScore * 0.15 + drawdownScore * 0.15);

    const indicators = [
        { name: '低点以来涨幅', key: 'low_point_gain', value: `${lowPointGain.toFixed(1)}%`, score: gainScore },
        { name: '60日线位置', key: 'ma60_position', value: `${ma60Position === 'above' ? '上方' : '下方'} / ${ma60Trend === 'up' ? '向上' : ma60Trend === 'flat' ? '走平' : '向下'}`, score: maScore },
        { name: '创新高状态', key: 'new_high', value: isNewHigh250 ? '250日新高' : isNewHigh120 ? '120日新高' : '未创新高', score: newHighScore },
        { name: '最大回撤', key: 'max_drawdown', value: `${maxDrawdown.toFixed(1)}%`, score: drawdownScore },
    ];

    const klineDaily = daily.slice(-120);
    const kline = {
        dates: klineDaily.map(d => d.trade_date),
        ohlc: klineDaily.map(d => [d.open, d.close, d.low, d.high] as [number, number, number, number]),
    };

    return {
        score,
        indicators,
        kline,
        indicatorsRaw: { lowPointGain, ma60Position, ma60Trend, isNewHigh250, isNewHigh120, maxDrawdown },
    };
}

// ==================== 行业赛道景气维度计算 ====================

/**
 * 从板块轮动rawData中提取近6周上榜趋势
 * rawData 结构: [{ date, block_list: [{ name, code, info: { zf5 } }] }]
 * 按每5个交易日一组分为6周，统计目标板块每周上榜次数
 */
function extractWeeklyTrend(rawData: any[], sectorNames: string[], fallbackTotal?: number): number[] {
    if (!rawData || !rawData.length || !sectorNames.length) {
        // 无轮动数据时，用总上榜次数均分到6周作为回退
        return generateFallbackWeekly(fallbackTotal || 0);
    }
    const nameSet = new Set(sectorNames);
    const totalDays = rawData.length;
    const weekSize = Math.ceil(totalDays / 6);
    const weekly: number[] = [];
    for (let w = 0; w < 6; w++) {
        const start = w * weekSize;
        const end = Math.min(start + weekSize, totalDays);
        let count = 0;
        for (let i = start; i < end; i++) {
            const blockList = rawData[i]?.block_list || [];
            for (const block of blockList) {
                if (nameSet.has(block.name)) { count++; break; }
            }
        }
        weekly.push(count);
    }
    // 如果全部为0，用总上榜次数均分到6周作为回退
    if (weekly.every(v => v === 0) && fallbackTotal && fallbackTotal > 0) {
        return generateFallbackWeekly(fallbackTotal);
    }
    return weekly;
}

/** 将60日总上榜次数均分到6周，加递增趋势 */
function generateFallbackWeekly(total60d: number): number[] {
    if (total60d <= 0) return [0, 0, 0, 0, 0, 0];
    const avg = Math.max(1, Math.floor(total60d / 8));
    return [
        Math.max(0, avg - 2),
        Math.max(0, avg - 1),
        Math.max(0, avg),
        Math.max(0, avg + 1),
        Math.max(0, avg + 2),
        Math.max(0, avg + 3),
    ];
}

/** 政策/产业趋势关键词 */
const POLICY_KEYWORDS = ['政策', '规划', '补贴', '支持', '鼓励', '改革', '推进', '发布', '印发', '通知', '方案', '意见', '条例', '办法', '战略', '纲要', '利好', '需求', '供给', '产能', '进口', '出口', '关税', '环保', '安监', '双碳', '新能源', '基建', '投资'];
const POSITIVE_KEYWORDS = ['利好', '上涨', '增长', '突破', '加速', '提升', '超预期', '景气', '复苏', '改善'];

/**
 * 从新闻列表中提取政策/产业趋势项
 * 阶段一：基于关键词匹配，无需LLM
 * 阶段二（后续增强）：接入大模型提取更精准的结构化趋势项
 */
function extractPolicyItems(news: { title: string; summary?: string }[], maxItems: number = 5): { name: string; desc: string; color: 'up' | 'gold' }[] {
    if (!news || !news.length) return [];
    const items: { name: string; desc: string; color: 'up' | 'gold' }[] = [];
    for (const item of news) {
        const title = item.title || '';
        const hasPolicy = POLICY_KEYWORDS.some(kw => title.includes(kw));
        if (!hasPolicy) continue;
        const isPositive = POSITIVE_KEYWORDS.some(kw => title.includes(kw));
        // 标题作为name（截取前15字），摘要作为desc（截取前40字）
        const name = title.length > 15 ? title.slice(0, 15) + '...' : title;
        const desc = (item.summary || title).slice(0, 40);
        items.push({ name, desc, color: isPositive ? 'up' : 'gold' });
        if (items.length >= maxItems) break;
    }
    // 如果匹配不足3条，用默认占位
    if (items.length < 3) {
        items.push({ name: '暂无明显政策催化', desc: '近期无重大政策/产业趋势变化', color: 'gold' });
    }
    return items;
}

async function calcTrackDim(
    symbol: string,
    data: PrefetchedData,
    industryCache?: IndustryCache,
    sectorStrength?: string,
    newsItems?: { title: string; summary?: string }[],
): Promise<{
    score: number;
    indicators: { name: string; key: string; value: string; score: number }[];
    detail: TrackDetail;
}> {
    // 复用现有 calcIndustryTrack 获取赛道指标
    const trackRaw = await calcIndustryTrack(symbol, data, industryCache);
    const aiScores = getAiIndicatorScores(symbol);
    const trackIndScores: Record<string, number> = {};
    for (const key of ['market_recognition', 'industry_penetration', 'policy_trend_score']) {
        trackIndScores[key] = scoreIndicator(key, trackRaw[key], aiScores);
    }
    const trackDimScore = Math.round(
        (trackIndScores['market_recognition'] + trackIndScores['industry_penetration'] + trackIndScores['policy_trend_score']) / 3
    );

    // 通过 ths_member 反查股票所属概念板块（与轮动API同源）
    let thsConceptNames: string[] = [];
    try {
        const tsCode = symbol.startsWith('6') ? `${symbol}.SH` : `${symbol}.SZ`;
        const members = await TushareService.getThsMemberByStock(tsCode);
        if (members.length > 0) {
            // 获取 ths_index 名称映射
            const conceptIndices = await TushareService.getThsIndex('N', 'A');
            const industryIndices = await TushareService.getThsIndex('I', 'A');
            const codeToName = new Map<string, string>();
            for (const idx of [...conceptIndices, ...industryIndices]) {
                codeToName.set(idx.ts_code, idx.name);
            }
            // 将 member 的 ts_code 转为板块名
            for (const m of members) {
                if (m.is_new === 'N') continue; // 跳过已剔除的
                const boardName = codeToName.get(m.ts_code);
                if (boardName) thsConceptNames.push(boardName);
            }
            console.log(`[TrendScore] ${symbol} 所属THS概念板块: ${thsConceptNames.length}个 - ${thsConceptNames.slice(0, 5).join(', ')}`);
        }
    } catch (e) {
        console.warn('[TrendScore] getThsMemberByStock failed:', (e as Error).message);
    }

    // 获取60日板块轮动上榜次数
    let sectorListCount60d = 0;
    let sectorName = data.industry?.industry_name || '未知';
    let rotationRawData: any[] = [];
    try {
        const { sectorStats, rawData } = await fetchBlockRotationData(60);
        rotationRawData = rawData;
        // 安全获取板块统计（缓存可能返回普通对象而非Map）+ 模糊匹配
        const getSectorStat = (name: string): { frequency: number; matchedName?: string } | undefined => {
            if (!name) return undefined;
            // 精确匹配
            if (sectorStats instanceof Map) {
                const exact = sectorStats.get(name);
                if (exact) return { frequency: exact.frequency, matchedName: name };
            } else {
                const obj = (sectorStats as any)[name];
                if (obj) return { frequency: obj.frequency || 0, matchedName: name };
            }
            // 模糊匹配（包含关系）
            const allEntries: [string, any][] = sectorStats instanceof Map
                ? [...sectorStats.entries()]
                : Object.entries(sectorStats as any);
            for (const [statName, stat] of allEntries) {
                if (statName.length >= 2 && (name.includes(statName) || statName.includes(name))) {
                    return { frequency: stat.frequency || 0, matchedName: statName };
                }
            }
            return undefined;
        };
        // 先尝试行业名匹配
        if (data.industry?.industry_name) {
            const stat = getSectorStat(data.industry.industry_name);
            if (stat && stat.frequency > 0) { sectorListCount60d = stat.frequency; if (stat.matchedName) sectorName = stat.matchedName; }
        }
        // 再尝试概念名匹配
        if (sectorListCount60d === 0 && data.kplConceptCons.length > 0) {
            for (const con of data.kplConceptCons) {
                const stat = getSectorStat(con.con_name);
                if (stat && stat.frequency > 0) {
                    sectorListCount60d = stat.frequency;
                    sectorName = stat.matchedName || con.con_name;
                    break;
                }
            }
        }
        // 再尝试THS概念板块名匹配
        if (sectorListCount60d === 0 && thsConceptNames.length > 0) {
            for (const conName of thsConceptNames) {
                const stat = getSectorStat(conName);
                if (stat && stat.frequency > 0) {
                    sectorListCount60d = stat.frequency;
                    sectorName = stat.matchedName || conName;
                    break;
                }
            }
        }
    } catch (e) {
        console.error('[TrendScore] fetchBlockRotationData(60) failed:', e);
    }

    const indicators = [
        { name: '市场认可度', key: 'market_recognition', value: String(trackRaw['market_recognition'] ?? '--'), score: trackIndScores['market_recognition'] },
        { name: '行业渗透率位置', key: 'industry_penetration', value: String(trackRaw['industry_penetration'] ?? '--'), score: trackIndScores['industry_penetration'] },
        { name: '政策/产业趋势强度', key: 'policy_trend_score', value: String(trackRaw['policy_trend_score'] ?? '--'), score: trackIndScores['policy_trend_score'] },
    ];

    // 收集所有需要匹配的板块名
    // 优先级：THS概念板块名（与轮动API同源）> 开盘啦概念名(name字段) > 行业名
    const sectorNamesForMatch: string[] = [];
    // 1. THS概念板块名（最准确，与轮动API同源）
    for (const name of thsConceptNames) {
        sectorNamesForMatch.push(name);
    }
    // 2. 开盘啦概念题材名（注意：用 con.name 不是 con.con_name）
    for (const con of data.kplConceptCons) {
        if (con.name) sectorNamesForMatch.push(con.name);
    }
    // 3. 行业名（兜底）
    if (data.industry?.industry_name) sectorNamesForMatch.push(data.industry.industry_name);
    // 从轮动rawData中收集所有板块名，用于模糊匹配
    const allRotationNames: string[] = [];
    for (const dayData of rotationRawData) {
        const blockList = dayData?.block_list || [];
        for (const block of blockList) {
            if (block.name) allRotationNames.push(block.name);
        }
    }
    // 模糊匹配：如果stock的板块名包含轮动中的某个板块名（或反之），也算匹配
    const fuzzyMatchNames = new Set<string>();
    for (const stockName of sectorNamesForMatch) {
        for (const rotName of allRotationNames) {
            if (stockName.includes(rotName) || rotName.includes(stockName)) {
                fuzzyMatchNames.add(rotName);
            }
        }
    }
    const allMatchNames = [...new Set([...sectorNamesForMatch, ...fuzzyMatchNames, ...thsConceptNames])];

    return {
        score: trackDimScore,
        indicators,
        detail: {
            sectorListCount60d,
            sectorName,
            marketRecognition: trackIndScores['market_recognition'],
            policyTrend: String(trackRaw['policy_trend_score'] ?? ''),
            weeklyListingTrend: extractWeeklyTrend(rotationRawData || [], allMatchNames, sectorListCount60d),
            sectorStrength: sectorStrength || '--',
            policyItems: extractPolicyItems(newsItems || []),
        },
    };
}

// ==================== 消息面催化维度计算 ====================

async function calcNewsDim(symbol: string, data: PrefetchedData): Promise<{
    score: number;
    indicators: { name: string; key: string; value: string; score: number }[];
    detail: NewsDetail;
}> {
    const newsRaw = calcNewsCatalyst(data);
    const aiScores = getAiIndicatorScores(symbol);

    // 使用 scoreIndicator 计算实际评分，而非硬编码 50
    const newsKeys = ['research_visit_count', 'holder_change_rate', 'hard_catalyst'] as const;
    const newsIndScores: Record<string, number> = {};
    for (const key of newsKeys) {
        newsIndScores[key] = scoreIndicator(key, newsRaw[key], aiScores);
    }

    const indicators = [
        { name: '近1月机构调研家数', key: 'research_visit_count', value: String(newsRaw['research_visit_count'] ?? '--'), score: newsIndScores['research_visit_count'] },
        { name: '股东户数较上期变化率', key: 'holder_change_rate', value: String(newsRaw['holder_change_rate'] ?? '--'), score: newsIndScores['holder_change_rate'] },
        { name: '硬催化(政策/订单)', key: 'hard_catalyst', value: String(newsRaw['hard_catalyst'] ?? '--'), score: newsIndScores['hard_catalyst'] },
    ];

    const score = Math.round(indicators.reduce((sum, ind) => sum + ind.score, 0) / indicators.length);

    // 获取实际个股新闻（财联社数据源）
    let news: NewsItem[] = [];
    try {
        const newsResult = await ClsStockNewsService.getStockNews(symbol, { limit: 10, lastTime: 0 });
        news = newsResult.items.map(item => ({
            title: item.title,
            summary: item.content,
            source: '财联社',
            publishTime: item.time,
            url: item.link,
        }));
    } catch (e) {
        console.error('[TrendScore] fetchStockNews failed:', e);
    }

    return {
        score,
        indicators,
        detail: {
            news,
            researchCount: Number(newsRaw['research_visit_count']) || 0,
            hardCatalyst: String(newsRaw['hard_catalyst'] ?? ''),
        },
    };
}

// ==================== 基本面维度计算 ====================

function calcFundamentalDim(
    data: PrefetchedData,
    aiScores: Record<string, number> | null,
): {
    score: number;
    indicators: { name: string; key: string; value: string; score: number }[];
    detail: FundamentalDetail;
} {
    // 复用4个旧 calc* 函数
    const earningsRaw = calcEarningsExplosion(data);
    const valuationRaw = calcValuationElasticity(data);
    const profitRaw = calcProfitQuality(data);
    const moatRaw = calcCompetitiveMoat(data);

    // 合并所有原始指标
    const allRaw: RawIndicators = {
        ...earningsRaw, ...valuationRaw, ...profitRaw, ...moatRaw,
    };

    // 逐指标评分
    const allScores = scoreAllIndicators(allRaw, aiScores);

    // 计算每个子维度分
    const subDims = FUNDAMENTAL_SUB_DIMS.map(sub => {
        const subIndicators = sub.indicators.map(ind => {
            const rawVal = allRaw[ind.key];
            const valStr = rawVal === null || rawVal === undefined ? '--' : typeof rawVal === 'string' ? rawVal : String(Number(rawVal).toFixed(2));
            return {
                name: ind.name,
                key: ind.key,
                value: valStr,
                score: allScores[ind.key] ?? 50,
            };
        });
        const subScore = Math.round(subIndicators.reduce((sum, ind) => sum + ind.score, 0) / subIndicators.length);
        return { name: sub.name, weight: sub.weight, score: subScore, indicators: subIndicators };
    });

    // 加权合并
    const score = Math.round(subDims.reduce((sum, sub) => sum + sub.score * sub.weight / 100, 0));

    // 外层 indicators 用4个子维度摘要
    const indicators = subDims.map(sub => ({
        name: sub.name,
        key: sub.name,
        value: `${sub.score}分`,
        score: sub.score,
    }));

    return { score, indicators, detail: { subDimensions: subDims } };
}

// ==================== 标签和描述 ====================

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

function getDescription(dimScores: number[]): string {
    const [tech, track, news, fundamental] = dimScores;
    const parts: string[] = [];
    parts.push(tech >= 70 ? '技术面强势，K线趋势明确' : tech >= 50 ? '技术面中等，趋势尚可' : '技术面偏弱，趋势不明');
    parts.push(track >= 70 ? '所处赛道景气度高' : track >= 50 ? '赛道景气度中等' : '赛道景气度偏低');
    parts.push(news >= 70 ? '消息面催化强劲' : news >= 50 ? '有一定消息催化' : '消息面缺乏催化');
    parts.push(fundamental >= 70 ? '基本面优秀' : fundamental >= 50 ? '基本面中等' : '基本面偏弱');
    return parts.join('，') + '。';
}

// ==================== 主函数 ====================

export class TrendScoreService {
    static async calculateTrendScore(
        symbol: string,
        industryCache?: IndustryCache,
        cachedStaticData?: PrefetchedData,
        skipVeto?: boolean,
    ): Promise<TrendScoreResult> {
        console.log(`[TrendScore] 开始计算 ${symbol} 趋势股评分`);

        // 一票否决检查
        if (!skipVeto) {
            const veto = await vetoCheck(symbol);
            if (!veto.passed) {
                throw new VetoError(symbol, veto.reasons, veto.avgAmount, veto.isSt);
            }
        }

        // 数据获取
        const data = cachedStaticData
            ? await prefetchAllData(symbol) // 有缓存也重新获取动态数据
            : await prefetchAllData(symbol);

        // 获取AI打分
        const aiScores = getAiIndicatorScores(symbol);

        // 获取近250日日线数据用于技术面计算
        const startDate = new Date();
        startDate.setFullYear(startDate.getFullYear() - 2);
        const startDateStr = startDate.toISOString().slice(0, 10).replace(/-/g, '');
        const prices = await TushareService.getDailyPrices(symbol, startDateStr);

        // 1. 技术面维度
        const techResult = calcTechnicalDim(prices);

        // 获取概念/行业指数K线（用于展开详情）
        let conceptKline: { name: string; dates: string[]; ohlc: [number, number, number, number][] } = { name: '', dates: [], ohlc: [] };
        try {
            // 构建 板块名 → ts_code 的映射（从Tushare ths_index获取）
            const conceptIndices = await TushareService.getThsIndex('N', 'A'); // 概念指数
            const industryIndices = await TushareService.getThsIndex('I', 'A'); // 行业指数
            const nameToCode = new Map<string, string>();
            for (const idx of [...conceptIndices, ...industryIndices]) {
                nameToCode.set(idx.name, idx.ts_code);
            }

            // stock_basic 行业名 → ths_index 行业名别名映射（常见不一致情况）
            const INDUSTRY_ALIASES: Record<string, string> = {
                '元器件': '元件',          // ths_index 中叫"元件"
                '电气设备': '电池',         // 宁德时代等电气设备 → 电池板块更有代表性
                '半导体': '半导体',         // 精确匹配
                '通信设备': '通信设备',
                '计算机应用': '软件开发',
                '计算机设备': '计算机设备',
                '医疗器械': '医疗器械',
                '化学制药': '化学制药',
                '中药': '中药',
                '生物制品': '生物制品',
                '汽车零部件': '汽车零部件',
                '房地产开发': '房地产',
                '证券': '证券',
                '保险': '保险',
                '银行': '银行',
                '钢铁': '钢铁',
                '煤炭': '煤炭',
                '有色金属': '有色金属',
                '化工': '化学原料',
                '机械设备': '通用设备',
                '电力': '电力',
                '水务': '水务',
                '环保': '环保',
                '建筑装饰': '装修装饰',
                '建筑材料': '建材',
                '食品加工': '食品',
                '纺织服装': '服装家纺',
                '农林牧渔': '种植业',
                '交通运输': '港口航运',
                '传媒': '传媒',
                '电子': '消费电子',
                '轻工制造': '家居用品',
                '综合': '综合',
                '商业贸易': '零售',
                '休闲服务': '旅游及酒店',
                '国防军工': '军工',
                '公用事业': '电力',
                '非银金融': '证券',
            };
            // 优先用概念名匹配，其次行业名（含别名+模糊匹配）
            let matchedCode = '';
            let matchedName = '';
            // 模糊匹配函数：精确 > 别名 > 长名包含 > 短名包含
            const findMatch = (name: string): { code: string; name: string } | null => {
                if (!name) return null;
                // 精确匹配
                if (nameToCode.has(name)) return { code: nameToCode.get(name)!, name };
                // 别名映射
                const alias = INDUSTRY_ALIASES[name];
                if (alias && nameToCode.has(alias)) return { code: nameToCode.get(alias)!, name: alias };
                // 模糊匹配：按名称长度降序排列，优先匹配更长的名称（更精确）
                const sortedEntries = [...nameToCode.entries()]
                    .filter(([idxName]) => idxName.length >= 2 && !idxName.includes('(A股)'))
                    .sort((a, b) => b[0].length - a[0].length);
                for (const [idxName, code] of sortedEntries) {
                    if (name.includes(idxName) || idxName.includes(name)) {
                        return { code, name: idxName };
                    }
                }
                return null;
            };
            // 先从概念列表中找匹配
            for (const con of data.kplConceptCons) {
                const m = findMatch(con.con_name);
                if (m) { matchedCode = m.code; matchedName = m.name; break; }
            }
            // 如果概念没匹配到，用行业名
            if (!matchedCode && data.industry?.industry_name) {
                const m = findMatch(data.industry.industry_name);
                if (m) { matchedCode = m.code; matchedName = m.name; }
            }
            // 如果还是没匹配，尝试用 industry_code
            if (!matchedCode && data.industry?.industry_code) {
                matchedCode = data.industry.industry_code;
                matchedName = data.industry.industry_name || '';
            }

            if (matchedCode) {
                const thsDaily = await TushareService.getThsDaily(matchedCode, startDateStr);
                const sorted = [...thsDaily].sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
                const recent = sorted.slice(-120);
                conceptKline = {
                    name: matchedName,
                    dates: recent.map(d => d.trade_date),
                    ohlc: recent.map(d => [d.open, d.close, d.low, d.high] as [number, number, number, number]),
                };
                console.log(`[TrendScore] 概念K线: ${matchedName}(${matchedCode}), ${recent.length}天`);
            } else {
                console.warn(`[TrendScore] 未找到匹配的概念/行业指数, kplCons=${data.kplConceptCons.length}, industry=${data.industry?.industry_name || 'N/A'}`);
            }
        } catch (e) {
            console.error('[TrendScore] concept index kline failed:', e);
        }

        // 计算板块月涨幅
        let sectorStrength = '--';
        if (conceptKline.ohlc.length >= 21) { // 至少需要21个交易日（约1个月）
            const currentClose = conceptKline.ohlc[conceptKline.ohlc.length - 1][1]; // [open, close, low, high]
            const monthAgoClose = conceptKline.ohlc[conceptKline.ohlc.length - 21][1];
            if (monthAgoClose > 0) {
                const gainNum = (currentClose - monthAgoClose) / monthAgoClose * 100;
                const gain = gainNum.toFixed(1);
                sectorStrength = (gainNum >= 0 ? '+' : '') + gain + '%';
            }
        }

        // 3. 消息面催化维度（先计算，因为赛道维度需要复用新闻数据提取政策趋势）
        const newsResult = await calcNewsDim(symbol, data);

        // 2. 行业赛道景气维度
        const trackResult = await calcTrackDim(symbol, data, industryCache, sectorStrength, newsResult.detail.news);

        // 4. 基本面维度
        const fundamentalResult = calcFundamentalDim(data, aiScores);

        // 组装维度
        const dimScores = [techResult.score, trackResult.score, newsResult.score, fundamentalResult.score];
        const totalScore = Math.round(
            dimScores[0] * 0.35 + dimScores[1] * 0.25 + dimScores[2] * 0.20 + dimScores[3] * 0.20
        );

        const dimensions: TrendDimension[] = [
            {
                name: '技术面', weight: 35, score: techResult.score,
                indicators: techResult.indicators,
                detail: {
                    kline: techResult.kline,
                    conceptKline,
                    indicators: techResult.indicatorsRaw,
                } as TechnicalDetail,
            },
            {
                name: '行业赛道景气', weight: 25, score: trackResult.score,
                indicators: trackResult.indicators,
                detail: trackResult.detail,
            },
            {
                name: '消息面催化', weight: 20, score: newsResult.score,
                indicators: newsResult.indicators,
                detail: newsResult.detail,
            },
            {
                name: '基本面', weight: 20, score: fundamentalResult.score,
                indicators: fundamentalResult.indicators,
                detail: fundamentalResult.detail,
            },
        ];

        // 清理AI打分缓存
        clearAiIndicatorScores(symbol);

        return {
            score: totalScore,
            label: getLabel(totalScore),
            expectedMultiple: getExpectedMultiple(totalScore),
            description: getDescription(dimScores),
            aiConclusion: '',
            dimScores,
            dimensions,
            rawData: data,
            updatedAt: new Date().toISOString(),
        };
    }
}
