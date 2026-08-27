// 通知补投任务：消费 notification_outbox 中写失败的通知。
//
// 存在意义：上游事件已经落库，只有 App 通知那一步因数据库抖动失败时，
// 补投依赖 source_key 稳定 —— user_notifications的 UNIQUE (openid, source_key) 保证重复补投不会产生第二条通知。
import pool from '../db';
import { NotificationService, type NotificationInput } from './NotificationService';

interface OutboxRow {
    id: string;
    openid: string | null;
    input: NotificationInput;
    attempts: number;
}

export interface RetrySummary {
    flushed: number;
    delivered: number;
    retrying: number;
    dropped: number;
}

const BATCH_SIZE = 200;
const MAX_ATTEMPTS = 8;
/** 每次失败后的下次尝试间隔（分钟），下标即已尝试次数，超出取最后一个。 */
const BACKOFF_MINUTES = [1, 5, 15, 30, 60, 120, 240, 480];

export class NotificationRetryService {
    private static running = false;

    static async run(): Promise<RetrySummary> {
        const summary: RetrySummary = { flushed: 0, delivered: 0, retrying: 0, dropped: 0 };
        if (this.running) return summary;
        this.running = true;

        try {
            summary.flushed = await NotificationService.flushMemoryBuffer();

            const due = await pool.query<OutboxRow>(`
                SELECT id, openid, input, attempts
                FROM notification_outbox
                WHERE next_attempt_at <= NOW()
                ORDER BY next_attempt_at ASC
                LIMIT $1
            `, [BATCH_SIZE]);

            for (const row of due.rows) {
                try {
                    await NotificationService.redeliver({ openid: row.openid, input: row.input });
                    await pool.query('DELETE FROM notification_outbox WHERE id = $1', [row.id]);
                    summary.delivered++;
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    const attempts = row.attempts + 1;
                    if (attempts >= MAX_ATTEMPTS) {
                        await pool.query('DELETE FROM notification_outbox WHERE id = $1', [row.id]);
                        summary.dropped++;
                        console.error(`[NotificationRetry] dropped after ${attempts} attempts (sourceKey=${row.input?.sourceKey}): ${reason}`);
                        continue;
                    }
                    const delayMinutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)];
                    await pool.query(`
                        UPDATE notification_outbox
                        SET attempts = $2, last_error = $3, next_attempt_at = NOW() + make_interval(mins => $4)
                        WHERE id = $1
                    `, [row.id, attempts, reason.slice(0, 500), delayMinutes]);
                    summary.retrying++;
                }
            }
        } finally {
            this.running = false;
        }

        return summary;
    }

    static isRunning(): boolean {
        return this.running;
    }
}
