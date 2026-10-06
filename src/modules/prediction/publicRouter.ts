import { Router, type Request, type Response } from 'express';
import { PredictionRecordService, type PredictionRecordRow, type PredictionVerificationEntry } from './PredictionRecordService';

const router: Router = Router();

const VALID_STATUSES = ['pending', 'verified', 'skipped'] as const;
/** 历史跟踪页可选的记录类型（大盘溯源 vs 板块预判）；缺省返回全部（兼容调用方） */
const VALID_SOURCE_TYPES = ['market_trace', 'sector_prediction'] as const;

/**
 * 当前生产验证口径版本（版本 4.0：默认过滤 4.0，防跳变/混桶）。
 * 四处同批保持 4.0：agent-py prediction_stats._CURRENT_METHODOLOGY_VERSION、
 * prediction_validator._METHODOLOGY_VERSION、skills/prediction_validation._PROFILE_METHODOLOGY_VERSION、本文件。
 * ⚠️ prediction_validator._BACKFILL_METHODOLOGY_VERSION（"2.0"）是存量回补口径、独立保持不动，不在此清单。
 * 存量记录按各自旧版本隔离统计（无版本记录随 2.0 时代隔离，不再兼容计入）。
 */
const CURRENT_METHODOLOGY_VERSION = '4.0'

/** verification entry 是否属于当前统计版本（严格等于 CURRENT_METHODOLOGY_VERSION；无版本旧记录随之隔离不计入） */
function versionOk(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const mv = (e as { methodology_version?: unknown }).methodology_version
  return mv === CURRENT_METHODOLOGY_VERSION
}

/**
 * 舍入到 4 位小数，与 agent-py `round(..., 4)` 对齐。
 * 仅用于新增指标 settled_ratio / flat_rate（同一批记录两侧须产出同一数值）；
 * 既有 hitRate 的舍入行为不改（保持向后兼容）。
 */
function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4
}

/** 测试注入点（tsx ESM live binding 无法 patch 模块私有函数，沿用仓库 __xxxDependencies 模式） */
export const __predictionPublicDependencies = {
  list: (params: { status?: 'pending' | 'verified' | 'skipped'; source_id?: string; source_type?: 'market_trace' | 'sector_prediction'; page: number; pageSize: number }) =>
    PredictionRecordService.list(params),
  listAllForStats: (status?: 'pending' | 'verified' | 'skipped', source_id?: string, source_type?: 'market_trace' | 'sector_prediction') =>
    PredictionRecordService.listAllForStats(status, source_id, source_type),
  getById: (id: number) => PredictionRecordService.getById(id),
};

/** Express 5 params 可能为 string | string[]，安全取 string */
function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : (val || '');
}

