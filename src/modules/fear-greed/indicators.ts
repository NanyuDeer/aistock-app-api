/**
 * 恐贪指数通用工具（纯函数，无 IO）。
 * 从 Python 版 fear-greed（indicators/base.py）翻译，算法口径保持一致。
 */

/** 限制数值在 [lo, hi] 区间 */
export function clamp(v: number, lo = 0, hi = 100): number {
    return Math.max(lo, Math.min(hi, v));
}

/**
 * 计算 value 在 history 序列中的经验分布百分位（0-100）。
 * 口径：小于 value 的数量 + 等于 value 的一半，除以总数。
 */
export function percentileRank(value: number, history: number[]): number {
    if (!history || history.length === 0) return 50;
    let less = 0;
    let equal = 0;
    for (const h of history) {
        if (h < value) less += 1;
        else if (h === value) equal += 1;
    }
    return ((less + 0.5 * equal) / history.length) * 100;
}

/** 历史不足 30 条时返回中性 50（避免短样本抖动） */
export function pctRankOrNeutral(series: number[], current: number): number {
    if (series.length < 30) return 50;
    return percentileRank(current, series);
}

/**
 * 双层百分位聚合第二步：对逐日 rawAvg 序列做百分位排名。
 *
 * 背景：rawAvg = 各指标百分位等权平均，方差被压缩（σ/√9），天然收窄到 [33,67]。
 * 再对 rawAvg 序列做百分位排名后，分布自动覆盖 0-100 全区间：
 * 历史最恐惧日 → ≈0，历史最贪婪日 → ≈100，无需手工调参数。
 *
 * rawAvgs 约定「最新在前」；返回 scores 与 rawAvgs 同序，
 * composite = scores[0]（最新日在其余历史日中的排名）；样本 <30 时 composite 退回均值防抖。
 */
export function compositeOfRawAvgs(rawAvgs: number[]): { composite: number; scores: number[] } {
    if (rawAvgs.length === 0) return { composite: 50, scores: [] };
    const scores = rawAvgs.map((v, i) => {
        const others = rawAvgs.filter((_, j) => j !== i);
        return Math.round(percentileRank(v, others) * 100) / 100;
    });
    // 短样本直接用 rawAvg 兜底（与 pctRankOrNeutral 一致，避免初启动几天的抖动）
    const composite = rawAvgs.length >= 30
        ? scores[0]
        : Math.round(clamp(rawAvgs[0], 0, 100) * 100) / 100;
    return { composite, scores };
}

/** 综合指数得分 → 恐贪中文标签（与温度计分档一致，冰点阈值 20） */
export function labelOf(score: number): string {
    if (score < 20) return '极度恐惧';
    if (score < 45) return '恐惧';
    if (score < 55) return '中性';
    if (score < 80) return '贪婪';
    return '极度贪婪';
}

/** 得分 → 状态标签（较高/较低/中性，用于单指标） */
export function levelOf(score: number): string {
    if (score >= 70) return '较高';
    if (score <= 30) return '较低';
    return '中性';
}

/**
 * 生成最近 window 日的历史 score 序列（倒序：最新在前，供纵轴时间折线图）。
 * reverse=true 时取 100 - 百分位（波动率等方向反转指标）。
 * 日期与序列按「序列末尾对齐」：取 dates 的最后 recentS.length 条，
 * 兼容 series 比 dates 短的场景（如波动率序列滞后 20 日）。
 */
export function sparkline(
    series: number[],
    dates: string[],
    window: number,
    reverse = false,
): { dates: string[]; scores: number[] } {
    const recentS = series.slice(-window);
    const offset = dates.length - recentS.length;
    const recentD = offset >= 0 ? dates.slice(offset) : recentS.map(() => '');
    const scores: number[] = [];
    for (const v of recentS) {
        const p = percentileRank(v, series);
        scores.push(Math.round((reverse ? 100 - p : p) * 100) / 100);
    }
    return { dates: recentD.slice().reverse(), scores: scores.slice().reverse() };
}
