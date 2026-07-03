/**
 * 交易日历服务
 *
 * 提供A股交易日判断，基于周末规则 + 节假日列表。
 * 节假日列表每年初手动更新（或从 Tushare trade_cal 接口获取）。
 */

// 2026年A股节假日（每年初更新）
const HOLIDAYS_2026: Set<string> = new Set([
    '2026-01-01', // 元旦
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', // 春节
    '2026-04-04', '2026-04-05', '2026-04-06', // 清明
    '2026-05-01', '2026-05-02', '2026-05-03', // 劳动节
    '2026-06-19', '2026-06-20', '2026-06-21', // 端午
    '2026-09-25', '2026-09-26', '2026-09-27', // 中秋
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', // 国庆
]);

export class TradingCalendarService {
    /**
     * 判断指定日期是否为A股交易日
     */
    static isTradingDay(date: Date = new Date()): boolean {
        // 周六、周日不交易
        if (date.getDay() === 0 || date.getDay() === 6) return false;

        const dateStr = date.toISOString().slice(0, 10);
        if (HOLIDAYS_2026.has(dateStr)) return false;

        return true;
    }

    /**
     * 获取最近的一个交易日（向前回溯）
     * 如果今天是交易日且在收盘后（15:00之后），返回今天
     * 如果今天不是交易日或在盘中，返回上一个交易日
     */
    static getRecentTradingDay(date: Date = new Date()): Date {
        const result = new Date(date);
        // 如果在盘中（<15:00），回溯到上一个交易日
        if (result.getHours() < 15) {
            result.setDate(result.getDate() - 1);
        }
        while (!this.isTradingDay(result)) {
            result.setDate(result.getDate() - 1);
        }
        return result;
    }

    /**
     * 根据当前时间动态计算快讯时间窗口（小时）
     *
     * 策略：
     * - 交易日盘中（9:30-15:00）：2小时（保持灵敏度）
     * - 交易日盘后（15:00-24:00）：6小时（覆盖盘后资讯）
     * - 交易日盘前（0:00-9:30）：12小时（覆盖前一日夜间资讯）
     * - 非交易日（周末/节假日）：72小时（3天，覆盖到上一个交易日）
     */
    static getDynamicWindowHours(): number {
        const now = new Date();

        if (!this.isTradingDay(now)) {
            // 非交易日：3天窗口
            return 72;
        }

        const hour = now.getHours();
        if (hour >= 9 && hour < 15) {
            // 交易日盘中：2小时
            return 2;
        } else if (hour >= 15) {
            // 交易日盘后：6小时
            return 6;
        } else {
            // 交易日盘前：12小时
            return 12;
        }
    }

    /**
     * 获取飞书消息查询窗口（小时）
     *
     * 策略：
     * - 交易日：24小时（覆盖前一日讨论）
     * - 非交易日：72小时（3天滚动窗口）
     */
    static getFeishuWindowHours(): number {
        return this.isTradingDay() ? 24 : 72;
    }
}
