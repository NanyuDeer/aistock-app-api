import * as TushareService from '../quote/TushareService';
import { fetchBlockRotationData } from './WindLeaderAnalyzerService';
import { getBestBoardForStock, ensureCacheBuilt } from './RotationBoardCache';
import * as LeaderStockCache from './LeaderStockCache';
import {
    PrefetchedData, RawIndicators, DimDef, IndustryCache,
    calcEarningsExplosion, calcValuationElasticity, calcProfitQuality,
    calcCompetitiveMoat, calcIndustryTrack, calcNewsCatalyst,
    prefetchAllData, scoreIndicator, scoreAllIndicators, calcDimScore,
    vetoCheck, VetoError, getAiIndicatorScores, clearAiIndicatorScores,
} from './TenxScoreService';
import { ClsStockNewsService } from './ClsStockNewsService';
import { calcMa60Excluded } from './ma60Excluded';

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
    ma60Excluded: boolean;
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
        ma60Excluded: boolean;
    };
    isLeader?: boolean;          // 是否为其最佳板块的龙头股
    leaderBoardName?: string;    // 最佳板块名称（龙头股加成时展示）
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

function calcTechnicalDim(prices: TushareService.DailyPriceRow[], symbol: string, bestBoardCode?: string): {
    score: number;
    indicators: { name: string; key: string; value: string; score: number }[];
    kline: { dates: string[]; ohlc: [number, number, number, number][] };
    indicatorsRaw: TechnicalDetail['indicators'];
    isLeader: boolean;
    leaderBoardName: string;
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

    // 60日均线剔除判定：连续两日收盘价在60日均线下方 → 剔除
    const ma60Excluded = calcMa60Excluded(closes);

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

    const baseScore = Math.round(gainScore * 0.4 + maScore * 0.3 + newHighScore * 0.15 + drawdownScore * 0.15);

    // 龙头股加成：仅当股票是其「最佳板块」（上榜次数最多的板块）的龙头股时 +8 分，封顶 100
    const isLeader = bestBoardCode ? LeaderStockCache.isLeaderStockInBoard(symbol, bestBoardCode) : false;
    const leaderBoardName = isLeader && bestBoardCode ? LeaderStockCache.getBoardName(bestBoardCode) : '';
    const leaderBonus = isLeader ? 8 : 0;
    const score = Math.min(100, baseScore + leaderBonus);

    const indicators = [
        { name: '低点以来涨幅', key: 'low_point_gain', value: `${lowPointGain.toFixed(1)}%`, score: gainScore },
        { name: '60日线位置', key: 'ma60_position', value: `${ma60Position === 'above' ? '上方' : '下方'} / ${ma60Trend === 'up' ? '向上' : ma60Trend === 'flat' ? '走平' : '向下'}`, score: maScore },
        { name: '创新高状态', key: 'new_high', value: isNewHigh250 ? '250日新高' : isNewHigh120 ? '120日新高' : '未创新高', score: newHighScore },
        { name: '最大回撤', key: 'max_drawdown', value: `${maxDrawdown.toFixed(1)}%`, score: drawdownScore },
        { name: '龙头股加成', key: 'leader_bonus', value: isLeader ? `是（+${leaderBonus}分）${leaderBoardName}` : '否', score: leaderBonus },
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
        indicatorsRaw: { lowPointGain, ma60Position, ma60Trend, isNewHigh250, isNewHigh120, maxDrawdown, ma60Excluded },
        isLeader,
        leaderBoardName,
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
        // 标题和摘要完整返回，前端 CSS 控制显示行数
        const name = title;
        const desc = item.summary || title;
        items.push({ name, desc, color: isPositive ? 'up' : 'gold' });
        if (items.length >= maxItems) break;
    }
    // 如果匹配不足3条，用默认占位
    if (items.length < 3) {
        items.push({ name: '暂无明显政策催化', desc: '近期无重大政策/产业趋势变化', color: 'gold' });
    }
    return items;
}

