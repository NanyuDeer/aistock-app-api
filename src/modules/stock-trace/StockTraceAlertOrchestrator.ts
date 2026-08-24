import { randomUUID } from 'node:crypto';
import pool from '../../core/db';
import { NotificationService, type NotificationInput } from '../../core/notification/NotificationService';
import { pushMovementUpdateToUser } from '../../core/ws/channels/alert-channel';
import type { MovementViewV2, TriggerEvent } from './types';

type SecondaryReason = 'severity_upgraded' | 'a_grade_major_cause';
let schemaPromise: Promise<void> | null = null;

interface EventContext {
    symbol: string;
    stockName: string;
    triggeredAt: Date;
}

export class StockTraceAlertOrchestrator {
    static async pushSeverityUpgrade(event: TriggerEvent): Promise<void> {
        const payload = {
            event_id: event.eventId,
            trigger_revision: event.triggerRevision,
            symbol: event.symbol,
            stock_name: event.stockName,
            severity: event.severity,
            change_pct: event.actualValue,
        };
        await this.pushSecondary(event.eventId, 'severity_upgraded', payload, {
            deliveryKey: `severity_upgraded:r${event.triggerRevision}`,
            notification: {
                category: 'price_movement',
                sourceKey: `movement:${event.eventId}:severity-upgrade:r${event.triggerRevision}`,
                symbol: event.symbol,
                stockName: event.stockName,
                title: `${event.stockName}：异动升级`,
                summary: `${event.direction === 'up' ? '上涨' : '下跌'}幅度扩大至 ${Number(event.actualValue).toFixed(2)}%，当前等级 ${event.severity}`,
                targetPath: `/modules/favorites/pages/insight-detail-move?event_id=${encodeURIComponent(event.eventId)}`,
                payload,
                occurredAt: event.triggeredAt.toISOString(),
            },
        });
    }

    static async pushConfirmedMajorCause(eventId: string, artifactId: string, movementView: MovementViewV2): Promise<void> {
        const payload = {
            event_id: eventId,
            artifact_id: artifactId,
            movement_view: movementView,
        };
        const event = await this.getEventContext(eventId);
        await this.pushSecondary(eventId, 'a_grade_major_cause', payload, {
            artifactId,
            notification: event ? {
                category: 'price_movement',
                // 同一异动只首次通知“主因确认”，后续重复计算不会刷屏。
                sourceKey: `movement:${eventId}:major-cause`,
                symbol: event.symbol,
                stockName: event.stockName,
                title: `${event.stockName}：异动主因确认`,
                summary: movementView.primaryCandidate?.verdict || '异动主因已确认，可查看详情。',
                targetPath: `/modules/favorites/pages/insight-detail-move?event_id=${encodeURIComponent(eventId)}`,
                payload,
                occurredAt: this.toIso(movementView.generatedAt) || new Date().toISOString(),
            } : undefined,
        });
    }

    private static async pushSecondary(
        eventId: string,
        reason: SecondaryReason,
        payload: Record<string, unknown>,
        options: {
            artifactId?: string;
            deliveryKey?: string;
            notification?: NotificationInput;
        } = {},
    ): Promise<void> {
        await this.ensureSchema();
        const deliveryKey = options.deliveryKey || reason;
        const recipients = await pool.query<{ openid: string }>(
            'SELECT openid FROM stock_trace_user_events WHERE event_id = $1',
            [eventId],
        );
        await Promise.all(recipients.rows.map(async ({ openid }) => {
            // The unique key is the delivery gate: at most one secondary push per event and user.
            const inserted = await pool.query<{ id: string }>(`
                INSERT INTO stock_trace_push_records
                    (id, event_id, openid, push_kind, trigger_reason, artifact_id, channel, status, payload, sent_at)
                VALUES ($1, $2, $3, 'secondary', $4, $5, 'websocket', 'sent', $6::jsonb, CURRENT_TIMESTAMP)
                ON CONFLICT (event_id, openid, push_kind, trigger_reason) DO NOTHING
                RETURNING id
            `, [randomUUID(), eventId, openid, deliveryKey, options.artifactId || null, JSON.stringify(payload)]);
            if ((inserted.rowCount || 0) > 0) {
                pushMovementUpdateToUser(openid, { ...payload, push_reason: reason });
                if (options.notification) {
                    try {
                        await NotificationService.createForUser(openid, options.notification);
                    } catch (error) {
                        console.warn('[StockTrace] secondary App notification failed:', error instanceof Error ? error.message : String(error));
                    }
                }
            }
        }));
    }

    private static async getEventContext(eventId: string): Promise<EventContext | null> {
        const result = await pool.query<{ symbol: string; stock_name: string; first_triggered_at: Date }>(`
            SELECT symbol, stock_name, first_triggered_at
            FROM stock_trace_events
            WHERE event_id = $1
            LIMIT 1
        `, [eventId]);
        const row = result.rows[0];
        return row ? { symbol: row.symbol, stockName: row.stock_name, triggeredAt: row.first_triggered_at } : null;
    }

    private static toIso(value: string | undefined): string | undefined {
        if (!value) return undefined;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }

    private static async ensureSchema(): Promise<void> {
        if (!schemaPromise) {
            schemaPromise = Promise.all([
                pool.query("ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS trigger_reason VARCHAR(64) NOT NULL DEFAULT ''"),
                pool.query("ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS artifact_id UUID"),
                pool.query("ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS channel VARCHAR(24) NOT NULL DEFAULT 'websocket'"),
            ]).then(async () => {
                await pool.query("UPDATE stock_trace_push_records SET trigger_reason = '' WHERE trigger_reason IS NULL");
                await pool.query("ALTER TABLE stock_trace_push_records ALTER COLUMN trigger_reason SET DEFAULT ''");
                await pool.query('ALTER TABLE stock_trace_push_records ALTER COLUMN trigger_reason SET NOT NULL');
                await pool.query('ALTER TABLE stock_trace_push_records DROP CONSTRAINT IF EXISTS stock_trace_push_records_event_id_openid_push_kind_key');
                await pool.query(`
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_trace_push_records_delivery
                    ON stock_trace_push_records (event_id, openid, push_kind, trigger_reason)
                `);
            });
        }
        return schemaPromise;
    }
}
