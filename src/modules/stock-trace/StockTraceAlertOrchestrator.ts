import { randomUUID } from 'node:crypto';
import pool from '../../core/db';
import { pushMovementUpdateToUser } from '../../core/ws/channels/alert-channel';
import type { MovementViewV2, TriggerEvent } from './types';

type SecondaryReason = 'severity_upgraded' | 'a_grade_major_cause';
let schemaPromise: Promise<void> | null = null;

export class StockTraceAlertOrchestrator {
    static async pushSeverityUpgrade(event: TriggerEvent): Promise<void> {
        await this.pushSecondary(event.eventId, 'severity_upgraded', {
            event_id: event.eventId,
            trigger_revision: event.triggerRevision,
            symbol: event.symbol,
            stock_name: event.stockName,
            severity: event.severity,
            change_pct: event.actualValue,
        });
    }

    static async pushConfirmedMajorCause(eventId: string, artifactId: string, movementView: MovementViewV2): Promise<void> {
        await this.pushSecondary(eventId, 'a_grade_major_cause', {
            event_id: eventId,
            artifact_id: artifactId,
            movement_view: movementView,
        }, artifactId);
    }

    private static async pushSecondary(
        eventId: string,
        reason: SecondaryReason,
        payload: Record<string, unknown>,
        artifactId?: string,
    ): Promise<void> {
        await this.ensureSchema();
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
                ON CONFLICT (event_id, openid, push_kind) DO NOTHING
                RETURNING id
            `, [randomUUID(), eventId, openid, reason, artifactId || null, JSON.stringify(payload)]);
            if ((inserted.rowCount || 0) > 0) {
                pushMovementUpdateToUser(openid, { ...payload, push_reason: reason });
            }
        }));
    }

    private static async ensureSchema(): Promise<void> {
        if (!schemaPromise) {
            schemaPromise = Promise.all([
                pool.query("ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS trigger_reason VARCHAR(64)"),
                pool.query("ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS artifact_id UUID"),
                pool.query("ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS channel VARCHAR(24) NOT NULL DEFAULT 'websocket'"),
            ]).then(() => undefined);
        }
        return schemaPromise;
    }
}