/** 单个板块在轮动数据中的匹配结果 */
interface BoardMatchResult {
    boardName: string;
    boardCode: string;
    count60d: number;
    weeklyTrend: number[];
}

/**
 * 查找股票所属的最佳概念板块（60日上榜次数最多的）
 *
 * 流程：
 * 1. ths_member(con_code=股票) → 获取所有概念板块 ts_code
 * 2. getThsIndex → ts_code 映射为板块名
 * 3. 逐个板块统计在轮动rawData中的上榜天数
 * 4. 返回上榜次数最多的板块
 */
async function findBestConceptBoard(
    symbol: string,
    rotationRawData: any[],
    fallbackIndustryName?: string,
): Promise<BoardMatchResult | null> {
    // 优先从反向缓存中查找（零API调用）
    const cached = getBestBoardForStock(symbol);
    if (cached) {
        console.log(`[TrendScore] ${symbol} 缓存命中: ${cached.boardName}(${cached.boardCode}), 60日上榜${cached.count60d}次`);
        return cached;
    }
    console.log(`[TrendScore] ${symbol} 缓存未命中，回退到逐股 ths_member 查询`);
    try {
        const tsCode = symbol.startsWith('6') ? `${symbol}.SH` : `${symbol}.SZ`;
        const members = await TushareService.getThsMemberByStock(tsCode);
        if (!members || members.length === 0) {
            console.warn(`[TrendScore] ${symbol} ths_member 返回空`);
            return null;
        }

        // 获取 ths_index 名称映射
        const conceptIndices = await TushareService.getThsIndex('N', 'A');
        const industryIndices = await TushareService.getThsIndex('I', 'A');
        const codeToName = new Map<string, string>();
        for (const idx of [...conceptIndices, ...industryIndices]) {
            codeToName.set(idx.ts_code, idx.name);
        }

        // 构建候选板块列表：[{ name, code }]，只保留 is_new='Y' 的
        const candidates: { name: string; code: string }[] = [];
        for (const m of members) {
            if (m.is_new === 'N') continue; // 跳过已剔除的
            const boardName = codeToName.get(m.ts_code);
            if (boardName) {
                candidates.push({ name: boardName, code: m.ts_code });
            }
        }

        // 兜底：如果 ths_member 没有返回有效的概念，用行业名
        if (candidates.length === 0 && fallbackIndustryName) {
            // 尝试在 ths_index 中模糊匹配行业名
            const allEntries = [...codeToName.entries()];
            for (const [code, name] of allEntries) {
                if (name.length >= 2 && !name.includes('(A股)') &&
                    (fallbackIndustryName.includes(name) || name.includes(fallbackIndustryName))) {
                    candidates.push({ name, code });
                    break;
                }
            }
        }

        if (candidates.length === 0) {
            console.warn(`[TrendScore] ${symbol} 无可用概念板块`);
            return null;
        }

        console.log(`[TrendScore] ${symbol} 候选板块 ${candidates.length} 个: ${candidates.slice(0, 5).map(c => c.name).join(', ')}...`);

        // 逐个板块统计上榜次数
        const results: BoardMatchResult[] = [];
        for (const candidate of candidates) {
            const names = [candidate.name];
            // 也加入模糊匹配的轮动名（如果板块名在轮动数据中有包含关系的变体）
            const allRotationNames = new Set<string>();
            for (const dayData of rotationRawData) {
                const blockList = dayData?.block_list || [];
                for (const block of blockList) {
                    if (block.name) allRotationNames.add(block.name);
                }
            }
            for (const rotName of allRotationNames) {
                if (rotName !== candidate.name &&
                    (candidate.name.includes(rotName) || rotName.includes(candidate.name))) {
                    names.push(rotName);
                }
            }

            const nameSet = new Set(names);
            const weeklyTrend = extractWeeklyTrend(rotationRawData, [...nameSet]);
            const count60d = weeklyTrend.reduce((a, b) => a + b, 0);
            results.push({
                boardName: candidate.name,
                boardCode: candidate.code,
                count60d,
                weeklyTrend,
            });
        }

        // 按上榜次数降序排列，取最多的
        results.sort((a, b) => b.count60d - a.count60d);
        const best = results[0];

        // 日志：打印前5个板块的统计
        const top5 = results.slice(0, 5).map(r => `${r.boardName}=${r.count60d}次`).join(', ');
        console.log(`[TrendScore] ${symbol} 板块上榜统计(top5): ${top5}`);
        console.log(`[TrendScore] ${symbol} 最佳板块: ${best.boardName}(${best.boardCode}), 60日上榜${best.count60d}次`);

        return best;
    } catch (e) {
        console.warn('[TrendScore] findBestConceptBoard failed:', (e as Error).message);
        return null;
    }
}

