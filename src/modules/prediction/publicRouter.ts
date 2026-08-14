import { Router, type Request, type Response } from 'express';
import { PredictionRecordService, type PredictionRecordRow } from './PredictionRecordService';

const router: Router = Router();

const VALID_STATUSES = ['pending', 'verified', 'skipped'] as const;

/** 测试注入点（tsx ESM live binding 无法 patch 模块私有函数，沿用仓库 __xxxDependencies 模式） */
export const __predictionPublicDependencies = {
  list: (params: { status?: 'pending' | 'verified' | 'skipped'; source_id?: string; page: number; pageSize: number }) =>
    PredictionRecordService.list(params),
  listAllForStats: (status?: 'pending' | 'verified' | 'skipped', source_id?: string) =>
    PredictionRecordService.listAllForStats(status, source_id),
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

/**
 * 按已验证档位口径统计（hit/(hit+miss)，insufficient 不计）。
 * status='skipped' 的行显式跳过（不计入 pending/verified/命中统计），单独累加 skippedCount；
 * total 仍含 skipped 行（口径与列表 items 对齐）。
 * P2 裁决：越年近似档（due_dates_approximate）照常验证，但 hit/miss 不计入命中率分母
 * （近似到期日语义与精确档不同，分桶避免统计失真）。
 */
function computeStats(rows: PredictionRecordRow[]) {
  let pendingCount = 0;
  let verifiedCount = 0;
  let verifiedHorizonCount = 0;
  let hitCount = 0;
  let missCount = 0;
  let skippedCount = 0;
  let approximateHorizonCount = 0;
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
      if (!entry) continue;
      verifiedHorizonCount += 1;
      if (approxSet.has(h)) {
        // 近似档：单独计数，不混入命中率分母（P2 分桶）
        approximateHorizonCount += 1;
        continue;
      }
      if (entry.result === 'hit') hitCount += 1;
      else if (entry.result === 'miss') missCount += 1;
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
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(String(req.query.pageSize ?? '20'), 10) || 20));

  try {
    const allRows = await __predictionPublicDependencies.listAllForStats(status, sourceId);
    const stats = computeStats(allRows);
    const { rows, total } = await __predictionPublicDependencies.list({ status, source_id: sourceId, page, pageSize });
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
