export interface StockIdentity {
    market: 'sh' | 'sz' | 'bj' | 'unknown';
    board: string;
    eastmoneyId: 0 | 1;
    tencentPrefix: 'sh' | 'sz' | 'bj';
}

/**
 * 归一化 A 股 6 位裸码（入环/写库两侧**共用同一实现**，禁止第二份正则）。
 *
 * 吃掉交易所前后缀与空白后再提取 6 位数字：`SH600383` / `600383.SH` / ` sh 600383 `
 * → `600383`；无法提取 6 位数字（如 `ABC`）→ 空串。
 *
 * 为什么共用：写库侧（StockInfoService.normalizeStockInfoJudgementInput）与入环候选
 * 提取侧（StockInfoPredictionService.extractCandidatePairs）若口径不一致，带前后缀的
 * symbol 会「写库归一化成功、入环侧严格匹配失败」→ 静默漏入环且不告警。
 */
export function normalizeStockSymbol(raw: unknown): string {
    const text = String(raw ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
    const match = text.match(/\d{6}/);
    return match ? match[0] : '';
}

export function getStockIdentity(symbol: string): StockIdentity {
    if (symbol.startsWith('600') || symbol.startsWith('601') || symbol.startsWith('603')) {
        return { market: 'sh', board: '沪市主板', eastmoneyId: 1, tencentPrefix: 'sh' };
    }
    if (symbol.startsWith('688')) {
        return { market: 'sh', board: '科创板', eastmoneyId: 1, tencentPrefix: 'sh' };
    }
    if (symbol.startsWith('900')) {
        return { market: 'sh', board: '沪市B股', eastmoneyId: 1, tencentPrefix: 'sh' };
    }
    if (symbol.startsWith('000') || symbol.startsWith('001')) {
        return { market: 'sz', board: '深市主板', eastmoneyId: 0, tencentPrefix: 'sz' };
    }
    if (symbol.startsWith('002') || symbol.startsWith('003')) {
        return { market: 'sz', board: '中小板', eastmoneyId: 0, tencentPrefix: 'sz' };
    }
    if (symbol.startsWith('300') || symbol.startsWith('301')) {
        return { market: 'sz', board: '创业板', eastmoneyId: 0, tencentPrefix: 'sz' };
    }
    if (symbol.startsWith('200')) {
        return { market: 'sz', board: '深市B股', eastmoneyId: 0, tencentPrefix: 'sz' };
    }
    if (symbol.startsWith('920')) {
        return { market: 'bj', board: '北交所', eastmoneyId: 0, tencentPrefix: 'bj' };
    }
    return { market: 'unknown', board: '未知板块', eastmoneyId: 1, tencentPrefix: 'sh' };
}
