import { randomUUID } from 'node:crypto';
import pool from '../db';
import {
    pushNotificationToUser,
    type NotificationSocketPayload,
} from '../ws/channels/notification-channel';

export type NotificationCategory = 'price_movement' | 'insight' | 'stock_info' | 'forecast' | 'performance_report';

export interface NotificationInput {
    category: NotificationCategory;
    sourceKey: string;
    symbol?: string;
    stockName?: string;
    title: string;
    summary: string;
    targetPath: string;
    payload?: Record<string, unknown>;
}

export interface UserNotification extends NotificationSocketPayload {
    category: NotificationCategory;
}

/** 一条待补投的通知：openid 为 null 表示按 symbol 扇出给全部自选用户。 */
export interface PendingDelivery {
    openid: string | null;
    input: NotificationInput;
}

interface NotificationRow {
    id: string;
    openid?: string;
    category: NotificationCategory;
    symbol: string | null;
    stock_name: string | null;
    title: string;
    summary: string;
    target_path: string;
    payload: Record<string, unknown> | null;
    created_at: Date | string;
    read_at: Date | string | null;
}

interface Cursor {
    createdAt: string;
    id: string;
}

export class NotificationTableUnavailableError extends Error {
    constructor(cause?: unknown) {
        super('通知服务暂不可用');
        this.name = 'NotificationTableUnavailableError';
        if (cause) this.cause = cause;
    }
}

export class NotificationService {
    private static schemaReady: Promise<void> | null = null;

    /**
     * 落库失败且 outbox 也写不进去时（如 PG 整体不可用）的最后一道内存兜底。
     * 进程重启会丢失，仅用于顶住数据库短暂抖动，恢复后由重试任务刷回 outbox。
     */
    private static readonly memoryBuffer: PendingDelivery[] = [];
    private static readonly MEMORY_BUFFER_LIMIT = 500;