async function calcTrackDim(
    symbol: string,
    data: PrefetchedData,
    industryCache?: IndustryCache,
    sectorStrength?: string,
    newsItems?: { title: string; summary?: string }[],
    bestBoard?: BoardMatchResult | null,
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

    // 使用主函数传入的最佳概念板块数据
    let sectorListCount60d = 0;
    let sectorName = data.industry?.industry_name || '未知';
    let weeklyTrend: number[] = [0, 0, 0, 0, 0, 0];

    if (bestBoard) {
        sectorListCount60d = bestBoard.count60d;
        sectorName = bestBoard.boardName;
        weeklyTrend = bestBoard.weeklyTrend;
    } else {
        // 回退：如果 bestBoard 为空，用旧的 sectorStats 匹配
        try {
            const { sectorStats, rawData } = await fetchBlockRotationData(60);
            const getSectorStat = (name: string): { frequency: number; matchedName?: string } | undefined => {
                if (!name) return undefined;
                if (sectorStats instanceof Map) {
                    const exact = sectorStats.get(name);
                    if (exact) return { frequency: exact.frequency, matchedName: name };
                } else {
                    const obj = (sectorStats as any)[name];
                    if (obj) return { frequency: obj.frequency || 0, matchedName: name };
                }
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
            if (data.industry?.industry_name) {
                const stat = getSectorStat(data.industry.industry_name);
                if (stat && stat.frequency > 0) { sectorListCount60d = stat.frequency; if (stat.matchedName) sectorName = stat.matchedName; }
            }
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
            weeklyTrend = extractWeeklyTrend(rawData || [], [sectorName], sectorListCount60d);
        } catch (e) {
            console.error('[TrendScore] fallback rotation match failed:', e);
        }
    }

    const indicators = [
        { name: '市场认可度', key: 'market_recognition', value: String(trackRaw['market_recognition'] ?? '--'), score: trackIndScores['market_recognition'] },
        { name: '行业渗透率位置', key: 'industry_penetration', value: String(trackRaw['industry_penetration'] ?? '--'), score: trackIndScores['industry_penetration'] },
        { name: '政策/产业趋势强度', key: 'policy_trend_score', value: String(trackRaw['policy_trend_score'] ?? '--'), score: trackIndScores['policy_trend_score'] },
    ];

    return {
        score: trackDimScore,
        indicators,
        detail: {
            sectorListCount60d,
            sectorName,
            marketRecognition: trackIndScores['market_recognition'],
            policyTrend: String(trackRaw['policy_trend_score'] ?? ''),
            weeklyListingTrend: weeklyTrend,
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

        // 先获取板块轮动数据 + 最佳概念板块（技术面评分需要最佳板块代码来判断龙头股加成）
        let rotationRawData: any[] = [];
        try {
            const { rawData } = await fetchBlockRotationData(60);
            rotationRawData = rawData;
        } catch (e) {
            console.error('[TrendScore] fetchBlockRotationData failed:', e);
        }

        const bestBoard = await findBestConceptBoard(symbol, rotationRawData, data.industry?.industry_name);

        // 1. 技术面维度（传入最佳板块代码，用于龙头股加成判断）
        const techResult = calcTechnicalDim(prices, symbol, bestBoard?.boardCode);

        // 使用最佳概念板块的 ts_code 获取概念指数K线
        let conceptKline: { name: string; dates: string[]; ohlc: [number, number, number, number][] } = { name: '', dates: [], ohlc: [] };
        if (bestBoard) {
            try {
                const thsDaily = await TushareService.getThsDaily(bestBoard.boardCode, startDateStr);
                const sorted = [...thsDaily].sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
                const recent = sorted.slice(-120);
                conceptKline = {
                    name: bestBoard.boardName,
                    dates: recent.map(d => d.trade_date),
                    ohlc: recent.map(d => [d.open, d.close, d.low, d.high] as [number, number, number, number]),
                };
                console.log(`[TrendScore] 概念K线(最佳板块): ${bestBoard.boardName}(${bestBoard.boardCode}), ${recent.length}天`);
            } catch (e) {
                console.error('[TrendScore] concept K-line fetch failed:', e);
            }
        }

        // 如果最佳板块没有K线数据，回退到原有的行业名匹配
        if (conceptKline.ohlc.length === 0) {
            try {
                const conceptIndices = await TushareService.getThsIndex('N', 'A');
                const industryIndices = await TushareService.getThsIndex('I', 'A');
                const nameToCode = new Map<string, string>();
                for (const idx of [...conceptIndices, ...industryIndices]) {
                    nameToCode.set(idx.name, idx.ts_code);
                }
                // 尝试用行业名精确匹配
                let fallbackCode = '';
                let fallbackName = '';
                if (data.industry?.industry_name && nameToCode.has(data.industry.industry_name)) {
                    fallbackCode = nameToCode.get(data.industry.industry_name)!;
                    fallbackName = data.industry.industry_name;
                }
                // 模糊匹配
                if (!fallbackCode && data.industry?.industry_name) {
                    const sortedEntries = [...nameToCode.entries()]
                        .filter(([n]) => n.length >= 2 && !n.includes('(A股)'))
                        .sort((a, b) => b[0].length - a[0].length);
                    for (const [idxName, code] of sortedEntries) {
                        if (data.industry.industry_name.includes(idxName) || idxName.includes(data.industry.industry_name)) {
                            fallbackCode = code;
                            fallbackName = idxName;
                            break;
                        }
                    }
                }
                if (fallbackCode) {
                    const thsDaily = await TushareService.getThsDaily(fallbackCode, startDateStr);
                    const sorted = [...thsDaily].sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
                    const recent = sorted.slice(-120);
                    conceptKline = {
                        name: fallbackName,
                        dates: recent.map(d => d.trade_date),
                        ohlc: recent.map(d => [d.open, d.close, d.low, d.high] as [number, number, number, number]),
                    };
                    console.log(`[TrendScore] 概念K线(回退): ${fallbackName}(${fallbackCode}), ${recent.length}天`);
                }
            } catch (e) {
                console.error('[TrendScore] fallback concept K-line failed:', e);
            }
        }

        // 计算板块月涨幅
        let sectorStrength = '--';
        if (conceptKline.ohlc.length >= 21) {
            const currentClose = conceptKline.ohlc[conceptKline.ohlc.length - 1][1];
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
        const trackResult = await calcTrackDim(symbol, data, industryCache, sectorStrength, newsResult.detail.news, bestBoard);

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
                    isLeader: techResult.isLeader,
                    leaderBoardName: techResult.leaderBoardName,
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
            ma60Excluded: techResult.indicatorsRaw.ma60Excluded,
            updatedAt: new Date().toISOString(),
        };
    }
}
