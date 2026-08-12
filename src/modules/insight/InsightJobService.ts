// src/modules/insight/InsightJobService.ts
// 自选股洞察任务队列：watchlist_insight_jobs + watchlist_insight_outbox → Redis Stream
//
// 镜像 stock-trace 的 outbox → Stream 模式：job 唯一性由 (event_id, analysis_version) 唯一键保证，
// outbox 状态机 pending → published，交付语义为至少一次，Python Consumer 需按 job_id 幂等消费。
import pool from '../../core/db';
import redis from '../../core/redis';

export const WATCHLIST_INSIGHT_STREAM = 'watchlist-insight.jobs';
export const WATCHLIST_INSIGHT_ANALYSIS_VERSION = 'watchlist-insight-v1';

export type InsightJobStatus = 'queued' | 'published' | 'processing' | 'completed' | 'failed' | 'dead_letter';

interface PendingOutboxRow {
    outbox_id: string;
    job_id: string;
    payload: { eventId: string };
}

/**
 * 入队：INSERT job（ON CONFLICT DO NOTHING 幂等）→ INSERT outbox → 提交后立即发布。
 * 使用池内单个连接承载事务，避免 pool.query('BEGIN') 在多请求并发下跨连接破坏原子性。
 * @param eventId watchlist_insight_events.event_id
 * @param opts.force 强制重入队：同 (event_id, analysis_version) 已存在时重置 job 为 queued 并
 *   追加新 outbox（新 stream 消息），供补抓场景让 Python 重新归因（UPSERT 覆盖旧结果）。
 *   副作用：attempt_count 清零，会把已达 MAX_ATTEMPTS 的 job 从 dead_letter 复活重试（补抓场景
 *   符合预期——新证据包值得重试）。默认 false 保持幂等（已存在则 ROLLBACK 不重复入队）。
 */
export async function enqueue(eventId: string, opts: { force?: boolean } = {}): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const conflictClause = opts.force
            ? `ON CONFLICT (event_id, analysis_version) DO UPDATE SET status = 'queued', attempt_count = 0`
            : `ON CONFLICT (event_id, analysis_version) DO NOTHING`;
        const { rows } = await client.query<{ job_id: string }>(
            `INSERT INTO watchlist_insight_jobs (event_id, analysis_version) VALUES ($1, $2)
             ${conflictClause} RETURNING job_id`,
            [eventId, WATCHLIST_INSIGHT_ANALYSIS_VERSION],
        );
        if (rows.length === 0) {
            // 该 event + version 已有任务（含已发布/处理中/完成），不重复入队
            await client.query('ROLLBACK');
            return;
        }
        await client.query(
            `INSERT INTO watchlist_insight_outbox (job_id, topic, payload) VALUES ($1, $2, $3)`,
            [rows[0].job_id, WATCHLIST_INSIGHT_STREAM, JSON.stringify({ eventId })],
        );
        await client.query('COMMIT');
    } catch (e) {
        // 连接异常时 ROLLBACK 也可能失败，吞掉以保证 finally 里 release 仍执行
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
    // 事务提交后再发布；单条失败由 publishPending 的 attempt_count 重试语义兜底
    await publishPending();
}

/**
 * 发布 pending outbox 到 Redis Stream（batch 默认 50）。
 * 逐条 xadd 成功后 outbox 置 published、jobs 置 published + stream_message_id；
 * 单条失败仅累加 attempt_count（FOR UPDATE SKIP LOCKED 保证并发下不重复处理）。
 * @returns 成功发布条数
 */
export async function publishPending(batch = 50): Promise<number> {
    const limit = Math.min(Math.max(Math.floor(batch), 1), 200);
    const { rows } = await pool.query<PendingOutboxRow>(
        `SELECT o.outbox_id, o.job_id, o.payload
         FROM watchlist_insight_outbox o
         WHERE o.status = 'pending'
         ORDER BY o.outbox_id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit],
    );
    let published = 0;
    for (const row of rows) {
        try {
            const streamMessageId = await redis.xadd(
                WATCHLIST_INSIGHT_STREAM,
                '*',
                'job_id', row.job_id,
                'event_id', row.payload.eventId,
                'analysis_version', WATCHLIST_INSIGHT_ANALYSIS_VERSION,
            );
            await pool.query(
                `UPDATE watchlist_insight_outbox SET status = 'published', published_at = NOW()
                 WHERE outbox_id = $1 AND status = 'pending'`,
                [row.outbox_id],
            );
            await pool.query(
                `UPDATE watchlist_insight_jobs SET status = 'published', stream_message_id = $2
                 WHERE job_id = $1`,
                [row.job_id, streamMessageId],
            );
            published++;
        } catch (e) {
            // xadd 或状态更新失败：累加 attempt_count 待下次重试，不阻断其余任务
            await pool.query(
                `UPDATE watchlist_insight_outbox SET attempt_count = attempt_count + 1 WHERE outbox_id = $1`,
                [row.outbox_id],
            ).catch(() => {});
        }
    }
    return published;
}

/**
 * Python Consumer 回报任务状态（PATCH /jobs/:jobId）。
 * @returns 更新后的 attempt_count；job 不存在返回 null
 */
export async function reportStatus(
    jobId: string,
    status: InsightJobStatus,
    options: { lastErrorCode?: string; incrementAttempt?: boolean } = {},
): Promise<{ attemptCount: number } | null> {
    const result = await pool.query<{ attempt_count: number }>(
        `UPDATE watchlist_insight_jobs
         SET status = $2,
             attempt_count = attempt_count + CASE WHEN $3 THEN 1 ELSE 0 END,
             last_error_code = $4
         WHERE job_id = $1
         RETURNING attempt_count`,
        [jobId, status, options.incrementAttempt === true, options.lastErrorCode ?? null],
    );
    return result.rows[0] ? { attemptCount: Number(result.rows[0].attempt_count) } : null;
}
