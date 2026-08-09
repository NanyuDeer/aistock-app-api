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
  }): Promise<PredictionRecordRow | null> {
    const result = await pool.query<PredictionRecordRow>(
      `INSERT INTO prediction_records (source_type, source_id, schema_version, prediction, due_dates)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       RETURNING id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at`,
      [
        input.source_type,
        input.source_id,
        input.schema_version,
        JSON.stringify(input.prediction),
        JSON.stringify(input.due_dates),
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
