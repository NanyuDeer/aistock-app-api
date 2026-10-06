import { Router, type Request, type Response } from 'express';
import { PredictionRecordService, type PredictionRecordRow } from './PredictionRecordService';

const router: Router = Router();

const VALID_STATUSES = ['pending', 'verified', 'skipped'] as const;
/** 历史跟踪页可选的记录类型（大盘溯源 vs 板块预判）；缺省返回全部（兼容调用方） */
const VALID_SOURCE_TYPES = ['market_trace', 'sector_prediction'] as const;

/**
 * 当前生产验证口径版本（版本 4.0：默认过滤 4.0，防跳变/混桶）。
 * 四处同步：agent-py prediction_stats._CURRENT_METHODOLOGY_VERSION、
 * prediction_validator._METHODOLOGY_VERSION / _BACKFILL_METHODOLOGY_VERSION、本文件。
 * 存量记录按各自旧版本隔离统计（无版本记录随 2.0 时代隔离，不再兼容计入）。
 */
const CURRENT_METHODOLOGY_VERSION = '4.0'

/** verification entry 是否属于当前统计版本（严格等于 CURRENT_METHODOLOGY_VERSION；无版本旧记录随之隔离不计入） */
function versionOk(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const mv = (e as { methodology_version?: unknown }).methodology_version
  return mv === CURRENT_METHODOLOGY_VERSION
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

/** 单桶统计（combined/index/sector 同形；Task 5 补 long 排除与看板指标） */
interface BucketStats {
  n: number;
  hits: number;
  hitRate: number;
  sufficientSample: boolean;
  /** 是否检测到 long 档样本并被排除出迭代看板（§4.7） */
  long_excluded: boolean;
  /** 已结算 / 该桶非-long 档位总数（含未结算；无档位时为 null） */
  settled_ratio: number | null;
  /** flat 占比 = flatCount / directionalCount（无方向样本时为 null；由 agent-py 写入侧判定 |x| < k） */
  flat_rate: number | null;
  flatCount: number;
  directionalCount: number;
}

/**
 * 按 target_type 分桶的命中统计（与 agent-py 统计口径对齐）。
 * 只计入 result ∈ {hit, miss} 且非 approximate 的**非 long** 档位；旧记录无 target_type 视为 index 兼容；
 * skipped 行与 computeStats 口径一致，不参与分桶。
 * Task 5：long 档排除出迭代看板（long_excluded）；补 settled_ratio / flat_rate 及其计数。
 * flat 标记由 agent-py 写入侧落库（k 的唯一来源在 Python）——此处只读，不自行算 k。
 */
function bucketStats(rows: PredictionRecordRow[]): {
  combined: BucketStats;
  index: BucketStats;
  sector: BucketStats;
} {
  const all: Array<{
    result?: string;
    target_type: string;
    approximate: boolean;
    horizon: string;
    direction: string;
    flat: boolean;
  }> = [];
  for (const r of rows) {
    // skipped 行即使带 verification 内容也不计入（与 computeStats 一致）
    if (r.status === 'skipped') continue;
    const v = r.verification as Record<string, {
      result?: string; target_type?: string; approximate?: boolean;
      methodology_version?: string; direction?: unknown; flat?: unknown;
    }> | null;
    if (!v) continue;
    for (const horizon of Object.keys(v)) {
      const e = v[horizon];
      // 版本分桶：只统计当前生产版本（4.0；旧版本记录隔离，防混桶）
      if (!versionOk(e)) continue;
      all.push({
        result: e?.result,
        target_type: typeof e?.target_type === 'string' ? e.target_type : 'index', // 旧记录兼容
        approximate: Boolean(e?.approximate),
        horizon,
        direction: typeof e?.direction === 'string' ? e.direction : '',
        flat: e?.flat === true,
      });
    }
  }
  const bucket = (tt: string | null): BucketStats => {
    // 分母 = 该桶全部非-long 档位（含未结算/insufficient/近似；排除 long）
    const inScope = all.filter((e) => e.horizon !== 'long' && (tt === null || e.target_type === tt));
    // 分子 = 已结算（hit/miss）且非近似
    const settled = inScope.filter((e) => !e.approximate && (e.result === 'hit' || e.result === 'miss'));
    const n = settled.length;
    const hits = settled.filter((e) => e.result === 'hit').length;
    const directionalCount = settled.filter((e) => e.direction === 'bullish' || e.direction === 'bearish').length;
    const flatCount = settled.filter((e) => (e.direction === 'bullish' || e.direction === 'bearish') && e.flat).length;
    const longCount = all.filter((e) => e.horizon === 'long' && (tt === null || e.target_type === tt)).length;
    return {
      n,
      hits,
      hitRate: n ? hits / n : 0,
      sufficientSample: n >= 30,
      long_excluded: longCount > 0,
      settled_ratio: inScope.length ? n / inScope.length : null,
      // flat_rate 分母必须是方向预判已结算数（design §4.3：33% ≈ 瞎猜的跨粒度基准线）
      flat_rate: directionalCount ? flatCount / directionalCount : null,
      flatCount,
      directionalCount,
    };
  };
  return { combined: bucket(null), index: bucket('index'), sector: bucket('sector') };
}

/**
 * 按已验证档位口径统计（hit/(hit+miss)，insufficient 不计）。
 * status='skipped' 的行显式跳过（不计入 pending/verified/命中统计），单独累加 skippedCount；
 * total 仍含 skipped 行（口径与列表 items 对齐）。
 * P2 裁决：越年近似档（due_dates_approximate）照常验证，但 hit/miss 不计入命中率分母。
 * Task 5：long 档（120 交易日）不计入迭代看板（仅标记 long_excluded，档位进度照旧）；
 * 补 settled_ratio（已结算 / 全部非-long 档位，含未结算）与 flat_rate（方向预判落 |x| < k 无信息带的占比）。
 * flat 标记由 agent-py 写入侧落库（k 的唯一来源在 Python）——此处只读，不自行算 k。
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
  // settled_ratio 分母：全部非-long 档位（含未结算/未到期的 pending 档）
  let scopeSlotCount = 0;
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
      if (h === 'long') {
        // long 档（120 交易日，≈半年一个样本）不计入迭代看板（§4.7）：仅检测并标记排除。
        // 档位进度/近似计数照旧（版本无关），便于展示覆盖度。
        if (entry) {
          longExcluded = true;
          verifiedHorizonCount += 1;
          if (approxSet.has(h)) approximateHorizonCount += 1;
        }
        continue;
      }
      scopeSlotCount += 1; // 分母：含未结算/无 entry 的 pending 档
      if (!entry) continue;
      // 档位进度全量（版本无关，反映验证覆盖度）
      verifiedHorizonCount += 1;
      if (approxSet.has(h)) {
        // 近似档：单独计数，不混入命中率分母（P2 分桶）
        approximateHorizonCount += 1;
        continue;
      }
      // 命中率按版本过滤（默认 4.0，旧版本记录隔离防混桶）
      if (!versionOk(entry)) continue;
      if (entry.result === 'hit') hitCount += 1;
      else if (entry.result === 'miss') missCount += 1;
      else continue; // insufficient / 无 result → 不计入已结算
      const dir = entry.direction;
      if (dir === 'bullish' || dir === 'bearish') {
        directionalCount += 1;
        if (entry.flat === true) flatCount += 1;
      }
    }
  }
  const comparable = hitCount + missCount;
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
    settled_ratio: scopeSlotCount > 0 ? comparable / scopeSlotCount : null,
    flat_rate: directionalCount > 0 ? flatCount / directionalCount : null,
    flatCount,
    directionalCount,
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