    static async ensureSchema(): Promise<void> {
        if (!this.schemaReady) {
            this.schemaReady = (async () => {
                await pool.query(`
                    CREATE TABLE IF NOT EXISTS user_notifications (
                        id UUID PRIMARY KEY,
                        openid TEXT NOT NULL REFERENCES users(openid) ON DELETE CASCADE,
                        category VARCHAR(32) NOT NULL,
                        source_key VARCHAR(200) NOT NULL,
                        symbol VARCHAR(16),
                        stock_name VARCHAR(64),
                        title VARCHAR(160) NOT NULL,
                        summary TEXT NOT NULL DEFAULT '',
                        target_path TEXT NOT NULL DEFAULT '',
                        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        read_at TIMESTAMPTZ,
                        UNIQUE (openid, source_key)
                    )
                `);
                await pool.query('CREATE INDEX IF NOT EXISTS idx_user_notifications_openid_created ON user_notifications (openid, created_at DESC, id DESC)');
                await pool.query('CREATE INDEX IF NOT EXISTS idx_user_notifications_openid_unread ON user_notifications (openid, created_at DESC, id DESC) WHERE read_at IS NULL');
                // 通知写失败后的待补投队列。不加 openid 外键：用户被删时补投失败即可，
                // 不能让入队本身失败，否则这条通知就真的丢了。
                await pool.query(`
                    CREATE TABLE IF NOT EXISTS notification_outbox (
                        id UUID PRIMARY KEY,
                        openid TEXT,
                        input JSONB NOT NULL,
                        attempts INTEGER NOT NULL DEFAULT 0,
                        last_error TEXT NOT NULL DEFAULT '',
                        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                `);
                // 同一投递目标只保留一条待补投记录，避免反复失败堆积。
                await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_outbox_target
                    ON notification_outbox (COALESCE(openid, ''), (input->>'sourceKey'))`);
                await pool.query('CREATE INDEX IF NOT EXISTS idx_notification_outbox_due ON notification_outbox (next_attempt_at)');
            })().catch((error: unknown) => {
                const normalized = error instanceof Error ? error : new Error(String(error));
                this.schemaReady = null;
                console.error('[Notification] CRITICAL: notification table is unavailable:', normalized.message);
                throw new NotificationTableUnavailableError(normalized);
            });
        }
        await this.schemaReady;
    }

    static async ensureSchemaAtStartup(): Promise<void> {
        await this.ensureSchema();
    }

    static async createForUser(openid: string, input: NotificationInput): Promise<UserNotification | null> {
        try {
            return await this.insertForUser(openid, input);
        } catch (error) {
            await this.recordFailure({ openid, input }, error);
            throw error;
        }
    }

    static async createForWatchers(input: NotificationInput): Promise<number> {
        try {
            return await this.insertForWatchers(input);
        } catch (error) {
            await this.recordFailure({ openid: null, input }, error);
            throw error;
        }
    }

    /**
     * 重试任务专用的原始投递入口：失败时直接抛出，由调用方安排下次重试，
     * 不再二次入队（否则会和已有的 outbox 记录打架）。
     */
    static async redeliver(pending: PendingDelivery): Promise<number> {
        if (pending.openid) {
            return (await this.insertForUser(pending.openid, pending.input)) ? 1 : 0;
        }
        return this.insertForWatchers(pending.input);
    }

    private static async insertForUser(openid: string, input: NotificationInput): Promise<UserNotification | null> {
        await this.ensureSchema();
        const result = await pool.query<NotificationRow>(`
            INSERT INTO user_notifications
                (id, openid, category, source_key, symbol, stock_name, title, summary, target_path, payload)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
            ON CONFLICT (openid, source_key) DO NOTHING
            RETURNING id, category, symbol, stock_name, title, summary, target_path, payload, created_at, read_at
        `, [
            randomUUID(), openid, input.category, input.sourceKey, input.symbol || null,
            input.stockName || null, input.title, input.summary, input.targetPath,
            JSON.stringify(input.payload || {}),
        ]);
        const row = result.rows[0];
        if (!row) return null;
        const notification = this.toPublic(row);
        pushNotificationToUser(openid, notification);
        return notification;
    }

    /** 一次批量写入全部自选用户，避免按人数放大数据库往返。 */
    private static async insertForWatchers(input: NotificationInput): Promise<number> {
        await this.ensureSchema();
        if (!input.symbol) return 0;
        const recipients = await pool.query<{ openid: string }>(
            'SELECT DISTINCT openid FROM user_stocks WHERE symbol = $1',
            [input.symbol],
        );
        if (recipients.rows.length === 0) return 0;

        const openids = recipients.rows.map(row => row.openid);
        const ids = openids.map(() => randomUUID());
        const result = await pool.query<NotificationRow>(`
            INSERT INTO user_notifications
                (id, openid, category, source_key, symbol, stock_name, title, summary, target_path, payload)
            SELECT target.id, target.openid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
            FROM unnest($1::uuid[], $2::text[]) AS target(id, openid)
            ON CONFLICT (openid, source_key) DO NOTHING
            RETURNING id, openid, category, symbol, stock_name, title, summary, target_path, payload, created_at, read_at
        `, [
            ids, openids, input.category, input.sourceKey, input.symbol,
            input.stockName || null, input.title, input.summary, input.targetPath,
            JSON.stringify(input.payload || {}),
        ]);

        for (const row of result.rows) {
            if (row.openid) pushNotificationToUser(row.openid, this.toPublic(row));
        }
        return result.rows.length;
    }

    /**
     * 通知写失败时把投递意图落到 outbox，交给重试任务补投。
     * source_key 稳定是补投幂等的前提：重复补投会被 user_notifications 的唯一键挡掉。
     */
    private static async recordFailure(pending: PendingDelivery, cause: unknown): Promise<void> {
        const reason = cause instanceof Error ? cause.message : String(cause);
        try {
            await this.persistToOutbox(pending, reason);
        } catch (error) {
            this.bufferInMemory(pending);
            console.error('[Notification] outbox unavailable, kept in memory:', error instanceof Error ? error.message : String(error));
        }
    }

    private static async persistToOutbox(pending: PendingDelivery, reason: string): Promise<void> {
        await this.ensureSchema();
        await pool.query(`
            INSERT INTO notification_outbox (id, openid, input, last_error)
            VALUES ($1, $2, $3::jsonb, $4)
            ON CONFLICT (COALESCE(openid, ''), (input->>'sourceKey')) DO NOTHING
        `, [randomUUID(), pending.openid, JSON.stringify(pending.input), reason.slice(0, 500)]);
    }

    private static bufferInMemory(pending: PendingDelivery): void {
        if (this.memoryBuffer.length >= this.MEMORY_BUFFER_LIMIT) {
            const dropped = this.memoryBuffer.shift();
            console.error('[Notification] memory buffer full, dropped:', dropped?.input.sourceKey);
        }
        this.memoryBuffer.push(pending);
    }

    /** 数据库恢复后把内存兜底的投递意图刷回 outbox，由重试任务统一处理。 */
    static async flushMemoryBuffer(): Promise<number> {
        let flushed = 0;
        while (this.memoryBuffer.length > 0) {
            const pending = this.memoryBuffer[0];
            try {
                await this.persistToOutbox(pending, 'recovered from memory buffer');
            } catch {
                // 数据库仍不可用：保留剩余条目，等下一轮重试
                break;
            }
            this.memoryBuffer.shift();
            flushed++;
        }
        return flushed;
    }

    static async list(openid: string, limit: number, cursor?: string): Promise<{ items: UserNotification[]; nextCursor: string | null; unreadCount: number }> {
        await this.ensureSchema();
        const parsedCursor = cursor ? this.decodeCursor(cursor) : null;
        const params: unknown[] = [openid];
        let where = 'WHERE openid = $1';
        if (parsedCursor) {
            params.push(parsedCursor.createdAt, parsedCursor.id);
            where += ' AND (created_at, id) < ($2::timestamptz, $3::uuid)';
        }
        params.push(limit + 1);
        const [listResult, unreadResult] = await Promise.all([
            pool.query<NotificationRow>(`
                SELECT id, category, symbol, stock_name, title, summary, target_path, payload, created_at, read_at
                FROM user_notifications
                ${where}
                ORDER BY created_at DESC, id DESC
                LIMIT $${params.length}
            `, params),
            pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM user_notifications WHERE openid = $1 AND read_at IS NULL', [openid]),
        ]);
        const hasMore = listResult.rows.length > limit;
        const rows = hasMore ? listResult.rows.slice(0, limit) : listResult.rows;
        const last = rows[rows.length - 1];
        return {
            items: rows.map(row => this.toPublic(row)),
            nextCursor: hasMore && last ? this.encodeCursor(this.toPublic(last)) : null,
            unreadCount: Number(unreadResult.rows[0]?.count || 0),
        };
    }

    static async markRead(openid: string, ids: string[]): Promise<void> {
        await this.ensureSchema();
        if (!ids.length) return;
        await pool.query(
            'UPDATE user_notifications SET read_at = COALESCE(read_at, NOW()) WHERE openid = $1 AND id = ANY($2::uuid[])',
            [openid, ids],
        );
    }

    static toPublic(row: NotificationRow): UserNotification {
        return {
            id: row.id,
            category: row.category,
            symbol: row.symbol,
            stockName: row.stock_name,
            title: row.title,
            summary: row.summary,
            targetPath: row.target_path,
            payload: row.payload || {},
            createdAt: new Date(row.created_at).toISOString(),
            readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
        };
    }

    private static encodeCursor(notification: UserNotification): string {
        return Buffer.from(JSON.stringify({ createdAt: notification.createdAt, id: notification.id })).toString('base64url');
    }

    private static decodeCursor(value: string): Cursor | null {
        try {
            const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
            if (!parsed.createdAt || !parsed.id) return null;
            return parsed;
        } catch {
            return null;
        }
    }
}
