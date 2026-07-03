import { tushareRequest } from './TushareService';
import { getStockIdentity } from '../../shared/utils/stock';
import { createThrottler } from '../../shared/utils/throttle';
import pool from '../../core/db';
import { sessionFetch } from '../../shared/utils/httpAgent';
import { getSinaMoneyflow, isBJStock } from './SinaMoneyFlowService';

const capitalFlowThrottler = createThrottler(150);

function toTsCode(symbol: string): string {
    const identity = getStockIdentity(symbol);
    return `${symbol}.${identity.market.toUpperCase()}`;
}

interface MoneyFlowRow {
    ts_code: string;
    trade_date: string;
    buy_sm_amount: number;
    sell_sm_amount: number;
    buy_md_amount: number;
    sell_md_amount: number;
    buy_lg_amount: number;
    sell_lg_amount: number;
    buy_elg_amount: number;
    sell_elg_amount: number;
    net_mf_amount: number;
}

export interface CapitalFlowOrder {
    label: string;
    value: number;
}

export interface CapitalFlowResult {
    symbol: string;
    tradeDate: string;
    mainInflow: number;
    retailInflow: number;
    ratio: string;
    fiveDay: number;
    streak: string;
    tag: string;
    tagClass: string;
    trendBadge: string;
    narrative: string;
    risk: string;
    trend: number[];
    trendDates: string[];
    orders: CapitalFlowOrder[];
}

async function fetchMoneyFlow(symbol: string, startDate: string): Promise<MoneyFlowRow[]> {
    await capitalFlowThrottler.throttle();
    const rows = await tushareRequest('moneyflow', {
        ts_code: toTsCode(symbol),
        start_date: startDate,
    });
    return rows as MoneyFlowRow[];
}

function computeStreak(trend: number[]): string {
    if (trend.length === 0) return '无数据';
    const last = trend[trend.length - 1];
    if (last >= 0) {
        let count = 0;
        for (let i = trend.length - 1; i >= 0; i--) {
            if (trend[i] >= 0) count++;
            else break;
        }
        return count >= 2 ? `连买${count}天` : '观察中';
    } else {
        let count = 0;
        for (let i = trend.length - 1; i >= 0; i--) {
            if (trend[i] < 0) count++;
            else break;
        }
        return count >= 2 ? `连卖${count}天` : '观察中';
    }
}

function computeTagAndClass(mainInflow: number, ratio: number, streak: string): { tag: string; tagClass: string } {
    const absInflow = Math.abs(mainInflow);
    const isStreakBuy = streak.startsWith('连买');
    const streakDays = parseInt(streak.replace(/[^0-9]/g, ''), 10) || 0;

    if (mainInflow > 0 && ratio >= 3 && streakDays >= 4) return { tag: '强承接', tagClass: 'is-bull' };
    if (mainInflow > 0 && ratio >= 2 && streakDays >= 3) return { tag: '稳步流入', tagClass: 'is-bull' };
    if (mainInflow > 0 && ratio >= 3) return { tag: '放量抢筹', tagClass: 'is-bull' };
    if (mainInflow > 0 && ratio >= 2) return { tag: '主题流入', tagClass: 'is-bull' };
    if (mainInflow > 0 && streakDays >= 3) return { tag: '机构加仓', tagClass: 'is-bull' };
    if (mainInflow > 0 && absInflow >= 2) return { tag: '试探流入', tagClass: 'is-bull' };
    if (mainInflow > 0 && ratio >= 1) return { tag: '温和流入', tagClass: 'is-neutral' };
    if (mainInflow > 0) return { tag: '微幅流入', tagClass: 'is-neutral' };

    if (mainInflow < 0 && ratio >= 3) return { tag: '大幅流出', tagClass: 'is-bear' };
    if (mainInflow < 0 && ratio >= 2) return { tag: '持续流出', tagClass: 'is-bear' };
    if (mainInflow < 0 && streak.startsWith('连卖')) return { tag: '主力撤离', tagClass: 'is-bear' };
    if (mainInflow < 0) return { tag: '小幅流出', tagClass: 'is-neutral' };

    return { tag: '观察', tagClass: 'is-neutral' };
}

