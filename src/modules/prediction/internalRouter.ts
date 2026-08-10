import { Router, type Request, type Response } from 'express';
import { PredictionRecordService, type PredictionVerificationEntry } from './PredictionRecordService';

const router: Router = Router();
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

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
  try {
    const record = await PredictionRecordService.create({
      source_type: body.source_type,
      source_id: body.source_id,
      schema_version: typeof body.schema_version === 'string' ? body.schema_version : '1.0',
      prediction: body.prediction as Record<string, unknown>,
      due_dates: body.due_dates as Record<string, string>,
    });
    res.json({ code: 200, data: record });
  } catch (err) {
    res.status(500).json({ code: 500, message: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/', async (_req: Request, res: Response) => {
  const status = typeof _req.query.status === 'string' ? _req.query.status : undefined;
  if (status !== 'pending') {
    res.status(400).json({ code: 400, message: 'unsupported status filter (only pending)' });
    return;
  }
  try {
    const rows = await PredictionRecordService.listPending();
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
