/**
 * 智慧大脑 V4 影子归档服务（Task 7）。
 *
 * 硬约束：
 * - 只写 `brain_v4_runs` / `brain_v4_comparisons`，绝不触达 `brain_run_archives`；
 * - `archiveRun` 强制 `is_shadow = TRUE`，调用方传 false 也会被覆盖；
 * - 全部读取只查影子表且带 `is_shadow = TRUE` 谓词，影子数据不会进入正式查询；
 * - comparison 只在两个 run 的 snapshot SHA 完全一致时才会落库。
 *
 * 测试通过构造 `SqlExecutor` 替身注入，不要求真实 PostgreSQL。
 */

import pool from '../../core/db'

export interface ArchiveRunRecord {
    v4_run_id: string
    legacy_run_id?: string | null
    feature_id: string
    profile: string
    subject_type: string
    subject_code: string
    as_of: string
    data_cutoff: string
    snapshot_id: string
    snapshot_sha: string
    parent_run_id?: string | null
    relation?: string | null
    config_version: string
    method_version: string
    model_version: string
    prompt_version?: string | null
    is_shadow?: boolean
    payload?: Record<string, unknown>
}

export interface ArchiveComparisonRecord {
    comparison_id: string
    legacy_run_id: string
    v4_run_id: string
    blind_label?: string | null
    reviewer_score?: number | null
    payload?: Record<string, unknown>
}

export interface RunFilter {
    feature?: string
    profile?: string
    date?: string
    limit?: number
}

export type ArchiveRow = Record<string, unknown>

/** 可注入的 SQL 执行器；生产默认包装 `core/db` 的 pg Pool。 */
export interface SqlExecutor {
    query<T extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
    ): Promise<{ rows: T[] }>
}

export class ArchiveValidationError extends Error {}

export class ArchiveNotFoundError extends Error {}

export class SnapshotMismatchError extends Error {}

const REQUIRED_RUN_FIELDS = [
    'v4_run_id',
    'feature_id',
    'profile',
    'subject_type',
    'subject_code',
    'as_of',
    'data_cutoff',
    'snapshot_id',
    'snapshot_sha',
    'config_version',
    'method_version',
    'model_version',
] as const

const REQUIRED_COMPARISON_FIELDS = [
    'comparison_id',
    'legacy_run_id',
    'v4_run_id',
] as const

const defaultExecutor: SqlExecutor = {
    async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
        const result = await pool.query(text, values === undefined ? undefined : [...values])
        return { rows: result.rows as T[] }
    },
}

function requireFields(
    record: Record<string, unknown>,
    fields: readonly string[],
    label: string,
): void {
    const missing = fields.filter((field) => {
        const value = record[field]
        return value === undefined || value === null || value === ''
    })
    if (missing.length > 0) {
        throw new ArchiveValidationError(`${label} 缺少必需字段: ${missing.join(', ')}`)
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
}

function stringValue(row: Record<string, unknown>, key: string): string {
    const value = row[key]
    return typeof value === 'string' ? value : ''
}

function isoValue(value: unknown): string {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? '' : value.toISOString()
    }
    return typeof value === 'string' ? value : ''
}

/** 简报时段 → V4 profile；`midday` 与既有 `mid` 都指向午报。 */
const BRIEFING_PROFILE_BY_SLOT: Record<string, string> = {
    pre: 'briefing_morning',
    mid: 'briefing_midday',
    midday: 'briefing_midday',
    post: 'briefing_evening',
}

export function briefingProfileForSlot(slot: string): string | null {
    return BRIEFING_PROFILE_BY_SLOT[slot] ?? null
}

export class BrainV4ArchiveService {
    constructor(private readonly db: SqlExecutor = defaultExecutor) {}

    /** 归档一次 V4 影子运行；`is_shadow` 恒写 TRUE。 */
    async archiveRun(record: ArchiveRunRecord): Promise<ArchiveRow> {
        const raw = record as unknown as Record<string, unknown>
        requireFields(raw, REQUIRED_RUN_FIELDS, 'archiveRun')

        const sql = `INSERT INTO brain_v4_runs (
            v4_run_id, legacy_run_id, feature_id, profile, subject_type, subject_code,
            as_of, data_cutoff, snapshot_id, snapshot_sha, parent_run_id, relation,
            config_version, method_version, model_version, prompt_version, is_shadow, payload
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
        ) RETURNING *`
        const values: unknown[] = [
            record.v4_run_id,
            record.legacy_run_id ?? null,
            record.feature_id,
            record.profile,
            record.subject_type,
            record.subject_code,
            record.as_of,
            record.data_cutoff,
            record.snapshot_id,
            record.snapshot_sha,
            record.parent_run_id ?? null,
            record.relation ?? null,
            record.config_version,
            record.method_version,
            record.model_version,
            record.prompt_version ?? null,
            true,
            JSON.stringify(record.payload ?? {}),
        ]
        const result = await this.db.query(sql, values)
        return result.rows[0] ?? { ...record, is_shadow: true }
    }

    /** 按 v4_run_id 读取单条影子运行；不存在返回 null。 */
    async getRun(v4RunId: string): Promise<ArchiveRow | null> {
        const result = await this.db.query(
            'SELECT * FROM brain_v4_runs WHERE v4_run_id = $1 AND is_shadow = TRUE LIMIT 1',
            [v4RunId],
        )
        return result.rows[0] ?? null
    }

