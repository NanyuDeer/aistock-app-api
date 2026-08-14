/**
 * PredictionRecordService — 预测记录读写（prediction_records 表）。
 *
 * 供 /internal/predictions 路由调用；本模块只负责预测记录的持久化与验证回写，
 * 预测的生成（LLM 推演）在 agent-py 侧完成。
 */
import pool from '../../core/db';

export interface PredictionVerificationEntry {
  horizon: string;
  result: 'hit' | 'miss' | 'insufficient';
  actual: string;
  reason: string;
  verified_at: string;
}

export interface PredictionRecordRow {
  id: number;
  source_type: string;
  source_id: string;
  schema_version: string;
  prediction: Record<string, unknown>;
  verification: Record<string, PredictionVerificationEntry>;
  status: string;
  due_dates: Record<string, string>;
  created_at: string;
}

export class PredictionRecordService {
  static async create(input: {
    source_type: string;
    source_id: string;
    schema_version: string;
    prediction: Record<string, unknown>;
    due_dates: Record<string, string>;
    status?: 'pending' | 'skipped';
    skip_reason?: string;
  }): Promise<PredictionRecordRow | null> {
    // skip_reason 合并进 prediction（免 DB 迁移，SPEC §8）；status 缺省 pending
    const status = input.status ?? 'pending';
    const prediction = input.skip_reason !== undefined
      ? { ...input.prediction, skip_reason: input.skip_reason }
      : input.prediction;
    const result = await pool.query<PredictionRecordRow>(
      `INSERT INTO prediction_records (source_type, source_id, schema_version, prediction, due_dates, status)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
       ON CONFLICT (source_type, source_id)
       DO UPDATE SET schema_version = EXCLUDED.schema_version,
                     prediction = EXCLUDED.prediction,
                     due_dates = EXCLUDED.due_dates,
                     status = EXCLUDED.status
       RETURNING id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at`,
      [
        input.source_type,
        input.source_id,
        input.schema_version,
        JSON.stringify(prediction),
        JSON.stringify(input.due_dates),
        status,
      ],
    );
    return result.rows[0] ?? null;
  }

  static async listPending(limit = 200): Promise<PredictionRecordRow[]> {
    const result = await pool.query<PredictionRecordRow>(
      `SELECT id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at
       FROM prediction_records
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  /** 列表（public 路由）：status/source_id 可选过滤（可组合），created_at DESC 分页 */
  static async list(params: {
    status?: 'pending' | 'verified' | 'skipped';
    source_id?: string;
    page: number;
    pageSize: number;
  }): Promise<{ rows: PredictionRecordRow[]; total: number }> {
    const conditions: string[] = [];
    const filterValues: unknown[] = [];
    if (params.status) {
      conditions.push(`status = $${filterValues.length + 1}`);
      filterValues.push(params.status);
    }
    if (params.source_id) {
      conditions.push(`source_id = $${filterValues.length + 1}`);
      filterValues.push(params.source_id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM prediction_records ${where}`,
      filterValues,
    );
    const limit = Math.min(Math.max(params.pageSize, 1), 50);
    const offset = (Math.max(params.page, 1) - 1) * limit;
    const values: unknown[] = [...filterValues, limit, offset];
    const result = await pool.query<PredictionRecordRow>(
      `SELECT id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at
       FROM prediction_records ${where}
       ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { rows: result.rows, total: Number(countResult.rows[0]?.count ?? 0) };
  }

  /** 全量读取（public 路由统计用；数据量小 ≈1 条/交易日） */
  static async listAllForStats(
    status?: 'pending' | 'verified' | 'skipped',
    source_id?: string,
  ): Promise<PredictionRecordRow[]> {
    const conditions: string[] = [];
    const filterValues: unknown[] = [];
    if (status) {
      conditions.push(`status = $${filterValues.length + 1}`);
      filterValues.push(status);
    }
    if (source_id) {
      conditions.push(`source_id = $${filterValues.length + 1}`);
      filterValues.push(source_id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query<PredictionRecordRow>(
      `SELECT id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at
       FROM prediction_records ${where}
       ORDER BY created_at DESC`,
      filterValues,
    );
    return result.rows;
  }

  /** 单条详情（public 路由） */
  static async getById(id: number): Promise<PredictionRecordRow | null> {
    const result = await pool.query<PredictionRecordRow>(
      `SELECT id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at
       FROM prediction_records WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  static async appendVerification(
    id: number,
    horizon: string,
    entry: PredictionVerificationEntry,
  ): Promise<PredictionRecordRow | null> {
    const current = await pool.query<PredictionRecordRow>(
      `SELECT id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at
       FROM prediction_records WHERE id = $1`,
      [id],
    );
    const row = current.rows[0];
    if (!row) return null;

    const verification = { ...(row.verification ?? {}) } as Record<string, PredictionVerificationEntry>;
    verification[horizon] = entry;

    // 全部档位已验证 → status=verified
    const horizons: string[] = Array.isArray((row.prediction as { horizons?: Array<{ horizon: string }> })?.horizons)
      ? ((row.prediction as { horizons: Array<{ horizon: string }> }).horizons.map(h => h.horizon))
      : [];
    const allVerified = horizons.length > 0 && horizons.every(h => Boolean(verification[h]));
    const status = allVerified ? 'verified' : 'pending';

    const updated = await pool.query<PredictionRecordRow>(
      `UPDATE prediction_records
       SET verification = $2::jsonb, status = $3
       WHERE id = $1
       RETURNING id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at`,
      [id, JSON.stringify(verification), status],
    );
    return updated.rows[0] ?? null;
  }
}