function computeTrendBadge(mainInflow: number, ratio: number, streak: string): string {
    if (streak.startsWith('连买')) {
        const days = parseInt(streak.replace(/[^0-9]/g, ''), 10) || 0;
        if (days >= 5) return '趋势：主力持续买入';
        if (days >= 3) return '趋势：资金逐步回流';
        return '趋势：资金温和流入';
    }
    if (streak.startsWith('连卖')) {
        const days = parseInt(streak.replace(/[^0-9]/g, ''), 10) || 0;
        if (days >= 5) return '趋势：主力持续流出';
        if (days >= 3) return '趋势：资金逐步撤离';
        return '趋势：资金温和流出';
    }
    if (mainInflow > 0) return '趋势：资金温和观察偏多';
    if (mainInflow < 0) return '趋势：资金温和观察偏空';
    return '趋势：资金温和观察';
}

function computeNarrative(mainInflow: number, ratio: number, orders: CapitalFlowOrder[]): string {
    const elgOrder = orders.find(o => o.label === '超大单');
    const lgOrder = orders.find(o => o.label === '大单');
    const elgVal = elgOrder?.value || 0;
    const lgVal = lgOrder?.value || 0;
    const absInflow = Math.abs(mainInflow);

    if (mainInflow > 3 && ratio >= 2) {
        return '主力资金大幅净流入，超大单和大单同步买入，显示机构资金积极进场。';
    }
    if (mainInflow > 0 && elgVal > 0 && lgVal > 0) {
        return '超大单和大单同步净买入，机构资金参与度较高，资金面偏积极。';
    }
    if (mainInflow > 0 && lgVal > 0 && elgVal <= 0) {
        return '大单净买入为主，超大单参与度一般，偏中户级别资金回补。';
    }
    if (mainInflow > 0 && elgVal > 0 && lgVal <= 0) {
        return '超大单净买入但大单流出，资金结构有分歧，需观察持续性。';
    }
    if (mainInflow > 0 && absInflow >= 1) {
        return '主力资金温和净流入，短线资金面偏积极但力度有限。';
    }
    if (mainInflow > 0) {
        return '主力资金微幅净流入，短线信号不明显，建议继续观察。';
    }
    if (mainInflow < -3 && ratio >= 2) {
        return '主力资金大幅净流出，超大单和大单同步卖出，短线资金面承压。';
    }
    if (mainInflow < 0 && elgVal < 0 && lgVal < 0) {
        return '超大单和大单同步净流出，机构资金离场意愿较强，注意风险。';
    }
    if (mainInflow < 0 && absInflow >= 1) {
        return '主力资金小幅净流出，短线资金面偏弱，建议观望为主。';
    }
    if (mainInflow < 0) {
        return '主力资金微幅净流出，短线压力有限但需关注后续变化。';
    }
    return '当前资金流向以温和观察为主，缺少明确方向信号。';
}

function computeRisk(mainInflow: number, ratio: number, streak: string): string {
    if (mainInflow > 0 && streak.startsWith('连买')) {
        const days = parseInt(streak.replace(/[^0-9]/g, ''), 10) || 0;
        if (days >= 5) return '连续买入天数较多，若主力净流入转负，需警惕抱团松动。';
        return '若主力净流入转负且大单流出放大，短线支撑会减弱。';
    }
    if (mainInflow > 0) {
        return '若主力净流入持续为负，短线资金面会偏弱。';
    }
    if (mainInflow < 0) {
        return '若流出持续扩大，短线可能进一步承压。';
    }
    return '资金面暂无明显方向，注意控制仓位。';
}

function parseNetAmount(buy: number, sell: number): number {
    return (Number(buy) || 0) - (Number(sell) || 0);
}

