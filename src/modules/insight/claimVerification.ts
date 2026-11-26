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
