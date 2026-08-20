import { Router, type Request, type Response } from 'express';
import { PredictionRecordService, type PredictionVerificationEntry } from './PredictionRecordService';
import redis from '../../core/redis';

const router: Router = Router();
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

/** 透明转发上游地址（复用 review_trigger_handler / agentThreadClient 同一 env 表达式） */
const AGENT_PY_URL = process.env.AGENT_PY_URL || process.env.PYTHON_AGENT_URL || 'http://localhost:8000';

/** regenerate 每小时限流（Redis 窗口）：≤3 次/日（按 trade_date 计） */
const REGENERATE_RATE_LIMIT_MAX = 3;
const REGENERATE_RATE_LIMIT_TTL_SECONDS = 3600;
const REGENERATE_TIMEOUT_MS = 90 * 1000;

/** 上海今天（UTC+8）YYYY-MM-DD */
function shanghaiToday(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 测试注入点（沿用仓库 __xxxDependencies 模式；超时毫秒可注入以便测试模拟超时） */
export const __internalPredictionDependencies = {
  create: (input: Parameters<typeof PredictionRecordService.create>[0]) => PredictionRecordService.create(input),
  list: (params: Parameters<typeof PredictionRecordService.list>[0]) => PredictionRecordService.list(params),
  regenerateTimeoutMs: REGENERATE_TIMEOUT_MS,
};

router.use((req, res, next) => {
  if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
    res.status(403).json({ code: 403, message: 'Forbidden' });
    return;
  }
  next();
});

/** Express 5 params 可能为 string | string[]，安全取 string */
function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : (val || '');
}

const VALID_RESULTS = ['hit', 'miss', 'insufficient'] as const;