    /**
     * 读取某日某时段的 V4 简报影子行（只读审计出口）。
     *
     * 硬约束：只查 `brain_v4_runs` 且只认 `is_shadow = TRUE` 与 payload 含
     * `briefing_v1` 的行；取 `as_of DESC` 最新一条。找不到返回 null，
     * 不用空对象伪装“有数据”。
     */
    async getBriefing(date: string, slot: string): Promise<ArchiveRow | null> {
        const profile = briefingProfileForSlot(slot)
        if (!profile) {
            return null
        }
        const result = await this.db.query(
            `SELECT * FROM brain_v4_runs
             WHERE is_shadow = TRUE
               AND as_of::date = $1::date
               AND profile = $2
               AND payload ? 'briefing_v1'
               AND jsonb_typeof(payload->'briefing_v1') = 'object'
             ORDER BY as_of DESC, v4_run_id ASC
             LIMIT 1`,
            [date, profile],
        )
        const row = result.rows[0]
        if (!row) {
            return null
        }
        const payload = asRecord(row['payload'])
        const briefing = asRecord(payload['briefing_v1'])
        const asOf = isoValue(row['as_of'])
        return {
            run_id: stringValue(row, 'v4_run_id') || stringValue(payload, 'run_id'),
            profile: stringValue(row, 'profile'),
            date: stringValue(briefing, 'date') || asOf.slice(0, 10),
            as_of: asOf,
            briefing_v1: payload['briefing_v1'] ?? null,
            usage: payload['usage'] ?? null,
            audit: payload['audit'] ?? null,
        }
    }

    /** 列出影子运行；仅允许 feature / profile / date 过滤。 */
    async listRuns(filter: RunFilter = {}): Promise<ArchiveRow[]> {
        const clauses: string[] = ['is_shadow = TRUE']
        const values: unknown[] = []
        if (filter.feature) {
            values.push(filter.feature)
            clauses.push(`feature_id = $${values.length}`)
        }
        if (filter.profile) {
            values.push(filter.profile)
            clauses.push(`profile = $${values.length}`)
        }
        if (filter.date) {
            values.push(filter.date)
            clauses.push(`as_of::date = $${values.length}::date`)
        }
        const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
        values.push(limit)
        const sql = `SELECT * FROM brain_v4_runs WHERE ${clauses.join(' AND ')} ORDER BY as_of DESC, v4_run_id ASC LIMIT $${values.length}`
        const result = await this.db.query(sql, values)
        return result.rows
    }

    /** 按 comparison_id 读取只读对比。 */
    async getComparison(comparisonId: string): Promise<ArchiveRow | null> {
        const result = await this.db.query(
            'SELECT * FROM brain_v4_comparisons WHERE comparison_id = $1 AND is_shadow = TRUE LIMIT 1',
            [comparisonId],
        )
        return result.rows[0] ?? null
    }

    /**
     * 落库一条 comparison；两个 run 的 snapshot SHA 必须完全一致。
     * 不一致时抛 `SnapshotMismatchError`，路由层映射为 409。
     */
    async archiveComparison(record: ArchiveComparisonRecord): Promise<ArchiveRow> {
        const raw = record as unknown as Record<string, unknown>
        requireFields(raw, REQUIRED_COMPARISON_FIELDS, 'archiveComparison')

        const legacy = await this.getRun(record.legacy_run_id)
        if (!legacy) {
            throw new ArchiveNotFoundError(`legacy run not found: ${record.legacy_run_id}`)
        }
        const v4 = await this.getRun(record.v4_run_id)
        if (!v4) {
            throw new ArchiveNotFoundError(`v4 run not found: ${record.v4_run_id}`)
        }

        const legacySha = stringValue(legacy, 'snapshot_sha')
        const v4Sha = stringValue(v4, 'snapshot_sha')
        if (!legacySha || legacySha !== v4Sha) {
            throw new SnapshotMismatchError(
                `snapshot_sha 不一致，禁止形成 comparison: ${legacySha} != ${v4Sha}`,
            )
        }

        const sql = `INSERT INTO brain_v4_comparisons (
            comparison_id, feature_id, profile, subject_type, subject_code, snapshot_id,
            snapshot_sha, data_cutoff, legacy_run_id, v4_run_id, blind_label, reviewer_score,
            is_shadow, payload
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
        ) RETURNING *`
        const values: unknown[] = [
            record.comparison_id,
            stringValue(v4, 'feature_id'),
            stringValue(v4, 'profile'),
            stringValue(v4, 'subject_type'),
            stringValue(v4, 'subject_code'),
            stringValue(v4, 'snapshot_id'),
            v4Sha,
            stringValue(v4, 'data_cutoff'),
            record.legacy_run_id,
            record.v4_run_id,
            record.blind_label ?? null,
            record.reviewer_score ?? null,
            true,
            JSON.stringify(asRecord(record.payload)),
        ]
        const result = await this.db.query(sql, values)
        return (
            result.rows[0] ?? {
                comparison_id: record.comparison_id,
                legacy_run_id: record.legacy_run_id,
                v4_run_id: record.v4_run_id,
                blind_label: record.blind_label ?? null,
                reviewer_score: record.reviewer_score ?? null,
                is_shadow: true,
            }
        )
    }
}

export const brainV4ArchiveService = new BrainV4ArchiveService()

export default brainV4ArchiveService
