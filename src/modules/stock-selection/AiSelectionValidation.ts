export interface AiRiskInput {
    name: string; price: number | null; quoteDate: string | null; tradeDate: string;
    suspended: boolean | null; limits?: { upper: number | null; lower: number | null };
}
export function aiRiskFlags(input: AiRiskInput): Record<string, boolean> {
    const validPrice = input.price !== null && Number.isFinite(input.price) && input.price > 0;
    const cents = (n: number) => Math.round(n * 100);
    return {
        isST: /ST|退/i.test(input.name), isSuspended: input.suspended === true,
        quoteUnavailable: !validPrice || input.quoteDate !== input.tradeDate,
        tradingStatusUnavailable: input.suspended === null || !input.limits || input.limits.lower === null,
        isLimitUp: Boolean(validPrice && input.limits?.upper && cents(input.price!) >= cents(input.limits.upper)),
        isLimitDown: Boolean(validPrice && input.limits?.lower && cents(input.price!) <= cents(input.limits.lower)),
    };
}
export function aiEligible(flags: Record<string, boolean>) {
    return !['isST', 'isSuspended', 'isLimitDown', 'quoteUnavailable', 'tradingStatusUnavailable'].some(key => flags[key]);
}

/** Measures the exact system + user text; every addition, including the first candidate, must fit. */
export function boundedAiPrompt(system: string, timestamp: string, candidates: Record<string, unknown>[], maxChars: number, limit = 35) {
    const selected: Record<string, unknown>[] = [];
    const user = () => `数据截至 ${timestamp}，候选股数 ${selected.length}。候选池：${JSON.stringify(selected)}`;
    for (const candidate of candidates.slice(0, limit)) {
        selected.push(candidate);
        if (system.length + user().length > maxChars) {
            selected.pop();
            // Drop optional prose first, keeping numeric fields unchanged for evidence validation.
            const reduced = JSON.parse(JSON.stringify(candidate)) as Record<string, unknown>;
            delete reduced.news;
            for (const key of ['forecast', 'shortTerm']) {
                const detail = reduced[key] as Record<string, unknown> | undefined;
                if (detail) { delete detail.summary; delete detail.signals; }
            }
            selected.push(reduced);
            if (system.length + user().length > maxChars) selected.pop();
        }
    }
    if (!selected.length || system.length + user().length > maxChars) throw new Error('模型请求预算不足或有效候选为空');
    return { candidates: selected, userPrompt: user(), promptChars: system.length + user().length };
}

function fieldValue(input: Record<string, unknown>, path: string): unknown {
    if (!/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)*$/.test(path)) return undefined;
    let value: unknown = input;
    for (const part of path.split('.')) {
        if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
        value = (value as Record<string, unknown>)[part];
    }
    return value;
}
// Only fields with a known display meaning/unit may become numeric claims.
const METRIC_LABELS: Record<string, [string, string]> = {
    'market.price': ['现价', '元'], 'market.changePct': ['当日涨跌幅', '%'],
    'market.turnoverRatePct': ['换手率', '%'], 'market.peTtm': ['市盈率TTM', '倍'],
    'technical.ma20': ['MA20', '元'], 'technical.ma60': ['MA60', '元'],
    'technical.return5dPct': ['近5日涨跌幅', '%'], 'technical.return20dPct': ['近20日涨跌幅', '%'],
    'technical.distanceToHigh20dPct': ['距20日高点', '%'], 'technical.maxDrawdown20dPct': ['20日最大回撤', '%'],
    'forecast.epsForecast': ['预测每股收益', '元'], 'forecast.netProfitGrowthPct': ['预测净利润同比', '%'],
    'forecast.epsGrowthPct': ['预测每股收益同比', '%'], 'trend.score': ['趋势评分', '分'],
    'institution.resonanceCount': ['调研共振次数', '次'], 'capitalFlow.mainNetRatio': ['主力净流入占比', '%'],
};
function qualitativeText(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || [...value].length > 18) throw new Error('模型分析格式或长度不合法');
    // Identifier/period digits are names, not observed metric values. All other numeric claims are rendered below.
    const prose = value.replace(/\bMA(?:5|20|60)\b/gi, '')
        .replace(/沪深300/g, '')
        .replace(/(?:90|75|60|20|10|5|3)(?:个交易日|交易日|日|天|年)/g, '');
    if (/\p{N}/u.test(prose) || /百分之|[零〇一二三四五六七八九十百千万亿两]+(?:元|倍|成|个百分点|家|次)/.test(prose)) throw new Error('模型分析不得自由填写数值，请引用指标字段');
    return value.trim();
}
export function validateAiItem(item: Record<string, unknown>, input: Record<string, unknown>) {
    if (!Array.isArray(item.reason) || item.reason.length < 1 || item.reason.length > 2) throw new Error('模型理由格式或长度不合法');
    if (typeof item.riskTip !== 'string' || !item.riskTip.trim() || [...item.riskTip].length > 30) throw new Error('模型风险提示不合法');
    if (!['较高', '中等', '关注'].includes(String(item.recommendationLevel))) throw new Error('模型推荐等级不合法');
    if (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 6) throw new Error('模型缺少指标引用');
    const evidence: Array<{ field: string; value: number }> = [];
    for (const reference of item.evidence) {
        if (!reference || typeof reference.field !== 'string' || !Object.prototype.hasOwnProperty.call(METRIC_LABELS, reference.field)
            || typeof reference.value !== 'number' || !Number.isFinite(reference.value)
            || fieldValue(input, reference.field) !== reference.value) throw new Error('模型引用指标与输入不一致或指标不受支持');
        evidence.push({ field: reference.field, value: reference.value });
    }
    const reason = item.reason.map(raw => {
        if (!raw || typeof raw !== 'object' || typeof raw.field !== 'string') throw new Error('模型理由必须绑定具体指标字段');
        const reference = evidence.find(reference => reference.field === raw.field);
        if (!reference) throw new Error('模型理由缺少对应指标引用');
        const analysis = qualitativeText(raw.analysis);
        const [label, unit] = METRIC_LABELS[reference.field];
        // Label, number and unit come exclusively from the validated field, never a model-written numeric sentence.
        const rendered = `${label}${reference.value}${unit}；${analysis}`;
        if ([...rendered].length > 40) throw new Error('模型理由渲染后长度超过40字');
        return rendered;
    });
    return { reason, riskTip: item.riskTip, recommendationLevel: item.recommendationLevel as string, evidence };
}
