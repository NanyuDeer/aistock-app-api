import assert from 'node:assert/strict';
import test from 'node:test';
import { rankLeadingStockCandidates, type LeadingStockCandidate } from '../WindLeaderAnalyzerService';

// 风口板块龙头股排序：先按成分集合剔除无关股，再逐级排序
// 排序优先级：当日涨停 → 连板数 → 当日涨幅 → 成交额 → 流通市值（仅兜底）

function cand(partial: Partial<LeadingStockCandidate> & { code: string; name: string }): LeadingStockCandidate {
    return partial;
}

test('rankLeadingStockCandidates drops candidates outside the constituent set', () => {
    const candidates = [
        cand({ code: '605303', name: '园林股份', change_pct: 9.99, float_market_cap: 999999 }),
        cand({ code: '300750', name: '宁德时代', change_pct: 3.2 }),
    ];
    const result = rankLeadingStockCandidates(candidates, new Set(['300750', '600519']));
    assert.ok(result, '成分内股票应被选中');
    assert.equal(result!.code, '300750');
    assert.equal(result!.name, '宁德时代');
});

test('rankLeadingStockCandidates prefers limit-up over a higher change_pct non-limit-up', () => {
    const candidates = [
        cand({ code: '600001', name: '高涨幅未涨停', change_pct: 9.5 }),
        cand({ code: '600002', name: '涨停股', change_pct: 8.0, is_limit_up: true }),
    ];
    const result = rankLeadingStockCandidates(candidates, new Set(['600001', '600002']));
    assert.equal(result!.code, '600002');
});

test('rankLeadingStockCandidates prefers higher board_count within limit-up stocks', () => {
    const candidates = [
        cand({ code: '600001', name: '首板', change_pct: 10, is_limit_up: true, board_count: 1 }),
        cand({ code: '600002', name: '三连板', change_pct: 10, is_limit_up: true, board_count: 3 }),
    ];
    const result = rankLeadingStockCandidates(candidates, new Set(['600001', '600002']));
    assert.equal(result!.code, '600002');
});

test('rankLeadingStockCandidates falls back to amount when change_pct ties', () => {
    const candidates = [
        cand({ code: '600001', name: '小成交额', change_pct: 5.5, amount: 1000, float_market_cap: 900000 }),
        cand({ code: '600002', name: '大成交额', change_pct: 5.5, amount: 8000, float_market_cap: 100 }),
    ];
    const result = rankLeadingStockCandidates(candidates, new Set(['600001', '600002']));
    assert.equal(result!.code, '600002');
});

test('rankLeadingStockCandidates falls back to float market cap when amount ties', () => {
    const candidates = [
        cand({ code: '600001', name: '小市值', change_pct: 5.5, amount: 1000, float_market_cap: 100 }),
        cand({ code: '600002', name: '大市值', change_pct: 5.5, amount: 1000, float_market_cap: 900000 }),
    ];
    const result = rankLeadingStockCandidates(candidates, new Set(['600001', '600002']));
    assert.equal(result!.code, '600002');
});

test('rankLeadingStockCandidates treats missing numeric fields as 0', () => {
    const candidates = [
        cand({ code: '600001', name: '缺数据' }),
        cand({ code: '600002', name: '有涨幅', change_pct: 1 }),
    ];
    const result = rankLeadingStockCandidates(candidates, new Set(['600001', '600002']));
    assert.equal(result!.code, '600002');
});

test('rankLeadingStockCandidates keeps legacy behavior when constituent set is empty', () => {
    const candidates = [
        cand({ code: '605303', name: '园林股份', change_pct: 2 }),
        cand({ code: '300750', name: '宁德时代', change_pct: 6 }),
    ];
    const result = rankLeadingStockCandidates(candidates, new Set());
    assert.equal(result!.code, '300750', '成分集合为空时不做剔除，仍按涨幅排序');
});

test('rankLeadingStockCandidates returns null when all candidates are excluded', () => {
    const candidates = [
        cand({ code: '605303', name: '园林股份', change_pct: 9.99 }),
        cand({ code: '603999', name: '无关股', change_pct: 5 }),
    ];
    assert.equal(rankLeadingStockCandidates(candidates, new Set(['300750'])), null);
});

test('rankLeadingStockCandidates returns null for empty candidate list', () => {
    assert.equal(rankLeadingStockCandidates([], new Set(['300750'])), null);
});
