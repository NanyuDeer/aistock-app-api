/**
 * 融资盘出清 —— 纯状态机，无 IO。
 *
 * 为什么单独一个文件：回撤窗口、回合边界、首次上穿这三处最容易错，
 * 而它们全是纯计算。混在脚本里就只能「跑一次看看」，看不出边界错在哪天。
 */

export interface BalancePoint {
    date: string;
    balance: number;
}

export interface PurgeOptions {
    /** 回撤阈值，跌破即进入回合 */
    threshold: number;
    /** 一年高点的窗口（交易日） */
    peakWindow: number;
    /** 均线窗口（交易日） */
    maWindow: number;
    /** 少于这么多交易日就不判定（历史不足） */
    minHistory: number;
}

export const PURGE_DEFAULTS: PurgeOptions = {
    threshold: -0.08,
    peakWindow: 250,
    maWindow: 20,
    minHistory: 250,
};

export type PurgePhase = 'none' | 'purging' | 'easing';

/**
 * 回撤按 6 位小数取整后再比较。
 *
 * 不这么做会出真 bug：92/100 - 1 在浮点里是 -0.07999999999999996，
 * 比 -0.08 大，于是「正好跌 8%」不触发回合。而库里存的是 NUMERIC(8,5)，
 * 消费方看到的也是 -0.08000。状态机必须和存下去的数字一致，否则同一行数据
 * 在代码里和在库里是两件事。
 */
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export interface PurgeRow {
    tradeDate: string;
    balance: number;
    peak250: number | null;
    peakDate: string | null;
    drawdown: number | null;
    ma20: number | null;
    belowMa20Days: number;
    episodeId: number | null;
    episodeStart: string | null;
    episodeDays: number | null;
    phase: PurgePhase;
    eventKind: 'complete' | null;
}

/**
 * 逐日推进状态机。
 *
 * 回合 = 回撤连续 <= threshold 的区间。回合内首次余额上穿 `maWindow` 日均线记一次
 * `complete`；同一回合后续再上穿不再记 —— 那是同一次去杠杆里的反复，记两次等于
 * 把一次失败拆成一次失败加一次成功。
 */
export function buildPurgeSeries(
    points: BalancePoint[],
    opts: Partial<PurgeOptions> = {},
): PurgeRow[] {
    const o: PurgeOptions = { ...PURGE_DEFAULTS, ...opts };
    const rows: PurgeRow[] = [];

    let episodeId = 0;
    let episodeStart: string | null = null;
    let episodeDays = 0;
    let episodeHadEvent = false;
    let belowMa20Days = 0;
    let prevBalance: number | null = null;
    let prevMa20: number | null = null;
    let inEpisode = false;

    for (let i = 0; i < points.length; i += 1) {
        const { date, balance } = points[i];
        const history = i + 1;

        // 均线：不足窗口时为 null（不拿半截数据冒充均线）
        const ma20 = history >= o.maWindow
            ? points.slice(i - o.maWindow + 1, i + 1).reduce((s, p) => s + p.balance, 0) / o.maWindow
            : null;

        if (ma20 === null) belowMa20Days = 0;
        else belowMa20Days = balance < ma20 ? belowMa20Days + 1 : 0;

        // 回撤：不足 minHistory 时为 null（2016 年缺 2015 峰值，算了也是假象）
        let peak250: number | null = null;
        let peakDate: string | null = null;
        let drawdown: number | null = null;
        if (history >= o.minHistory) {
            const from = Math.max(0, i - o.peakWindow + 1);
            const win = points.slice(from, i + 1);
            let maxPoint = win[0];
            for (const p of win) if (p.balance > maxPoint.balance) maxPoint = p;
            peak250 = maxPoint.balance;
            peakDate = maxPoint.date;
            drawdown = peak250 > 0 ? round6(balance / peak250 - 1) : null;
        }

        const breach = drawdown !== null && drawdown <= o.threshold;

        let phase: PurgePhase = 'none';
        let eventKind: 'complete' | null = null;

        if (!breach) {
            inEpisode = false;
            episodeStart = null;
            episodeDays = 0;
            episodeHadEvent = false;
        } else {
            if (!inEpisode) {
                inEpisode = true;
                episodeId += 1;
                episodeStart = date;
                episodeDays = 1;
                episodeHadEvent = false;
            } else {
                episodeDays += 1;
            }
            phase = ma20 !== null && balance > ma20 ? 'easing' : 'purging';
            const crossedUp = ma20 !== null && prevMa20 !== null
                && prevBalance !== null && prevBalance <= prevMa20 && balance > ma20;
            if (crossedUp && !episodeHadEvent) {
                eventKind = 'complete';
                episodeHadEvent = true;
            }
        }

        rows.push({
            tradeDate: date,
            balance,
            peak250,
            peakDate,
            drawdown,
            ma20,
            belowMa20Days,
            episodeId: breach ? episodeId : null,
            episodeStart: breach ? episodeStart : null,
            episodeDays: breach ? episodeDays : null,
            phase,
            eventKind,
        });

        prevBalance = balance;
        prevMa20 = ma20;
    }

    return rows;
}
