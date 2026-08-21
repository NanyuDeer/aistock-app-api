import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../../core/db';
import redis from '../../core/redis';

export const STOCK_TRACE_JOB_STREAM = 'stock-trace.jobs';
export const STOCK_TRACE_ANALYSIS_VERSION = 'llm-stock-trace-v1';
const JOB_KIND = 'analyze';

const MAX_HOLD_SECONDS = 60;             // 硬超时：超过后不再 hold，直接发布交由 consumer 兜底

export interface StockTraceJobInput {
    eventId: string;
    triggerRevision: number;
    analysisVersion?: string;
}

export type StockTraceJobStatus = 'queued' | 'published' | 'processing' | 'completed' | 'failed' | 'dead_letter';

interface PendingOutboxRow {
    outbox_id: string;
    job_id: string;
    payload: StockTraceJobInput;
    created_at: Date;
}

/**
 * Job 与 Outbox 的唯一性由数据库保证；Redis Stream 的交付语义为至少一次。
 * Python Consumer 必须以 job_id / event_id + revision + analysis_version 幂等消费。
 */
export class StockTraceJobService {
    static async ensureSchema(): Promise<void> {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_trace_jobs (
                job_id UUID PRIMARY KEY,
                event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
                trigger_revision INTEGER NOT NULL,
                analysis_version VARCHAR(32) NOT NULL,
                job_kind VARCHAR(24) NOT NULL DEFAULT 'analyze',
                status VARCHAR(16) NOT NULL DEFAULT 'queued',
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error_code VARCHAR(64), stream_message_id VARCHAR(64),
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (event_id, trigger_revision, analysis_version, job_kind)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_trace_outbox (
                outbox_id UUID PRIMARY KEY,
                job_id UUID NOT NULL UNIQUE REFERENCES stock_trace_jobs(job_id),
                topic VARCHAR(64) NOT NULL, payload JSONB NOT NULL,
                status VARCHAR(16) NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error_code VARCHAR(64), published_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_stock_trace_jobs_status_created ON stock_trace_jobs(status, created_at)');
        await pool.query("CREATE INDEX IF NOT EXISTS idx_stock_trace_outbox_pending ON stock_trace_outbox(status, created_at) WHERE status = 'pending'");
        await pool.query('ALTER TABLE stock_trace_outbox ADD COLUMN IF NOT EXISTS held_until TIMESTAMPTZ');
    }

    static async enqueue(client: PoolClient, input: StockTraceJobInput): Promise<string> {
        const analysisVersion = input.analysisVersion || STOCK_TRACE_ANALYSIS_VERSION;
        const existing = await client.query<{ job_id: string }>(`
            SELECT job_id FROM stock_trace_jobs
            WHERE event_id = $1 AND trigger_revision = $2 AND analysis_version = $3 AND job_kind = $4
            FOR UPDATE
        `, [input.eventId, input.triggerRevision, analysisVersion, JOB_KIND]);
        if (existing.rows[0]) return existing.rows[0].job_id;

        const jobId = randomUUID();
        const payload: StockTraceJobInput = {
            eventId: input.eventId,
            triggerRevision: input.triggerRevision,
            analysisVersion,
        };
        await client.query(`
            INSERT INTO stock_trace_jobs (job_id, event_id, trigger_revision, analysis_version, job_kind)
            VALUES ($1, $2, $3, $4, $5)
        `, [jobId, input.eventId, input.triggerRevision, analysisVersion, JOB_KIND]);
        await client.query(`
            INSERT INTO stock_trace_outbox (outbox_id, job_id, topic, payload)
            VALUES ($1, $2, $3, $4::jsonb)
        `, [randomUUID(), jobId, STOCK_TRACE_JOB_STREAM, JSON.stringify(payload)]);
        return jobId;
    }

    static async publishPending(limit = 50): Promise<{ published: number; failed: number }> {
        await this.ensureSchema();
        const rows = await pool.query<PendingOutboxRow>(`
            SELECT outbox_id, job_id, payload, created_at FROM stock_trace_outbox
            WHERE status = 'pending'
              AND (held_until IS NULL OR held_until <= CURRENT_TIMESTAMP
                   OR created_at <= CURRENT_TIMESTAMP - (interval '1 second' * $2))
            ORDER BY created_at
            LIMIT $1
        `, [Math.min(Math.max(limit, 1), 200), MAX_HOLD_SECONDS]);
        let published = 0;
        let failed = 0;
        for (const row of rows.rows) {
            try {
                // 快照 gate：enriched 未就绪且未超过硬超时 → 置 held_until 5s 后重查（continue 不发布）；
                // 已超过 MAX_HOLD_SECONDS 的 job 不再 hold，直接发布（由 consumer SNAPSHOT_TIMEOUT 兜底）。
                const ready = await this.checkEnrichedSnapshotReady(row.payload.eventId, row.payload.triggerRevision);
                const elapsedMs = Date.now() - row.created_at.getTime();
                if (!ready && elapsedMs <= MAX_HOLD_SECONDS * 1000) {
                    await pool.query(`
                        UPDATE stock_trace_outbox
                        SET held_until = CURRENT_TIMESTAMP + interval '5 seconds', updated_at = CURRENT_TIMESTAMP
                        WHERE outbox_id = $1 AND status = 'pending'
                    `, [row.outbox_id]);
                    continue;
                }
                const streamMessageId = await redis.xadd(
                    STOCK_TRACE_JOB_STREAM,
                    '*',
                    'job_id', row.job_id,
                    'event_id', row.payload.eventId,
                    'trigger_revision', String(row.payload.triggerRevision),
                    'analysis_version', row.payload.analysisVersion || STOCK_TRACE_ANALYSIS_VERSION,
                    'job_kind', JOB_KIND,
                    'created_at', new Date().toISOString(),
                );
                const update = await pool.query(`
                    UPDATE stock_trace_outbox
                    SET status = 'published', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
                        last_error_code = NULL
                    WHERE outbox_id = $1 AND status = 'pending'
                `, [row.outbox_id]);
                if (update.rowCount === 1) {
                    await pool.query(`
                        UPDATE stock_trace_jobs
                        SET status = 'published', stream_message_id = $2, updated_at = CURRENT_TIMESTAMP,
                            last_error_code = NULL
                        WHERE job_id = $1
                    `, [row.job_id, streamMessageId]);
                    published += 1;
                }
            } catch (error: unknown) {
                const errorCode = error instanceof Error ? error.name.slice(0, 64) : 'REDIS_PUBLISH_FAILED';
                await pool.query(`
                    UPDATE stock_trace_outbox
                    SET attempt_count = attempt_count + 1, last_error_code = $2, updated_at = CURRENT_TIMESTAMP
                    WHERE outbox_id = $1 AND status = 'pending'
                `, [row.outbox_id, errorCode]);
                await pool.query(`
                    UPDATE stock_trace_jobs
                    SET last_error_code = $2, updated_at = CURRENT_TIMESTAMP
                    WHERE job_id = $1 AND status = 'queued'
                `, [row.job_id, errorCode]);
                failed += 1;
            }
        }
        return { published, failed };
    }

    private static async checkEnrichedSnapshotReady(eventId: string, triggerRevision: number): Promise<boolean> {
        const result = await pool.query<{ snapshot_id: string }>(`
            SELECT snapshot_id FROM stock_trace_snapshots
            WHERE event_id = $1 AND trigger_revision = $2 AND snapshot_stage = 'enriched'
            ORDER BY captured_at DESC LIMIT 1
        `, [eventId, triggerRevision]);
        return result.rows.length > 0;
    }

    static async reportStatus(
        jobId: string,
        status: StockTraceJobStatus,
        options: { lastErrorCode?: string; incrementAttempt?: boolean } = {},
    ): Promise<{ attemptCount: number } | null> {
        await this.ensureSchema();
        const result = await pool.query<{ attempt_count: number }>(`
            UPDATE stock_trace_jobs
            SET status = $2, attempt_count = attempt_count + CASE WHEN $3 THEN 1 ELSE 0 END,
                last_error_code = $4, updated_at = CURRENT_TIMESTAMP
            WHERE job_id = $1
            RETURNING attempt_count
        `, [jobId, status, options.incrementAttempt === true, options.lastErrorCode || null]);
        return result.rows[0] ? { attemptCount: Number(result.rows[0].attempt_count) } : null;
    }
}
