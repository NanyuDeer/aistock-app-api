/**
 * 60日均线剔除规则
 *
 * 规则：连续两日收盘价在60日均线下方 → 从趋势股列表剔除
 *       重新站上60日线 → 搂回（不剔除）
 *
 * 判定逻辑：
 * - 当前日收盘价 < 当前60日均线
 * - 且 前一交易日收盘价 < 前一日的60日均线
 * - 两个条件同时满足才剔除（避免单日假跌破）
 */
export function calcMa60Excluded(closes: number[]): boolean {
    // 数据不足时无法判断，保守不剔除
    if (closes.length < 61) return false;

    const currentClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];

    // 当前60日均线（最近60根收盘价均值）
    const ma60 = closes.slice(-60).reduce((a, b) => a + b, 0) / 60;
    // 前一交易日的60日均线（倒数第2到倒数第61根）
    const ma60Prev = closes.slice(-61, -1).reduce((a, b) => a + b, 0) / 60;

    return currentClose < ma60 && prevClose < ma60Prev;
}
