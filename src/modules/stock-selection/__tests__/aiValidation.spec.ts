import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiEligible, aiRiskFlags, boundedAiPrompt, validateAiItem } from '../AiSelectionValidation';
import { SelectionCache } from '../SelectionSupport';

test('实际跌停价区分10%/20%板块；缺行情、停牌、状态缺失分别处理', () => {
    const base = { name: '样本', price: 8.9, quoteDate: '2026-11-20', tradeDate: '2026-11-20', suspended: false };
    assert.equal(aiEligible(aiRiskFlags({ ...base, limits: { lower: 8, upper: 12 } })), true);
    assert.equal(aiRiskFlags({ ...base, price: 9.004, limits: { lower: 9, upper: 11 } }).isLimitDown, true);
    assert.equal(aiRiskFlags({ ...base, price: null, limits: { lower: 8, upper: 12 } }).isSuspended, false);
    assert.equal(aiRiskFlags({ ...base, price: null, limits: { lower: 8, upper: 12 } }).quoteUnavailable, true);
    assert.equal(aiEligible(aiRiskFlags({ ...base, quoteDate: '2026-11-19', limits: { lower: 8, upper: 12 } })), false);
    assert.equal(aiEligible(aiRiskFlags({ ...base, suspended: true, limits: { lower: 8, upper: 12 } })), false);
    assert.equal(aiEligible(aiRiskFlags(base)), false);
    assert.equal(aiEligible(aiRiskFlags({ ...base, suspended: null, limits: { lower: 8, upper: 12 } })), false);
});
test('请求从第一只开始执行硬上限；压缩可选文本后保留真实数值', () => {
    const candidate = { symbol: '600001', news: [{ title: '长新闻'.repeat(1000) }], market: { price: 12.34 } };
    const result = boundedAiPrompt('system', '2026-11-20', [candidate], 200);
    assert.ok(result.promptChars <= 200);
    assert.equal((result.candidates[0].market as { price: number }).price, 12.34);
    assert.equal(result.candidates[0].news, undefined);
    assert.throws(() => boundedAiPrompt('system', 'today', [{ symbol: 'x'.repeat(1000) }], 100), /预算/);
    const many = boundedAiPrompt('system', 'today', Array.from({ length: 40 }, (_, i) => ({ symbol: String(i) })), 1000);
    assert.equal(many.candidates.length, 35);
});
test('模型指标引用须来自该股输入，缺字段、伪造数值、无引用数字与超长文案拒绝', () => {
    const input = { market: { price: 12.34 }, technical: { ma20: null } };
    const item = { reason: [{ field: 'market.price', analysis: '走势仍需观察' }], riskTip: '注意市场波动', recommendationLevel: '关注', evidence: [{ field: 'market.price', value: 12.34 }] };
    assert.deepEqual(validateAiItem(item, input).reason, ['现价12.34元；走势仍需观察']);
    assert.throws(() => validateAiItem({ ...item, evidence: [{ field: 'market.price', value: 21 }] }, input), /不一致/);
    assert.throws(() => validateAiItem({ ...item, evidence: [{ field: 'technical.ma20', value: 0 }] }, input), /不一致/);
    assert.throws(() => validateAiItem({ ...item, reason: [{ field: 'market.price', analysis: '净利润上涨21%' }] }, input), /自由填写数值/);
    assert.throws(() => validateAiItem({ ...item, reason: [{ field: 'market.price', analysis: '字'.repeat(41) }] }, input), /长度/);
    assert.throws(() => validateAiItem({ ...item, evidence: [] }, input), /引用/);
});
test('历史缓存按批次/组合隔离，容量有界且允许生成后清空', () => {
    const cache = new SelectionCache<number>(30_000, 2);
    cache.set('1:a:10', 10); cache.set('1:a:15', 15); cache.set('2:a:10', 20);
    assert.equal(cache.get('1:a:10'), undefined);
    assert.equal(cache.get('1:a:15'), 15);
    cache.clear(); assert.equal(cache.get('2:a:10'), undefined);
    const expired = new SelectionCache<number>(-1); expired.set('old', 1);
    assert.equal(expired.get('old'), undefined);
});


test('MA20和沪深300属于名称，正常理由通过；股价不能作为净利润增长数值', () => {
    const input = { market: { price: 12.34 }, technical: { ma20: 11.5 }, forecast: { netProfitGrowthPct: 5 } };
    const base = { recommendationLevel: '关注', riskTip: '注意波动', evidence: [{ field: 'market.price', value: 12.34 }] };
    for (const analysis of ['股价位于MA20上方', '与沪深300走势对比观察', '近20日走势仍需观察']) {
        const result = validateAiItem({ ...base, reason: [{ field: 'market.price', analysis }] }, input);
        assert.equal(result.reason[0], `现价12.34元；${analysis}`);
    }
    assert.throws(() => validateAiItem({ ...base, reason: ['净利润增长12.34%'] }, input), /绑定/);
    assert.throws(() => validateAiItem({ ...base, reason: [{ field: 'market.price', analysis: '净利润增长12.34%' }] }, input), /自由填写数值/);
    assert.throws(() => validateAiItem({ ...base, reason: [{ field: 'forecast.netProfitGrowthPct', analysis: '盈利预期改善' }] }, input), /对应指标引用/);
    const checked = validateAiItem({ ...base, reason: [{ field: 'forecast.netProfitGrowthPct', analysis: '盈利预期改善' }],
        evidence: [{ field: 'forecast.netProfitGrowthPct', value: 5 }] }, input);
    assert.deepEqual(checked.reason, ['预测净利润同比5%；盈利预期改善']);
    assert.throws(() => validateAiItem({ ...base, reason: [{ field: 'market.price', analysis: '涨幅１２％' }] }, input), /自由填写数值/);
});