export async function getCapitalFlow(symbol: string): Promise<CapitalFlowResult> {
    // 北交所股票Tushare不支持，用新浪接口获取当日资金流向
    if (isBJStock(symbol)) {
        const sinaResult = await buildResultFromSina(symbol);
        if (sinaResult) return sinaResult;
        return buildEmptyResult(symbol);
    }

    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 20);
    const pad = (n: number) => n.toString().padStart(2, '0');
    const startDate = `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}`;

    const rows = await fetchMoneyFlow(symbol, startDate);
    if (!rows || rows.length === 0) {
        return buildEmptyResult(symbol);
    }

    const sorted = rows.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    const latest = sorted[sorted.length - 1];

    const elgNetWan = parseNetAmount(latest.buy_elg_amount, latest.sell_elg_amount);
    const lgNetWan = parseNetAmount(latest.buy_lg_amount, latest.sell_lg_amount);
    const mdNetWan = parseNetAmount(latest.buy_md_amount, latest.sell_md_amount);
    const smNetWan = parseNetAmount(latest.buy_sm_amount, latest.sell_sm_amount);

    const hasElgData = (Number(latest.buy_elg_amount) || 0) > 0 || (Number(latest.sell_elg_amount) || 0) > 0;

    const elgNet = elgNetWan / 10000;
    const lgNet = lgNetWan / 10000;
    const mdNet = mdNetWan / 10000;
    const smNet = smNetWan / 10000;

    const mainInflow = hasElgData
        ? Math.round((elgNet + lgNet) * 100) / 100
        : Math.round(lgNet * 100) / 100;

    const totalAmountWan = (Number(latest.buy_elg_amount) || 0) + (Number(latest.sell_elg_amount) || 0)
        + (Number(latest.buy_lg_amount) || 0) + (Number(latest.sell_lg_amount) || 0)
        + (Number(latest.buy_md_amount) || 0) + (Number(latest.sell_md_amount) || 0)
        + (Number(latest.buy_sm_amount) || 0) + (Number(latest.sell_sm_amount) || 0);
    const ratioVal = totalAmountWan > 0
        ? Math.round((mainInflow / (totalAmountWan / 10000)) * 1000) / 10
        : 0;
    const ratioStr = `${Math.abs(ratioVal).toFixed(1)}%`;

    const trendDays = sorted.slice(-10);
    const trend = trendDays.map(r => {
        const eNet = parseNetAmount(r.buy_elg_amount, r.sell_elg_amount) / 10000;
        const lNet = parseNetAmount(r.buy_lg_amount, r.sell_lg_amount) / 10000;
        const dayMain = hasElgData ? eNet + lNet : lNet;
        return Math.round(dayMain * 100) / 100;
    });
    const trendDates = trendDays.map(r => {
        const d = r.trade_date;
        return `${d.slice(4, 6)}/${d.slice(6, 8)}`;
    });

    const fiveDayRows = sorted.slice(-5);
    const fiveDay = Math.round(fiveDayRows.reduce((sum, r) => {
        const eNet = parseNetAmount(r.buy_elg_amount, r.sell_elg_amount) / 10000;
        const lNet = parseNetAmount(r.buy_lg_amount, r.sell_lg_amount) / 10000;
        const dayMain = hasElgData ? eNet + lNet : lNet;
        return sum + dayMain;
    }, 0) * 100) / 100;

    const orders: CapitalFlowOrder[] = hasElgData
        ? [
            { label: '超大单', value: Math.round(elgNet * 100) / 100 },
            { label: '大单', value: Math.round(lgNet * 100) / 100 },
            { label: '中单', value: Math.round(mdNet * 100) / 100 },
            { label: '小单', value: Math.round(smNet * 100) / 100 },
        ]
        : [
            { label: '大单', value: Math.round(lgNet * 100) / 100 },
            { label: '中单', value: Math.round(mdNet * 100) / 100 },
            { label: '小单', value: Math.round(smNet * 100) / 100 },
        ];

    const retailInflow = hasElgData
        ? Math.round((mdNet + smNet) * 100) / 100
        : Math.round((mdNet + smNet) * 100) / 100;

    const streak = computeStreak(trend);
    const { tag, tagClass } = computeTagAndClass(mainInflow, Math.abs(ratioVal), streak);
    const trendBadge = computeTrendBadge(mainInflow, Math.abs(ratioVal), streak);
    const narrative = computeNarrative(mainInflow, Math.abs(ratioVal), orders);
    const risk = computeRisk(mainInflow, Math.abs(ratioVal), streak);

    return {
        symbol,
        tradeDate: latest.trade_date,
        mainInflow,
        retailInflow,
        ratio: ratioStr,
        fiveDay,
        streak,
        tag,
        tagClass,
        trendBadge,
        narrative,
        risk,
        trend,
        trendDates,
        orders,
    };
}