router.post('/', async (req: Request, res: Response) => {
  const body = req.body as {
    source_type?: unknown;
    source_id?: unknown;
    schema_version?: unknown;
    prediction?: unknown;
    due_dates?: unknown;
    status?: unknown;
    skip_reason?: unknown;
    due_dates_approximate?: unknown;
  };
  if (
    typeof body.source_type !== 'string' || !body.source_type.trim() ||
    typeof body.source_id !== 'string' || !body.source_id.trim() ||
    typeof body.prediction !== 'object' || body.prediction === null ||
    typeof body.due_dates !== 'object' || body.due_dates === null
  ) {
    res.status(400).json({ code: 400, message: 'source_type, source_id, prediction and due_dates are required' });
    return;
  }
  if (body.status !== undefined && body.status !== 'pending' && body.status !== 'skipped') {
    res.status(400).json({ code: 400, message: 'status must be pending|skipped' });
    return;
  }
  if (body.skip_reason !== undefined && typeof body.skip_reason !== 'string') {
    res.status(400).json({ code: 400, message: 'skip_reason must be a string' });
    return;
  }
  // P2 越年近似：due_dates_approximate 可选（string[]），缺省/空 = 全精确档
  if (
    body.due_dates_approximate !== undefined &&
    (!Array.isArray(body.due_dates_approximate) ||
      !body.due_dates_approximate.every((h) => typeof h === 'string'))
  ) {
    res.status(400).json({ code: 400, message: 'due_dates_approximate must be an array of strings' });
    return;
  }
  try {
    const record = await __internalPredictionDependencies.create({
      source_type: body.source_type,
      source_id: body.source_id,
      schema_version: typeof body.schema_version === 'string' ? body.schema_version : '1.0',
      prediction: body.prediction as Record<string, unknown>,
      due_dates: body.due_dates as Record<string, string>,
      status: body.status as 'pending' | 'skipped' | undefined,
      skip_reason: body.skip_reason as string | undefined,
      due_dates_approximate: body.due_dates_approximate as string[] | undefined,
    });
    res.json({ code: 200, data: record });
  } catch (err) {
    res.status(500).json({ code: 500, message: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /internal/predictions/regenerate — 手动重生成某交易日预测（代理转发到 agent-py）。
 *
 * 流程：trade_date 当日校验 → Redis 限流（≤3 次/时，失败降级放行）→ 已验证拒覆盖（409）→
 * 转发 POST ${AGENT_PY_URL}/api/agent/internal/predictions/from-trace（90s 超时）。
 * 响应映射：上游 409 → 409；超时 → 504；其余非 OK → 502（含 upstream_status）；OK → 透传 {code:200, data}。
 */
router.post('/regenerate', async (req: Request, res: Response) => {
  const body = req.body as { trade_date?: unknown };
  if (typeof body.trade_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.trade_date)) {
    res.status(400).json({ code: 400, detail: 'trade_date must be YYYY-MM-DD' });
    return;
  }
  if (body.trade_date !== shanghaiToday()) {
    res.status(400).json({ code: 400, detail: 'only today allowed' });
    return;
  }
  const tradeDate = body.trade_date;

  // Redis 限流：prediction:regenerate:{trade_date}，每小时窗口 ≤3 次；Redis 故障降级放行（勿 500）
  try {
    const rateKey = `prediction:regenerate:${tradeDate}`;
    const count = await redis.incr(rateKey);
    if (count === 1) {
      await redis.expire(rateKey, REGENERATE_RATE_LIMIT_TTL_SECONDS);
    }
    if (count > REGENERATE_RATE_LIMIT_MAX) {
      res.status(429).json({ code: 429, detail: 'rate limit exceeded' });
      return;
    }
  } catch (err) {
    console.warn(
      '[PredictionRegenerate] Redis rate limit failed, allowing request:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // 已验证拒覆盖：该交易日已有记录且 verification 非空 → 409
  try {
    const sourceId = `review:${tradeDate}`;
    const { rows } = await __internalPredictionDependencies.list({ source_id: sourceId, page: 1, pageSize: 1 });
    const existing = rows[0];
    if (existing && Object.keys(existing.verification ?? {}).length > 0) {
      res.status(409).json({ code: 409, detail: '已验证预测拒绝覆盖' });
      return;
    }
  } catch (err) {
    res.status(500).json({ code: 500, message: err instanceof Error ? err.message : String(err) });
    return;
  }

  // 转发到 agent-py（90s 超时）
  const targetUrl = `${AGENT_PY_URL}/api/agent/internal/predictions/from-trace`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), __internalPredictionDependencies.regenerateTimeoutMs);
  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'x-internal-token': INTERNAL_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ trade_date: tradeDate, trace_id: 'manual-regenerate' }),
      signal: controller.signal,
    });
    let upstreamBody: unknown = null;
    try {
      upstreamBody = await response.json();
    } catch {
      // 非 JSON 上游响应，忽略
    }
    if (response.status === 409) {
      res.status(409).json({ code: 409, detail: 'upstream conflict', upstream_status: 409, data: upstreamBody });
      return;
    }
    if (!response.ok) {
      res.status(502).json({
        code: 502,
        detail: `upstream error ${response.status}`,
        upstream_status: response.status,
        data: upstreamBody,
      });
      return;
    }
    res.json({ code: 200, data: upstreamBody });
  } catch (err) {
    if (controller.signal.aborted) {
      res.status(504).json({ code: 504, detail: 'upstream timeout' });
      return;
    }
    res.status(502).json({ code: 502, detail: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
  }
});

router.get('/', async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const sourceId = typeof req.query.source_id === 'string' ? req.query.source_id : undefined;
  // Python 端"已验证拒覆盖"防御查询（PR-A/T5）：按 source_id 精确过滤。
  // source_id 格式不强制（Python 侧构造 review:{date}）；空字符串视为非法。
  if (sourceId !== undefined) {
    if (!sourceId.trim()) {
      res.status(400).json({ code: 400, message: 'source_id must be a non-empty string' });
      return;
    }
    try {
      const { rows } = await __internalPredictionDependencies.list({ source_id: sourceId, page: 1, pageSize: 50 });
      res.json({ code: 200, data: rows });
    } catch (err) {
      res.status(500).json({ code: 500, message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (status !== 'pending' && status !== 'verified') {
    res.status(400).json({ code: 400, message: 'unsupported status filter (only pending|verified)' });
    return;
  }
  const limitRaw = req.query.limit;
  const limit =
    typeof limitRaw === 'string' && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 200;
  const beforeIdRaw = req.query.before_id;
  const beforeId =
    typeof beforeIdRaw === 'string' && /^\d+$/.test(beforeIdRaw) ? Number(beforeIdRaw) : undefined;
  try {
    const rows =
      status === 'pending'
        ? await PredictionRecordService.listPending(limit, beforeId)
        : await PredictionRecordService.listByStatus(status, limit, beforeId);
    res.json({ code: 200, data: rows });
  } catch (err) {
    res.status(500).json({ code: 500, message: err instanceof Error ? err.message : String(err) });
  }
});

router.put('/:id/verification', async (req: Request, res: Response) => {
  const id = Number(param(req, 'id'));
  const body = req.body as {
    horizon?: unknown;
    result?: unknown;
    actual?: unknown;
    reason?: unknown;
  };
  if (!Number.isInteger(id) || id < 1 || typeof body.horizon !== 'string' || !body.horizon.trim()) {
    res.status(400).json({ code: 400, message: 'valid id and horizon are required' });
    return;
  }
  if (!VALID_RESULTS.includes(body.result as typeof VALID_RESULTS[number])) {
    res.status(400).json({ code: 400, message: 'result must be hit|miss|insufficient' });
    return;
  }
  const entry: PredictionVerificationEntry = {
    horizon: body.horizon,
    result: body.result as PredictionVerificationEntry['result'],
    actual: typeof body.actual === 'string' ? body.actual : '',
    reason: typeof body.reason === 'string' ? body.reason : '',
    verified_at: new Date().toISOString(),
  };
  try {
    const record = await PredictionRecordService.appendVerification(id, body.horizon, entry);
    if (!record) {
      res.status(404).json({ code: 404, message: 'Prediction not found' });
      return;
    }
    res.json({ code: 200, data: record });
  } catch (err) {
    res.status(500).json({ code: 500, message: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