/** 从 source_id（review:YYYY-MM-DD）解析报告日期；失败回退 created_at 的上海日期（UTC+8） */
function resolveReportDate(sourceId: string, createdAt: string): string {
  const match = /^review:(\d{4}-\d{2}-\d{2})$/.exec(sourceId);
  if (match) return match[1];
  const ts = Date.parse(createdAt);
  if (Number.isNaN(ts)) return '';
  const d = new Date(ts + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** DB 行 → 响应项（补充 report_date，id 归一为数字——pg 对 BIGSERIAL 返回 string） */
function toItem(row: PredictionRecordRow) {
  return { ...row, id: Number(row.id), report_date: resolveReportDate(row.source_id, row.created_at) };
}

/** 提取记录的三档 horizon 键 */
function horizonKeys(row: PredictionRecordRow): string[] {
  const horizons = (row.prediction as { horizons?: Array<{ horizon: string }> })?.horizons;
  if (!Array.isArray(horizons)) return [];
  return horizons.map((h) => h.horizon);
}

/** 越年近似档位集合（P2 裁决：approximate 档到期日为近似，命中率统计需分桶排除） */
function approximateHorizonSet(row: PredictionRecordRow): Set<string> {
  const approx = (row.prediction as { due_dates_approximate?: unknown })?.due_dates_approximate;
  if (!Array.isArray(approx)) return new Set();
  return new Set(approx.filter((h): h is string => typeof h === 'string'));
}

/** long 档命中率单列（不进迭代看板；无样本时 hitRate=null） */
interface LongStats {
  n: number;
  hits: number;
  hitRate: number | null;
}

/** 方向/档位子桶统计（与主桶同形：n/hits/hitRate/sufficientSample + flat 指标） */
interface SubBucketStats {
  n: number;
  hits: number;
  hitRate: number | null;
  sufficientSample: boolean;
  flat_rate: number | null;
  flat_count: number;
  directional_count: number;
}

/**
 * 给定一组已结算 entry（4.0 hit/miss、非近似、非 long）→ 命中率子桶摘要。
 *
 * 方向桶 / 档位桶共用的**唯一聚合实现**（避免为每个维度手写一份聚合）。
 * 无样本时 hitRate=null（与 long 单列、agent-py `_bucket_metrics` 同口径，不用 0）；
 * flat_rate 分母 = 该组内方向预判数（bullish/bearish；无方向样本 → null）。
 */
function summarizeSettled(entries: PredictionVerificationEntry[]): SubBucketStats {
  const n = entries.length;
  const hits = entries.filter((e) => e.result === 'hit').length;
  const directional = entries.filter((e) => e.direction === 'bullish' || e.direction === 'bearish');
  const flatCount = directional.filter((e) => e.flat === true).length;
  const directionalCount = directional.length;
  return {
    n,
    hits,
    hitRate: n ? round4(hits / n) : null,
    sufficientSample: n >= 30,
    flat_rate: directionalCount ? round4(flatCount / directionalCount) : null,
    flat_count: flatCount,
    directional_count: directionalCount,
  };
}

/** 方向维度子桶（每个带 flat_rate；分母 = 该方向已结算数，用于判读"看多方向是否特别容易落在无信息带"） */
interface DirectionBuckets {
  bullish: SubBucketStats;
  bearish: SubBucketStats;
  neutral: SubBucketStats;
}

/** 档位维度子桶；long 单列并标注 iteration_board=false（不参与迭代判读，§4.7） */
interface HorizonBuckets {
  short: SubBucketStats;
  mid: SubBucketStats;
  long: SubBucketStats & { iteration_board: false };
}

/** 按方向 / 档位切分子桶（与主桶同口径：4.0 + hit/miss + 非近似；long 不进方向桶）。 */
function dimensionBuckets(
  settledEntries: PredictionVerificationEntry[],
  longSettledEntries: PredictionVerificationEntry[],
): { directionBuckets: DirectionBuckets; horizonBuckets: HorizonBuckets } {
  return {
    directionBuckets: {
      bullish: summarizeSettled(settledEntries.filter((e) => e.direction === 'bullish')),
      bearish: summarizeSettled(settledEntries.filter((e) => e.direction === 'bearish')),
      neutral: summarizeSettled(settledEntries.filter((e) => e.direction === 'neutral')),
    },
    horizonBuckets: {
      short: summarizeSettled(settledEntries.filter((e) => e.horizon === 'short')),
      mid: summarizeSettled(settledEntries.filter((e) => e.horizon === 'mid')),
      // long 单列：显式标注不参与迭代判读（与既有 long 字段口径一致）
      long: { ...summarizeSettled(longSettledEntries), iteration_board: false },
    },
  };
}

/** 单桶统计（combined/index/sector 同形；Task 5 补 long 排除与看板指标） */
interface BucketStats {
  n: number;
  hits: number;
  hitRate: number;
  sufficientSample: boolean;
  /** 是否检测到 long 档样本并被排除出迭代看板（§4.7；版本过滤与 agent-py _long_entries 一致） */
  long_excluded: boolean;
  /** 已结算 / 该桶非-long、非-近似声明档位总数（含真 pending；无档位时为 null） */
  settled_ratio: number | null;
  /** flat 占比 = flat_count / directional_count（无方向样本时为 null；由 agent-py 写入侧判定 |x| < k） */
  flat_rate: number | null;
  flat_count: number;
  directional_count: number;
  /** long 档命中率单列交付（用户可见；不进迭代看板） */
  long: LongStats;
  /** §8-3 方向桶 × 档位桶（与 computeStats 同口径同值；long 单列并标注不参与迭代判读） */
  directionBuckets: DirectionBuckets;
  horizonBuckets: HorizonBuckets;
}

/** 声明档位槽：来源 = 记录声明的 horizons（而非仅 verification entry），含真 pending。 */
interface HorizonSlot {
  horizon: string;
  targetType: string;
  approximate: boolean;
  entry: PredictionVerificationEntry | undefined;
}

/** 该 entry 是否已按当前生产版本结算（hit/miss + 当前版本）：settled_ratio 的分子口径。 */
function isSettledCurrent(e: PredictionVerificationEntry | undefined): boolean {
  return !!e && e.methodology_version === CURRENT_METHODOLOGY_VERSION
    && (e.result === 'hit' || e.result === 'miss');
}

/**
 * 收集「声明档位槽」（来源 = 记录声明的 horizons，而非仅 verification entry）。
 *
 * 为什么用声明档：settled_ratio 的分母必须含真 pending（声明了却无 verification entry 的档位），
 * 否则未到期档永不进分母、settled_ratio 恒为 1、指标失去意义（审查 Important 1）。
 * long / approximate 由消费方按需排除，本函数原样保留其标记。skipped 行不计入（与 computeStats 一致）。
 */
function collectSlots(rows: PredictionRecordRow[]): HorizonSlot[] {
  const slots: HorizonSlot[] = [];
  for (const r of rows) {
    if (r.status === 'skipped') continue; // skipped 行即使带 verification 内容也不计入
    const keys = horizonKeys(r);
    if (keys.length === 0) continue;
    const approxSet = approximateHorizonSet(r);
    const v = r.verification ?? {};
    // 记录级 target_type 兜底：声明档无 entry 时按 record 内其它 entry 归属；缺省 index（旧记录兼容）
    let recordType = 'index';
    for (const key of Object.keys(v)) {
      const e = v[key];
      if (e && typeof e.target_type === 'string') { recordType = e.target_type; break; }
    }
    for (const h of keys) {
      const entry = v[h];
      const slotEntry = entry && typeof entry === 'object' ? entry : undefined;
      const targetType = slotEntry && typeof slotEntry.target_type === 'string'
        ? slotEntry.target_type
        : recordType;
      slots.push({ horizon: h, targetType, approximate: approxSet.has(h), entry: slotEntry });
    }
  }
  return slots;
}

/**
 * 按 target_type 分桶的命中统计（与 agent-py 统计口径逐字对齐）。
 *
 * scope = 该桶内**声明的**非-long、非-近似档位槽（含真 pending）；分子 = 其中 4.0 已结算（hit/miss）；
 * 分母 = 分子 + pending（旧版本已结算槽位既不入分子也不入 pending，口径隔离）。
 * 旧记录无 target_type 视为 index 兼容；skipped 行与 computeStats 口径一致，不参与分桶。
 * flat / direction 由 agent-py 写入侧落库（k 的唯一来源在 Python）——此处只读，不自行算 k。
 */
function bucketStats(rows: PredictionRecordRow[]): {
  combined: BucketStats;
  index: BucketStats;
  sector: BucketStats;
} {
  const slots = collectSlots(rows);
  const bucket = (tt: string | null): BucketStats => {
    const inBucket = (s: HorizonSlot) => tt === null || s.targetType === tt;
    // scope：该桶内非-long、非-近似声明档位槽（含真 pending）
    const scope = slots.filter((s) => inBucket(s) && s.horizon !== 'long' && !s.approximate);
    const settled = scope.filter((s) => isSettledCurrent(s.entry));
    const n = settled.length;
    const hits = settled.filter((s) => s.entry?.result === 'hit').length;
    const directionalCount = settled.filter((s) => {
      const dir = s.entry?.direction;
      return dir === 'bullish' || dir === 'bearish';
    }).length;
    const flatCount = settled.filter((s) => {
      const dir = s.entry?.direction;
      return (dir === 'bullish' || dir === 'bearish') && s.entry?.flat === true;
    }).length;
    // pending：尚未按当前版本结算的槽位；旧版本已结算槽位隔离（分子分母都不进）
    let pendingSlots = 0;
    for (const s of scope) {
      if (isSettledCurrent(s.entry)) continue;
      if (s.entry && (s.entry.result === 'hit' || s.entry.result === 'miss')) continue; // 旧版本已结算
      // 为什么计入 pending：insufficient 等非 hit/miss 是**数据可用性状态**（数据源故障/无数据），
      // 非判定结论；settled_ratio 语义是「预判语料里已被判定的比例」，未产出 hit/miss 的槽都算未结算。
      pendingSlots += 1;
    }
    const denom = n + pendingSlots;
    // long 档命中率单列：long + hit/miss + 当前版本 + 非近似（与 agent-py long 口径一致）
    const longScope = slots.filter((s) => inBucket(s) && s.horizon === 'long' && !s.approximate);
    const longSettled = longScope.filter((s) => isSettledCurrent(s.entry));
    const longN = longSettled.length;
    const longHits = longSettled.filter((s) => s.entry?.result === 'hit').length;
    // §8-3 方向桶 × 档位桶：与该 target_type 桶同口径（同一 settled entry 集合切分）
    const settledEntries = settled
      .map((s) => s.entry)
      .filter((e): e is PredictionVerificationEntry => !!e);
    const longEntries = longSettled
      .map((s) => s.entry)
      .filter((e): e is PredictionVerificationEntry => !!e);
    return {
      n,
      hits,
      hitRate: n ? hits / n : 0,
      sufficientSample: n >= 30,
      long_excluded: longScope.some((s) => versionOk(s.entry)),
      settled_ratio: denom ? round4(n / denom) : null,
      // flat_rate 分母必须是方向预判已结算数（design §4.3：33% ≈ 瞎猜的跨粒度基准线）
      flat_rate: directionalCount ? round4(flatCount / directionalCount) : null,
      flat_count: flatCount,
      directional_count: directionalCount,
      long: { n: longN, hits: longHits, hitRate: longN ? round4(longHits / longN) : null },
      ...dimensionBuckets(settledEntries, longEntries),
    };
  };
  return { combined: bucket(null), index: bucket('index'), sector: bucket('sector') };
}

/**
 * 按已验证档位口径统计（hit/(hit+miss)，insufficient 不计）。
 * status='skipped' 的行显式跳过（不计入 pending/verified/命中统计），单独累加 skippedCount；
 * total 仍含 skipped 行（口径与列表 items 对齐）。
 * P2 裁决：越年近似档（due_dates_approximate）照常验证，但 hit/miss 不计入命中率分母。
 * Task 5：long 档（120 交易日）不计入迭代看板（仅标记 long_excluded + 单列 long 命中率，档位进度照旧）；
 * 补 settled_ratio（已结算 / 声明非-long、非-近似档位槽，含真 pending）与 flat_rate。
 * flat / direction 由 agent-py 写入侧落库（k 的唯一来源在 Python）——此处只读，不自行算 k。
 * §8-3：补 directionBuckets（bullish/bearish/neutral，各带 flat_rate）与 horizonBuckets
 * （short/mid/long；long 单列并标注 iteration_board=false），与 bucketStats 同口径同值。
 */
function computeStats(rows: PredictionRecordRow[]) {
  let pendingCount = 0;
  let verifiedCount = 0;
  let verifiedHorizonCount = 0;
  let hitCount = 0;
  let missCount = 0;
  let skippedCount = 0;
  let approximateHorizonCount = 0;
  let longExcluded = false;
  let directionalCount = 0;
  let flatCount = 0;
  // settled_ratio 分母的未结算分量：声明了却尚未按当前版本结算的非-long、非-近似档位槽
  let pendingSlots = 0;
  // long 档命中率单列（不进迭代看板）
  let longN = 0;
  let longHits = 0;
  // §8-3 方向桶 × 档位桶：收集已结算 entry（4.0 hit/miss、非近似、非 long）与 long 单列 entry
  const settledEntries: PredictionVerificationEntry[] = [];
  const longSettledEntries: PredictionVerificationEntry[] = [];
  for (const row of rows) {
    if (row.status === 'skipped') {
      skippedCount += 1;
      continue;
    }
    const keys = horizonKeys(row);
    const approxSet = approximateHorizonSet(row);
    const verification = row.verification ?? {};
    const allVerified = keys.length > 0 && keys.every((h) => Boolean(verification[h]));
    if (allVerified) verifiedCount += 1;
    else pendingCount += 1;
    for (const h of keys) {
      const entry = verification[h];
      const isApprox = approxSet.has(h);
      if (h === 'long') {
        // long 档（120 交易日，≈半年一个样本）不计入迭代看板（§4.7）：档位进度/近似计数照旧（版本无关）。
        if (entry) {
          verifiedHorizonCount += 1;
          if (isApprox) approximateHorizonCount += 1;
          // long_excluded 与 bucketStats.longScope、agent-py/_long_entries 同源：
          // 仅当前版本**且非近似**的 long 档才计入（复用同一 isApprox 判定，不另写一份）。
          if (!isApprox && versionOk(entry)) longExcluded = true;
        }
        // long 命中率单列：long + hit/miss + 当前版本 + 非近似（与 agent-py long 口径一致）
        if (entry && !isApprox && isSettledCurrent(entry)) {
          longN += 1;
          longSettledEntries.push(entry);
          if (entry.result === 'hit') longHits += 1;
        }
        continue;
      }
      if (isApprox) {
        // 近似档：单独计数，不进命中率/scope（P2 分桶 + Task 5 统一口径）
        if (entry) { verifiedHorizonCount += 1; approximateHorizonCount += 1; }
        continue;
      }
      // 档位进度全量（版本无关，反映验证覆盖度）
      if (entry) verifiedHorizonCount += 1;
      if (entry && isSettledCurrent(entry)) {
        // 分子：当前版本已结算（hit/miss）
        if (entry.result === 'hit') hitCount += 1;
        else missCount += 1;
        settledEntries.push(entry);
        const dir = entry.direction;
        if (dir === 'bullish' || dir === 'bearish') {
          directionalCount += 1;
          if (entry.flat === true) flatCount += 1;
        }
      } else if (entry && (entry.result === 'hit' || entry.result === 'miss')) {
        // 旧版本已结算 → 口径隔离（既不入分子也不入 pending）
      } else {
        // 真 pending：无 entry / 无 result（未到期/early_exit）/ 非 hit-miss。
        // 为什么 insufficient 计入 pending：它是**数据可用性状态**（数据源故障/无数据），
        // 不是对预判对错的**判定结论**；settled_ratio 语义是「预判语料里已被判定的比例」，
        // 故未产出 hit/miss 的档位槽都算「未结算」（与 agent-py _settled_ratio 同口径）。
        pendingSlots += 1;
      }
    }
  }
  const comparable = hitCount + missCount; // = 当前版本非-long 已结算档位槽数（settled_ratio 分子）
  const slotDenom = comparable + pendingSlots;
  return {
    total: rows.length,
    pendingCount,
    verifiedCount,
    skippedCount,
    hitRate: comparable > 0 ? hitCount / comparable : null,
    verifiedHorizonCount,
    hitCount,
    missCount,
    approximateHorizonCount,
    long_excluded: longExcluded,
    settled_ratio: slotDenom > 0 ? round4(comparable / slotDenom) : null,
    flat_rate: directionalCount > 0 ? round4(flatCount / directionalCount) : null,
    flat_count: flatCount,
    directional_count: directionalCount,
    long: { n: longN, hits: longHits, hitRate: longN > 0 ? round4(longHits / longN) : null },
    ...dimensionBuckets(settledEntries, longSettledEntries),
    bucketStats: bucketStats(rows),
  };
}

router.get('/', async (req: Request, res: Response) => {
  const statusRaw = typeof req.query.status === 'string' ? req.query.status : 'all';
  const status: 'pending' | 'verified' | 'skipped' | undefined =
    statusRaw === 'all' ? undefined : VALID_STATUSES.includes(statusRaw as typeof VALID_STATUSES[number])
      ? (statusRaw as 'pending' | 'verified' | 'skipped')
      : undefined;
  if (statusRaw !== 'all' && status === undefined) {
    res.status(400).json({ code: 400, message: 'status must be all|pending|verified|skipped' });
    return;
  }
  // source_id 过滤（统计与列表同一口径）：格式 review:YYYY-MM-DD
  let sourceId: string | undefined;
  if (req.query.source_id !== undefined) {
    if (typeof req.query.source_id !== 'string' || !/^review:\d{4}-\d{2}-\d{2}$/.test(req.query.source_id)) {
      res.status(400).json({ code: 400, message: 'source_id must match review:YYYY-MM-DD' });
      return;
    }
    sourceId = req.query.source_id;
  }
  // source_type 过滤（大盘 market_trace / 板块 sector_prediction，白名单）
  let sourceType: 'market_trace' | 'sector_prediction' | undefined;
  if (req.query.source_type !== undefined) {
    if (typeof req.query.source_type !== 'string' || !VALID_SOURCE_TYPES.includes(req.query.source_type as typeof VALID_SOURCE_TYPES[number])) {
      res.status(400).json({ code: 400, message: 'source_type must be market_trace|sector_prediction' });
      return;
    }
    sourceType = req.query.source_type as 'market_trace' | 'sector_prediction';
  }
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(String(req.query.pageSize ?? '20'), 10) || 20));

  try {
    const allRows = await __predictionPublicDependencies.listAllForStats(status, sourceId, sourceType);
    const stats = computeStats(allRows);
    const { rows, total } = await __predictionPublicDependencies.list({ status, source_id: sourceId, source_type: sourceType, page, pageSize });
    res.json({
      code: 200,
      data: {
        items: rows.map(toItem),
        stats,
        pagination: { page, pageSize, total },
      },
    });
  } catch (err) {
    res.status(500).json({ code: 500, message: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(param(req, 'id'));
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ code: 400, message: 'id must be a positive integer' });
    return;
  }
  try {
    const row = await __predictionPublicDependencies.getById(id);
    if (!row) {
      res.status(404).json({ code: 404, message: 'Prediction not found' });
      return;
    }
    res.json({ code: 200, data: toItem(row) });
  } catch (err) {
    res.status(500).json({ code: 500, message: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