/**
 * 用新浪单日资金流向数据构建结果（用于北交所股票）
 * 新浪接口只提供当日数据，趋势/连买连卖/5日数据仅以单日填充
 */
async function buildResultFromSina(symbol: string): Promise<CapitalFlowResult | null> {
    const raw = await getSinaMoneyflow(symbol);
    if (!raw) return null;

    const pad = (n: number) => n.toString().padStart(2, '0');
    const today = new Date();
    const tradeDate = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;

    // 新浪金额单位为元，转为万元
    const elgNet = Math.round((raw.r0_in - raw.r0_out) / 10000 * 100) / 100; // 特大单净额（万元）
    const lgNet = Math.round((raw.r1_in - raw.r1_out) / 10000 * 100) / 100;  // 大单净额（万元）
    const mdNet = Math.round((raw.r2_in - raw.r2_out) / 10000 * 100) / 100;  // 中单净额（万元）
    const smNet = Math.round((raw.r3_in - raw.r3_out) / 10000 * 100) / 100;  // 散单净额（万元）

    const mainInflow = Math.round((elgNet + lgNet) * 100) / 100;
    const retailInflow = Math.round((mdNet + smNet) * 100) / 100;
    const ratioVal = Math.abs(raw.r0x_ratio);
    const ratioStr = `${ratioVal.toFixed(1)}%`;

    const orders: CapitalFlowOrder[] = [
        { label: '超大单', value: elgNet },
        { label: '大单', value: lgNet },
        { label: '中单', value: mdNet },
        { label: '小单', value: smNet },
    ];

    const trend = [mainInflow];
    const trendDates = [`${tradeDate.slice(4, 6)}/${tradeDate.slice(6, 8)}`];
    const fiveDay = mainInflow;
    const streak = '单日数据';

    const { tag, tagClass } = computeTagAndClass(mainInflow, ratioVal, streak);
    const trendBadge = computeTrendBadge(mainInflow, ratioVal, streak);
    const narrative = computeNarrative(mainInflow, ratioVal, orders) + '（数据来源：新浪财经，北交所仅提供当日数据）';
    const risk = computeRisk(mainInflow, ratioVal, streak);

    return {
        symbol,
        tradeDate,
        mainInflow,
        retailInflow,
        ratio: ratioStr,
        fiveDay,
        streak,
        tag,
        tagClass,
        trendBadge,
        narrative,
        risk,
        trend,
        trendDates,
        orders,
    };
}

function buildEmptyResult(symbol: string): CapitalFlowResult {
    return {
        symbol,
        tradeDate: '',
        mainInflow: 0,
        retailInflow: 0,
        ratio: '0%',
        fiveDay: 0,
        streak: '无数据',
        tag: '无数据',
        tagClass: 'is-neutral',
        trendBadge: '趋势：暂无资金流向数据',
        narrative: '暂无资金流向数据，可能该股票不在Tushare资金流向覆盖范围内。',
        risk: '数据不足，无法判断资金面风险。',
        trend: [],
        trendDates: [],
        orders: [
            { label: '超大单', value: 0 },
            { label: '大单', value: 0 },
            { label: '中单', value: 0 },
            { label: '小单', value: 0 },
        ],
    };
}

