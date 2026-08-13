import { Router, type Request, type Response } from 'express';
import { PredictionRecordService, type PredictionRecordRow } from './PredictionRecordService';

const router: Router = Router();

const VALID_STATUSES = ['pending', 'verified'] as const;

/** 测试注入点（tsx ESM live binding 无法 patch 模块私有函数，沿用仓库 __xxxDependencies 模式） */
export const __predictionPublicDependencies = {
  list: (params: { status?: 'pending' | 'verified'; page: number; pageSize: number }) =>
    PredictionRecordService.list(params),
  listAllForStats: (status?: 'pending' | 'verified') => PredictionRecordService.listAllForStats(status),
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

/** 按已验证档位口径统计（hit/(hit+miss)，insufficient 不计） */
function computeStats(rows: PredictionRecordRow[]) {
  let pendingCount = 0;
  let verifiedCount = 0;
  let verifiedHorizonCount = 0;
  let hitCount = 0;
  let missCount = 0;
  for (const row of rows) {
    const keys = horizonKeys(row);
    const verification = row.verification ?? {};
    const allVerified = keys.length > 0 && keys.every((h) => Boolean(verification[h]));
    if (allVerified) verifiedCount += 1;
    else pendingCount += 1;
    for (const h of keys) {
      const entry = verification[h];
      if (!entry) continue;
      verifiedHorizonCount += 1;
      if (entry.result === 'hit') hitCount += 1;
      else if (entry.result === 'miss') missCount += 1;
    }
  }
  const comparable = hitCount + missCount;
  return {
    total: rows.length,
    pendingCount,
    verifiedCount,
    hitRate: comparable > 0 ? hitCount / comparable : null,
    verifiedHorizonCount,
    hitCount,
    missCount,
  };
}

router.get('/', async (req: Request, res: Response) => {
  const statusRaw = typeof req.query.status === 'string' ? req.query.status : 'all';
  const status: 'pending' | 'verified' | undefined =
    statusRaw === 'all' ? undefined : VALID_STATUSES.includes(statusRaw as typeof VALID_STATUSES[number])
      ? (statusRaw as 'pending' | 'verified')
      : undefined;
  if (statusRaw !== 'all' && status === undefined) {
    res.status(400).json({ code: 400, message: 'status must be all|pending|verified' });
    return;
  }
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(String(req.query.pageSize ?? '20'), 10) || 20));

  try {
    const allRows = await __predictionPublicDependencies.listAllForStats(status);
    const stats = computeStats(allRows);
    const { rows, total } = await __predictionPublicDependencies.list({ status, page, pageSize });
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
