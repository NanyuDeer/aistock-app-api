/**
 * 基线 claim 验证 —— 纯判断逻辑，无 IO。
 *
 * 为什么要单独一个文件：这些判断（解析、到期、收益、命中、去重叠）是验证的正确性所在，
 * 而 DB 读写只是搬运。混在一起就没法单测，只能靠"跑一次看看"。
 */

export const SOURCE_REF_PREFIX = 'frd:';

export interface SourceRef {
    dim: string;
    bucket: number;
    horizon: number;
    segment: string;
    caliber: string;
    specVersion: string;
}

export function buildSourceRef(p: SourceRef): string {
    return `${SOURCE_REF_PREFIX}${p.dim}|${p.bucket}|${p.horizon}|${p.segment}|${p.caliber}|${p.specVersion}`;
}

/**
 * 解析 `frd:{dim}|{bucket}|{horizon}|{segment}|{caliber}|{spec_version}`。
 * 任何不合规（前缀不对、段数不对、bucket/horizon 非整数）都返回 null ——
 * 验证器据此跳过，**不猜测、不修复**。
 */
export function parseSourceRef(ref: string | null | undefined): SourceRef | null {
    if (typeof ref !== 'string' || !ref.startsWith(SOURCE_REF_PREFIX)) return null;
    const parts = ref.slice(SOURCE_REF_PREFIX.length).split('|');
    if (parts.length !== 6) return null;
    const [dim, bucketRaw, horizonRaw, segment, caliber, specVersion] = parts;
    if (!dim || !segment || !caliber || !specVersion) return null;
    if (!/^-?\d+$/.test(bucketRaw) || !/^\d+$/.test(horizonRaw)) return null;
    const bucket = Number(bucketRaw);
    const horizon = Number(horizonRaw);
    if (horizon <= 0) return null;
    return { dim, bucket, horizon, segment, caliber, specVersion };
}

/** 命中判定：L1 方向、L2 区间。边界值算在区间内。 */
export function judge(actualRet: number, p25: number, p75: number): { isUp: boolean; inIqr: boolean } {
    return {
        isUp: actualRet > 0,
        inIqr: actualRet >= p25 && actualRet <= p75,
    };
}

/**
 * as_of 之后第 horizonDays 个交易日的下标。
 * 返回 null 表示**未到期或数据不足** —— 调用方必须据此跳过，不做部分窗口的"提前验证"。
 */
export function dueIndex(dates: string[], asOf: string, horizonDays: number): number | null {
    const start = dates.indexOf(asOf);
    if (start < 0 || horizonDays <= 0) return null;
    const due = start + horizonDays;
    return due < dates.length ? due : null;
}

/**
 * as_of 收盘 → as_of+days 收盘 的区间收益，用净值复利。
 * 窗口内出现非有限值就整段作废（不插值、不跳过）—— 补出来的收益会污染命中率。
 */
export function forwardReturn(returns: number[], asOfIdx: number, days: number): number | null {
    if (asOfIdx < 0 || days <= 0) return null;
    if (asOfIdx + days >= returns.length) return null;
    let acc = 1;
    for (let k = 1; k <= days; k += 1) {
        const r = returns[asOfIdx + k];
        if (!Number.isFinite(r)) return null;
        acc *= 1 + r;
    }
    return acc - 1;
}

/**
 * 去重叠抽样：按 as_of 升序，贪心取第一条，然后跳过所有与它窗口重叠的。
 *
 * 为什么要这一步：连续两天的 20 日窗口几乎完全重叠，把它们当两次独立验证
 * 会让命中率虚高或虚低。这跟 n_eff 是同一个坑，只是从"样本量"挪到了"验证"。
 */
export function selectNonOverlapping<T extends { asOfIdx: number; horizonDays: number }>(rows: T[]): T[] {
    const sorted = [...rows].sort((a, b) => a.asOfIdx - b.asOfIdx);
    const kept: T[] = [];
    let nextFree = -1;
    for (const row of sorted) {
        if (row.asOfIdx < nextFree) continue;
        kept.push(row);
        nextFree = row.asOfIdx + row.horizonDays;
    }
    return kept;
}