const CAPITAL_FLOW_AI_SYSTEM_PROMPT = `你是一名A股资金流向分析师。根据资金流向数据生成简短分析。
规则：
1. 只输出一个JSON对象，不要任何解释、前后缀、Markdown代码块。
2. JSON仅含四个字段：tag、analysis、risk、trend。
3. tag：四字资金标签，如"主力抢筹""温和流出""机构加仓""散户主导""筹码松动"。
4. analysis：资金流向分析，约50字，含主力动向与博弈特征。
5. risk：短线风险提示，约20字。
6. trend：趋势提醒，10字以内，如"主力持续流入""资金逐步撤离"。
7. 四项总字数不超过110字。
8. 语言专业克制，避免空泛。`;

interface AiCapitalFlowResult {
    tag: string;
    analysis: string;
    risk: string;
    trend: string;
}

async function requestAiAnalysis(symbol: string, stockName: string, data: CapitalFlowResult): Promise<AiCapitalFlowResult | null> {
    const apiBaseUrl = process.env.OPENAI_API_BASE_URL;
    const apiKey = process.env.OPENAI_API_KEY;
    const evaModel = process.env.EVA_MODEL;
    if (!apiBaseUrl || !apiKey || !evaModel) return null;

    const prompt = `股票：${stockName}(${symbol})，日期：${data.tradeDate}
主力净流入：${data.mainInflow}亿元，散户净流入：${data.retailInflow}亿元
占比：${data.ratio}，5日累计：${data.fiveDay}亿元，连续状态：${data.streak}
标签：${data.tag}
10日主力净流入趋势：[${data.trend.join(', ')}]
资金拆解：超大单${data.orders.find(o => o.label === '超大单')?.value || 0}亿、大单${data.orders.find(o => o.label === '大单')?.value || 0}亿、中单${data.orders.find(o => o.label === '中单')?.value || 0}亿、小单${data.orders.find(o => o.label === '小单')?.value || 0}亿

请生成JSON格式的资金流向分析。`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await sessionFetch(apiBaseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: evaModel,
                temperature: 0.3,
                messages: [
                    { role: 'system', content: CAPITAL_FLOW_AI_SYSTEM_PROMPT },
                    { role: 'user', content: prompt },
                ],
            }),
            signal: controller.signal,
        });
        if (!response.ok) return null;
        const result: any = await response.json();
        let content = '';
        if (result.choices?.[0]?.message?.content) {
            content = result.choices[0].message.content.trim();
        } else if (result.output_text) {
            content = result.output_text.trim();
        } else if (typeof result.content === 'string') {
            content = result.content.trim();
        }
        if (!content) return null;
        const jsonStr = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(jsonStr);
        if (!parsed.tag || !parsed.analysis || !parsed.risk || !parsed.trend) return null;
        return { tag: String(parsed.tag), analysis: String(parsed.analysis), risk: String(parsed.risk), trend: String(parsed.trend) };
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function getStockName(symbol: string): Promise<string> {
    try {
        const result = await pool.query('SELECT name FROM stocks WHERE symbol = $1 LIMIT 1', [symbol]);
        return result.rows[0]?.name || symbol;
    } catch {
        return symbol;
    }
}

export async function getCapitalFlowWithAi(symbol: string): Promise<CapitalFlowResult> {
    const data = await getCapitalFlow(symbol);
    if (!data.tradeDate) return data;

    const ai = await requestAiAnalysis(symbol, await getStockName(symbol), data);
    if (ai) {
        data.tag = ai.tag;
        data.narrative = ai.analysis;
        data.risk = ai.risk;
        data.trendBadge = `趋势：${ai.trend}`;
    }
    return data;
}
