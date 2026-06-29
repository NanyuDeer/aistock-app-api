export interface StockIdentity {
    market: 'sh' | 'sz' | 'bj' | 'unknown';
    board: string;
    eastmoneyId: 0 | 1;
    tencentPrefix: 'sh' | 'sz' | 'bj';
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
