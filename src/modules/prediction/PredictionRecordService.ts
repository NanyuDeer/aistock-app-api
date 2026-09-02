/**
 * PredictionRecordService — 预测记录读写（prediction_records 表）。
 *
 * 供 /internal/predictions 路由调用；本模块只负责预测记录的持久化与验证回写，
 * 预测的生成（LLM 推演）在 agent-py 侧完成。
 */
import pool from '../../core/db';

export interface PredictionVerificationEntry {
  horizon: string;
  /** early_exit 标记：type === 'early_exit' 的 entry 无 result，不参与 status=verified 判定（A1） */
  type?: string;
  result?: 'hit' | 'miss' | 'insufficient';
  actual?: string;
  reason?: string;
  verified_at?: string;
  early_exit?: Record<string, unknown>;
  /** 透传扩展字段（Python 验证器写入的 methodology_version/baseline_neutral/target_type/approximate 等，
   *  2026-08-31 A3 统计 _filter_v2 与存量统计口径依赖——router 不得截断） */
  [key: string]: unknown;
}

/** 合法验证结果（A1：状态判定只认 result ∈ 此集合；迁移到 service 避免 router→service 循环依赖） */
export const VALID_RESULTS = ['hit', 'miss', 'insufficient'] as const;

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
    due_dates_approximate?: string[];
  }): Promise<PredictionRecordRow | null> {
    // skip_reason / due_dates_approximate 合并进 prediction（免 DB 迁移，SPEC §8）；
    // due_dates_approximate：越年近似档位名列表（P2 裁决），缺省/空 = 全精确档
    const status = input.status ?? 'pending';
    const prediction = {
      ...input.prediction,
      ...(input.skip_reason !== undefined ? { skip_reason: input.skip_reason } : {}),
      ...(input.due_dates_approximate !== undefined ? { due_dates_approximate: input.due_dates_approximate } : {}),
    };
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

  static async listPending(limit = 200, beforeId?: number): Promise<PredictionRecordRow[]> {
    // 游标：只取 id < beforeId 的 pending（按 id 倒序取最近 limit 条）
    if (beforeId !== undefined) {
      const result = await pool.query<PredictionRecordRow>(
        `SELECT id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at
         FROM prediction_records
         WHERE status = 'pending' AND id < $1
         ORDER BY id DESC
         LIMIT $2`,
        [beforeId, limit],
      );
      return result.rows;
    }
    const result = await pool.query<PredictionRecordRow>(
      `SELECT id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at
       FROM prediction_records
       WHERE status = 'pending'
       ORDER BY id DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  /** 按状态列表（内部路由 verified 游标分页，D3 统计出口）：id < beforeId 分页 */
  static async listByStatus(
    status: string,
    limit = 200,
    beforeId?: number,
  ): Promise<PredictionRecordRow[]> {
    if (beforeId !== undefined) {
      const result = await pool.query<PredictionRecordRow>(
        `SELECT id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at
         FROM prediction_records
         WHERE status = $1 AND id < $2
         ORDER BY id DESC
         LIMIT $3`,
        [status, beforeId, limit],
      );
      return result.rows;
    }
    const result = await pool.query<PredictionRecordRow>(
      `SELECT id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at
       FROM prediction_records
       WHERE status = $1
       ORDER BY id DESC
       LIMIT $2`,
      [status, limit],
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

  /**
   * 板块预判记录按日查询（sector-insight 聚合接口用）。
   * source_id 形如 `sector:{板块名}:{YYYY-MM-DD}`；date 由路由正则校验
   * （^\d{4}-\d{2}-\d{2}$，无 %/_ 通配符），LIKE 后缀拼接无注入面。
   * 同一板块名当日只有一条（source_type+source_id 唯一索引 upsert 覆盖）。
   */
  static async listSectorByDate(date: string): Promise<PredictionRecordRow[]> {
    const result = await pool.query<PredictionRecordRow>(
      `SELECT id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at
       FROM prediction_records
       WHERE source_type = 'sector_prediction'
         AND source_id LIKE 'sector:%:' || $1
       ORDER BY created_at DESC`,
      [date],
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

    // 状态判定在"合并后"的 verification 上进行（A1）：仅当全部档位均有
    // result ∈ {hit, miss, insufficient} 才置 verified；early_exit-only entry
    // （无 result，早退标记与最终结果分离存储）不参与 status 联动。
    const merged = { ...(row.verification ?? {}), [horizon]: entry } as Record<
      string,
      PredictionVerificationEntry
    >;
    const horizons: string[] = Array.isArray((row.prediction as { horizons?: Array<{ horizon: string }> })?.horizons)
      ? ((row.prediction as { horizons: Array<{ horizon: string }> }).horizons.map(h => h.horizon))
      : [];
    const allVerified =
      horizons.length > 0 &&
      horizons.every(h => {
        const e = merged[h];
        return (
          !!e &&
          'result' in e &&
          VALID_RESULTS.includes(e.result as (typeof VALID_RESULTS)[number])
        );
      });
    const status = allVerified ? 'verified' : 'pending';

    // 原子合并写：verification 顶层 jsonb 合并，同档位 COALESCE 二次合并，
    // 避免并发读-改-写覆盖其他档位（A1：Node 端只写本次 entry，不整段覆盖）。
    const updated = await pool.query<PredictionRecordRow>(
      `UPDATE prediction_records
       SET verification = verification
         || jsonb_build_object($1, COALESCE(verification->$1, '{}'::jsonb) || $2::jsonb),
           status = $3
       WHERE id = $4
       RETURNING id, source_type, source_id, schema_version, prediction, verification, status, due_dates, created_at`,
      [horizon, JSON.stringify(entry), status, id],
    );
    return updated.rows[0] ?? null;
  }
}
