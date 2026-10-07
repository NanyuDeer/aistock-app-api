/**
 * cron 交易日守卫 —— 非交易日跳过并留审计日志（spec §7）。
 * 设计要点：跳过不是静默，日志格式固定为 [SkipNonTradingDay] job=<name> date=<YYYY-MM-DD> reason=<source>。
 */
import { tradingCalendarStore } from './tradingCalendarStore';
import { shanghaiDateTimeParts } from './shanghaiTime';

export const __cronGuardDependencies = {
    isTradingDay: (isoDate: string) => tradingCalendarStore.isTradingDay(isoDate),
    today: () => {
        const p = shanghaiDateTimeParts(new Date());
        const pad = (n: number) => String(n).padStart(2, '0');
        return p ? `${p.year}-${pad(p.month)}-${pad(p.day)}` : '';
    },
};

export async function runIfTradingDay(jobName: string, fn: () => Promise<void> | void): Promise<void> {
    let isoDate = '';
    try {
        isoDate = __cronGuardDependencies.today();
        if (!__cronGuardDependencies.isTradingDay(isoDate)) {
            console.log(`[SkipNonTradingDay] job=${jobName} date=${isoDate} reason=trading_calendar`);
            return;
        }
    } catch (err: unknown) {
        // 守卫自身异常：告警后仍执行（宁多跑一次，不因守卫让任务停摆）
        console.error(`[CronGuard] 守卫异常，按交易日继续执行 job=${jobName}:`, err instanceof Error ? err.message : String(err));
    }
    await fn();
}
