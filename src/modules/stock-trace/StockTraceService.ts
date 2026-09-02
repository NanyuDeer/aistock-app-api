import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../../core/db';
import { pushAlertToUser } from '../../core/ws/channels/alert-channel';
import { NotificationService } from '../../core/notification/NotificationService';
import { StockTraceSnapshotService } from './StockTraceSnapshotService';
import { StockTraceJobService } from './StockTraceJobService';
import {
    createEventId,
    formatChinaTradingDate,
    getSeverity,
    isRevisionNeeded,
    PRICE_RESET_WINDOW_MS,
    PRICE_RULE_VERSION,
    PRICE_TRIGGER_PERCENT,
    type FavoriteSecurity,
    type PriceFact,
    type PriceMutationResult,
    type TraceDirection,
    type TraceSeverity,
    type TriggerEvent,
} from './types';

interface EventRow {
    event_id: string;
    symbol: string;
    stock_name: string;
    trading_date: string;
    direction: TraceDirection;
    first_triggered_at: Date;
    window_start_at: Date;
    window_end_at: Date;
    current_trigger_revision: number;
    current_severity: TraceSeverity;
    recovery_started_at: Date | null;
}

interface RevisionRow {
    trigger_revision: number;
    actual_value: string | number;
    severity: TraceSeverity;
}

const EVENT_SCRAPE_RETRY_DELAYS_MS = [500, 2000]; // 指数退避：500ms → 2s

let schemaPromise: Promise<void> | null = null;

function toNumber(value: string | number): number {
    return typeof value === 'number' ? value : Number(value);
}

function directionFor(changePct: number): TraceDirection {
    return changePct > 0 ? 'up' : 'down';
}

function buildTriggerEvent(row: EventRow, revision: RevisionRow, fact: PriceFact): TriggerEvent {
    return {
        eventId: row.event_id,
        triggerRevision: revision.trigger_revision,
        symbol: row.symbol,
        stockName: row.stock_name,
        tradingDate: row.trading_date,
        direction: row.direction,
        triggeredAt: fact.observedAt,
        windowStartAt: row.window_start_at,
        windowEndAt: row.window_end_at,
        latestPrice: fact.latestPrice,
        previousClose: fact.previousClose,
        actualValue: toNumber(revision.actual_value),
        thresholdValue: PRICE_TRIGGER_PERCENT,
        severity: revision.severity,
        ruleVersion: PRICE_RULE_VERSION,
    };
}

/** 统一事件抓取中台：异动事件创建/修订后触发 event_triggered 采集（P0-3）。
 * fire-and-forget；失败仅告警，不阻断 stock_trace 主流程。baseUrl 与鉴权
 * 头对齐 StockTraceSnapshotService 读库调用（同款 env 变量与 token）。
 * E-3 加固（2026-08-14）：占位/缺失 token 不发请求（对齐 StockTraceTriggerService
 * 语义，避免 Python 侧 403 徒增无效请求）；显式 5s 超时防悬空。
 * 2026-08-21：内置最多 2 次指数退避重试（500ms→2s），仍失败仅告警不抛异常。 */
export async function triggerEventScrape(
    event: EventRow,
    options: { retryDelaysMs?: number[] } = {},
): Promise<void> {
    const baseUrl = (process.env.AGENT_PY_URL || process.env.PYTHON_AGENT_URL || '').replace(/\/+$/, '');
    if (!baseUrl) return;
    const token = process.env.INTERNAL_API_TOKEN || '';
    if (!token || token === 'change-me-in-production') return;
    const delays = options.retryDelaysMs ?? EVENT_SCRAPE_RETRY_DELAYS_MS;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
        try {
            const response = await fetch(`${baseUrl}/api/agent/briefing/event-scrape/trigger`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Token': token,
                },
                signal: AbortSignal.timeout(5000),
                body: JSON.stringify({
                    scrape_mode: 'event_triggered',
                    event: {
                        symbol: event.symbol,
                        score_date: event.trading_date,
                        windowStartAt: event.window_start_at,
                        windowEndAt: event.window_end_at,
                    },
                }),
            });
            if (response.ok) return;
            lastError = new Error(`event scrape HTTP ${response.status}`);
        } catch (error: unknown) {
            lastError = error;
        }
        if (attempt < delays.length) {
            await new Promise((resolve) => setTimeout(resolve, delays[attempt] as number));
        }
    }
    // 仍失败：告警日志，不阻断 stock_trace 主流程（快照采集有缺库降级路径兜底）
    console.error('[StockTrace] event scrape trigger failed after retries:', lastError instanceof Error ? lastError.message : String(lastError));
}

export class StockTraceService {
    static async ensureSchema(): Promise<void> {
        if (!schemaPromise) {
            schemaPromise = this.createSchema().catch((err: unknown) => {
                // 失败时重置 schemaPromise，允许下次调用重试（避免进程启动时权限问题永久阻塞）
                schemaPromise = null;
                throw err;
            });
        }
        return schemaPromise;
    }

    private static async createSchema(): Promise<void> {
        // ALTER TABLE stocks 需要 owner 权限，aistock 用户可能无此权限。
        // 用 try/catch 包住：列已存在或无权限时跳过，不阻塞后续 stock_trace_* 表的创建。
        // getFavoriteSecurities() 依赖此列，列缺失时会在查询时报错（不影响 /internal/stock-trace/events 手动注入链路）。
        try {
            await pool.query(`ALTER TABLE stocks ADD COLUMN IF NOT EXISTS list_date VARCHAR(8) DEFAULT ''`);
        } catch (err: unknown) {
            console.warn('[StockTrace] ALTER TABLE stocks ADD list_date skipped:', err instanceof Error ? err.message : err);
        }
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_trace_events (
                event_id VARCHAR(128) PRIMARY KEY,
                symbol VARCHAR(6) NOT NULL,
                stock_name VARCHAR(80) NOT NULL,
                trading_date DATE NOT NULL,
                direction VARCHAR(8) NOT NULL CHECK (direction IN ('up', 'down')),
                first_triggered_at TIMESTAMPTZ NOT NULL,
                window_start_at TIMESTAMPTZ NOT NULL,
                window_end_at TIMESTAMPTZ NOT NULL,
                last_seen_at TIMESTAMPTZ NOT NULL,
                recovery_started_at TIMESTAMPTZ,
                event_status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (event_status IN ('active', 'closed', 'superseded')),
                current_trigger_revision INTEGER NOT NULL DEFAULT 1,
                current_severity VARCHAR(16) NOT NULL,
                related_event_id VARCHAR(128),
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_stock_trace_events_symbol_status ON stock_trace_events(symbol, event_status, last_seen_at DESC)');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_trace_event_revisions (
                event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
                trigger_revision INTEGER NOT NULL,
                triggered_at TIMESTAMPTZ NOT NULL,
                rule_version VARCHAR(32) NOT NULL,
                trigger_type VARCHAR(32) NOT NULL,
                threshold_value NUMERIC(10,4) NOT NULL,
                actual_value NUMERIC(10,4) NOT NULL,
                latest_price NUMERIC(16,4) NOT NULL,
                previous_close NUMERIC(16,4) NOT NULL,
                severity VARCHAR(16) NOT NULL,
                revision_reason VARCHAR(32) NOT NULL,
                data_quality VARCHAR(16) NOT NULL DEFAULT 'valid',
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (event_id, trigger_revision)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_trace_signals (
                id UUID PRIMARY KEY,
                event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
                trigger_revision INTEGER NOT NULL,
                signal_type VARCHAR(32) NOT NULL,
                direction VARCHAR(8) NOT NULL,
                threshold_value NUMERIC(10,4) NOT NULL,
                actual_value NUMERIC(10,4) NOT NULL,
                source VARCHAR(32) NOT NULL,
                observed_at TIMESTAMPTZ NOT NULL,
                raw_fact JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_trace_user_events (
                id UUID PRIMARY KEY,
                event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
                openid VARCHAR(128) NOT NULL,
                read_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (event_id, openid)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_trace_push_records (
                id UUID PRIMARY KEY,
                event_id VARCHAR(128) NOT NULL REFERENCES stock_trace_events(event_id),
                openid VARCHAR(128) NOT NULL,
                push_kind VARCHAR(32) NOT NULL,
                trigger_reason VARCHAR(64) NOT NULL DEFAULT '',
                artifact_id UUID,
                channel VARCHAR(24) NOT NULL DEFAULT 'websocket',
                status VARCHAR(16) NOT NULL,
                payload JSONB NOT NULL,
                sent_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query("ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS trigger_reason VARCHAR(64) NOT NULL DEFAULT ''");
        await pool.query('ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS artifact_id UUID');
        await pool.query("ALTER TABLE stock_trace_push_records ADD COLUMN IF NOT EXISTS channel VARCHAR(24) NOT NULL DEFAULT 'websocket'");
        await pool.query("UPDATE stock_trace_push_records SET trigger_reason = '' WHERE trigger_reason IS NULL");
        await pool.query("ALTER TABLE stock_trace_push_records ALTER COLUMN trigger_reason SET DEFAULT ''");
        await pool.query('ALTER TABLE stock_trace_push_records ALTER COLUMN trigger_reason SET NOT NULL');
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_trace_push_records_delivery
            ON stock_trace_push_records (event_id, openid, push_kind, trigger_reason)
        `);
        await StockTraceJobService.ensureSchema();
    }

    static async getFavoriteSecurities(): Promise<FavoriteSecurity[]> {
        await this.ensureSchema();
        const result = await pool.query(`
            SELECT DISTINCT us.symbol, COALESCE(s.name, '') AS stock_name,
                   COALESCE(s.market, '') AS market, NULLIF(s.list_date, '') AS list_date
            FROM user_stocks us
            LEFT JOIN stocks s ON s.symbol = us.symbol
            ORDER BY us.symbol
        `);
        return result.rows.map((row: Record<string, string | null>) => ({
            symbol: row.symbol || '',
            stockName: row.stock_name || '',
            market: row.market || '',
            listDate: row.list_date,
        }));
    }

    static async processPriceFact(
        security: FavoriteSecurity,
        fact: PriceFact,
        options: { immediateEnqueue?: boolean } = {},
    ): Promise<PriceMutationResult> {
        await this.ensureSchema();
        if (Math.abs(fact.changePct) < PRICE_TRIGGER_PERCENT) {
            await this.startRecovery(security.symbol, fact.observedAt);
            return { mutation: 'ignored', event: null };
        }

        const direction = directionFor(fact.changePct);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // 反向落定：关闭相反方向的 active 事件，并在同一事务内入队其最终归因 job。
            // 数据已冻结只归因一次；入队幂等由 UNIQUE(event_id, trigger_revision, analysis_version, job_kind) 保证。
            const reversed = await client.query<{ event_id: string; current_trigger_revision: number }>(`
                UPDATE stock_trace_events
                SET event_status = 'closed', updated_at = CURRENT_TIMESTAMP
                WHERE symbol = $1 AND event_status = 'active' AND direction <> $2
                RETURNING event_id, current_trigger_revision
            `, [security.symbol, direction]);
            for (const row of reversed.rows) {
                await this.enqueueFinalAnalysis(row.event_id, Number(row.current_trigger_revision), client);
            }

            const current = await client.query<EventRow>(`
                SELECT event_id, symbol, stock_name, trading_date, direction, first_triggered_at,
                       current_trigger_revision, current_severity, recovery_started_at, window_start_at, window_end_at
                FROM stock_trace_events
                WHERE symbol = $1 AND direction = $2 AND event_status = 'active'
                ORDER BY first_triggered_at DESC
                LIMIT 1
                FOR UPDATE
            `, [security.symbol, direction]);

            if (current.rows.length > 0) {
                const eventRow = current.rows[0];
                const previous = await client.query<RevisionRow>(`
                    SELECT trigger_revision, actual_value, severity
                    FROM stock_trace_event_revisions
                    WHERE event_id = $1 AND trigger_revision = $2
                `, [eventRow.event_id, eventRow.current_trigger_revision]);
                const previousRevision = previous.rows[0];
                const nextSeverity = getSeverity(fact.changePct);
                const needsRevision = previousRevision
                    && isRevisionNeeded(toNumber(previousRevision.actual_value), fact.changePct, previousRevision.severity, nextSeverity);

                await client.query(`
                    UPDATE stock_trace_events
                    SET window_end_at = $2, last_seen_at = $2, recovery_started_at = NULL, updated_at = CURRENT_TIMESTAMP
                    WHERE event_id = $1
                `, [eventRow.event_id, fact.observedAt]);
                eventRow.window_end_at = fact.observedAt;

                if (!needsRevision) {
                    await client.query('COMMIT');
                    return { mutation: 'unchanged', event: null };
                }

                const revision = eventRow.current_trigger_revision + 1;
                await this.insertRevision(client, eventRow.event_id, revision, direction, fact, nextSeverity, 'amplitude_or_severity_upgrade');
                await client.query(`
                    UPDATE stock_trace_events
                    SET current_trigger_revision = $2, current_severity = $3, updated_at = CURRENT_TIMESTAMP
                    WHERE event_id = $1
                `, [eventRow.event_id, revision, nextSeverity]);
                // 不再即时入队归因：盘中 revision 仅采集快照，最终归因留到事件落定后统一触发一次（降 token / 数据更全）
                await client.query('COMMIT');
                void triggerEventScrape(eventRow).catch((error: unknown) => {
                    console.error('[StockTrace] event scrape trigger (revision) failed:', error instanceof Error ? error.message : error);
                });
                const event = buildTriggerEvent(eventRow, {
                    trigger_revision: revision,
                    actual_value: fact.changePct,
                    severity: nextSeverity,
                }, fact);
                const severityRank: Record<TraceSeverity, number> = { medium: 1, high: 2, critical: 3 };
                if (previousRevision && severityRank[nextSeverity] > severityRank[previousRevision.severity]) {
                    void import('./StockTraceAlertOrchestrator').then(({ StockTraceAlertOrchestrator }) =>
                        StockTraceAlertOrchestrator.pushSeverityUpgrade(event),
                    ).catch((error: unknown) => {
                        console.error('[StockTrace] severity upgrade push failed:', error instanceof Error ? error.message : error);
                    });
                }
                this.captureSnapshots(event, 'revised');
                void StockTraceJobService.publishPending().catch((error: unknown) => {
                    console.error('[StockTrace] job outbox publish failed:', error instanceof Error ? error.message : error);
                });
                return {
                    mutation: 'revised',
                    event,
                };
            }

            const tradingDate = formatChinaTradingDate(fact.observedAt);
            const previousClosed = await client.query<{ event_id: string }>(`
                SELECT event_id FROM stock_trace_events
                WHERE symbol = $1 AND event_status = 'closed'
                ORDER BY last_seen_at DESC LIMIT 1
            `, [security.symbol]);
            const eventId = createEventId(security.symbol, tradingDate, fact.observedAt, direction);
            const severity = getSeverity(fact.changePct);
            const eventRow: EventRow = {
                event_id: eventId,
                symbol: security.symbol,
                stock_name: fact.stockName || security.stockName,
                trading_date: tradingDate,
                direction,
                first_triggered_at: fact.observedAt,
                window_start_at: fact.observedAt,
                window_end_at: fact.observedAt,
                current_trigger_revision: 1,
                current_severity: severity,
                recovery_started_at: null,
            };
            await client.query(`
                INSERT INTO stock_trace_events (
                    event_id, symbol, stock_name, trading_date, direction, first_triggered_at,
                    window_start_at, window_end_at, last_seen_at, current_trigger_revision,
                    current_severity, related_event_id
                ) VALUES ($1, $2, $3, $4::date, $5, $6, $6, $6, $6, 1, $7, $8)
            `, [eventId, security.symbol, eventRow.stock_name, tradingDate, direction, fact.observedAt, severity, previousClosed.rows[0]?.event_id || null]);
            await this.insertRevision(client, eventId, 1, direction, fact, severity, 'initial_trigger');
            const recipients = await this.createUserEvents(client, eventId, security.symbol);
            // 盘中立即归因（涨停雷达文章命中等强时效场景）：事务内入队，COMMIT 后由既有 publishPending 发布。
            // 默认 false 保持"事件落定后统一归因"策略（8-21 决策）；enqueue 幂等（UNIQUE event_id+revision+analysis_version+kind）。
            if (options.immediateEnqueue) {
                await StockTraceJobService.enqueue(client, { eventId, triggerRevision: 1 });
            }
            await client.query('COMMIT');
            void triggerEventScrape(eventRow).catch((error: unknown) => {
                console.error('[StockTrace] event scrape trigger (create) failed:', error instanceof Error ? error.message : error);
            });

            const event = buildTriggerEvent(eventRow, {
                trigger_revision: 1,
                actual_value: fact.changePct,
                severity,
            }, fact);
            await this.sendInitialPush(event, recipients);
            this.captureSnapshots(event, 'created');
            void StockTraceJobService.publishPending().catch((error: unknown) => {
                console.error('[StockTrace] job outbox publish failed:', error instanceof Error ? error.message : error);
            });
            return { mutation: 'created', event };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    private static captureSnapshots(event: TriggerEvent, mutation: 'created' | 'revised'): void {
        const incremental = mutation === 'revised';
        const capture = mutation === 'created'
            ? StockTraceSnapshotService.captureInitial(event)
            : StockTraceSnapshotService.captureCorrected(event, incremental);
        void capture.then(() => StockTraceSnapshotService.scheduleEnriched(event, incremental)).catch((error: unknown) => {
            console.error('[StockTrace] snapshot capture failed:', error instanceof Error ? error.message : error);
        });
    }

    private static async insertRevision(
        client: PoolClient,
        eventId: string,
        revision: number,
        direction: TraceDirection,
        fact: PriceFact,
        severity: TraceSeverity,
        reason: string,
    ): Promise<void> {
        await client.query(`
            INSERT INTO stock_trace_event_revisions (
                event_id, trigger_revision, triggered_at, rule_version, trigger_type, threshold_value,
                actual_value, latest_price, previous_close, severity, revision_reason
            ) VALUES ($1, $2, $3, $4, 'price', $5, $6, $7, $8, $9, $10)
        `, [eventId, revision, fact.observedAt, PRICE_RULE_VERSION, PRICE_TRIGGER_PERCENT, fact.changePct,
            fact.latestPrice, fact.previousClose, severity, reason]);
        await client.query(`
            INSERT INTO stock_trace_signals (
                id, event_id, trigger_revision, signal_type, direction, threshold_value,
                actual_value, source, observed_at, raw_fact
            ) VALUES ($1, $2, $3, 'price', $4, $5, $6, 'tencent_quote', $7, $8::jsonb)
        `, [randomUUID(), eventId, revision, direction, PRICE_TRIGGER_PERCENT, fact.changePct, fact.observedAt, JSON.stringify({
            latest_price: fact.latestPrice,
            previous_close: fact.previousClose,
            change_pct: fact.changePct,
        })]);
    }

    private static async createUserEvents(client: PoolClient, eventId: string, symbol: string): Promise<string[]> {
        const recipients = await client.query<{ openid: string }>(`
            SELECT openid FROM user_stocks WHERE symbol = $1
        `, [symbol]);
        for (const recipient of recipients.rows) {
            await client.query(`
                INSERT INTO stock_trace_user_events (id, event_id, openid)
                VALUES ($1, $2, $3)
                ON CONFLICT (event_id, openid) DO NOTHING
            `, [randomUUID(), eventId, recipient.openid]);
        }
        return recipients.rows.map((row) => row.openid);
    }

    private static async sendInitialPush(event: TriggerEvent, recipients: string[]): Promise<void> {
        const payload = this.toPublicEvent(event);
        await Promise.all(recipients.map(async (openid) => {
            await pool.query(`
                INSERT INTO stock_trace_push_records (id, event_id, openid, push_kind, trigger_reason, status, payload, sent_at)
                VALUES ($1, $2, $3, 'initial', 'event_created', 'sent', $4::jsonb, CURRENT_TIMESTAMP)
                ON CONFLICT (event_id, openid, push_kind, trigger_reason) DO NOTHING
            `, [randomUUID(), event.eventId, openid, JSON.stringify(payload)]);
            pushAlertToUser(openid, { type: 'movement.created', ...payload });
            try {
                await NotificationService.createForUser(openid, {
                    category: 'price_movement',
                    sourceKey: `movement:${event.eventId}`,
                    symbol: event.symbol,
                    stockName: event.stockName,
                    title: `${event.stockName}：价格异动`,
                    summary: `${event.direction === 'up' ? '上涨' : '下跌'} ${Number(event.actualValue).toFixed(2)}%`,
                    targetPath: `/modules/favorites/pages/insight-detail-move?event_id=${encodeURIComponent(event.eventId)}`,
                    payload,
                    occurredAt: event.triggeredAt ? new Date(event.triggeredAt).toISOString() : undefined,
                });
            } catch (error) {
                console.warn('[StockTrace] App notification failed:', error instanceof Error ? error.message : String(error));
            }
        }));
    }

    private static async startRecovery(symbol: string, observedAt: Date): Promise<void> {
        await this.ensureSchema();
        await pool.query(`
            UPDATE stock_trace_events
            SET recovery_started_at = COALESCE(recovery_started_at, $2), last_seen_at = $2, updated_at = CURRENT_TIMESTAMP
            WHERE symbol = $1 AND event_status = 'active'
        `, [symbol, observedAt]);
        const settled = await pool.query<{ event_id: string; current_trigger_revision: number }>(`
            UPDATE stock_trace_events
            SET event_status = 'closed', updated_at = CURRENT_TIMESTAMP
            WHERE symbol = $1 AND event_status = 'active'
              AND recovery_started_at IS NOT NULL AND recovery_started_at <= $2
            RETURNING event_id, current_trigger_revision
        `, [symbol, new Date(observedAt.getTime() - PRICE_RESET_WINDOW_MS)]);
        if (settled.rows.length > 0) {
            await this.triggerFinalAttribution(settled.rows);
        }
    }

    /** 事件落定（恢复窗口到期 / 反向落定 / 收盘兜底）后触发一次最终归因。
     * 幂等：enqueue 的 UNIQUE(event_id, trigger_revision, analysis_version, job_kind) + SELECT FOR UPDATE
     * 保证同一事件只入队一个最终归因 job。无 client 时自建短事务保证 job+outbox 原子落库。 */
    private static async enqueueFinalAnalysis(eventId: string, triggerRevision: number, client?: PoolClient): Promise<void> {
        await this.ensureSchema();
        if (client) {
            await StockTraceJobService.enqueue(client, { eventId, triggerRevision });
            return;
        }
        // 无 client 路径：入队前确保 enriched 快照就绪（缺失则同步采集一次兜底），
        // 避免 job 发布后 consumer 反复拿 SNAPSHOT_NOT_READY 空转。事务外执行。
        await this.ensureEnrichedReady(eventId, triggerRevision);
        const conn = await pool.connect();
        try {
            await conn.query('BEGIN');
            await StockTraceJobService.enqueue(conn, { eventId, triggerRevision });
            await conn.query('COMMIT');
        } catch (error) {
            await conn.query('ROLLBACK');
            throw error;
        } finally {
            conn.release();
        }
    }

    private static async ensureEnrichedReady(eventId: string, triggerRevision: number): Promise<void> {
        const context = await StockTraceSnapshotService.getAnalysisContext(eventId, triggerRevision);
        if (context) return;
        const event = await this.getTriggerEvent(eventId, triggerRevision);
        if (!event) return; // 事件不存在：交由 consumer 超时兜底
        await StockTraceSnapshotService.captureEnriched(event);
    }

    /** 对一批已落定事件统一触发最终归因：入队后发布 outbox。 */
    private static async triggerFinalAttribution(
        rows: Array<{ event_id: string; current_trigger_revision: number }>,
    ): Promise<void> {
        for (const row of rows) {
            await this.enqueueFinalAnalysis(row.event_id, Number(row.current_trigger_revision));
        }
        await StockTraceJobService.publishPending().catch((error: unknown) => {
            console.error('[StockTrace] final attribution outbox publish failed:', error instanceof Error ? error.message : error);
        });
    }

    /** 收盘兜底（15:05 cron 调用）：强制落定当日所有 active 事件并触发最终归因。返回落定事件数。 */
    static async settleActiveEvents(): Promise<number> {
        await this.ensureSchema();
        const tradingDate = formatChinaTradingDate(new Date());
        const settled = await pool.query<{ event_id: string; current_trigger_revision: number }>(`
            UPDATE stock_trace_events
            SET event_status = 'closed',
                recovery_started_at = COALESCE(recovery_started_at, CURRENT_TIMESTAMP),
                updated_at = CURRENT_TIMESTAMP
            WHERE event_status = 'active' AND trading_date = $1::date
            RETURNING event_id, current_trigger_revision
        `, [tradingDate]);
        if (settled.rows.length > 0) {
            await this.triggerFinalAttribution(settled.rows);
        }
        return settled.rows.length;
    }

    static toPublicEvent(event: TriggerEvent): Record<string, unknown> {
        return {
            event_id: event.eventId,
            trigger_revision: event.triggerRevision,
            symbol: event.symbol,
            stock_name: event.stockName,
            event_type: 'price',
            direction: event.direction,
            triggered_at: event.triggeredAt.toISOString(),
            window_start_at: event.windowStartAt.toISOString(),
            window_end_at: event.windowEndAt.toISOString(),
            latest_price: event.latestPrice,
            previous_close: event.previousClose,
            change_pct: event.actualValue,
            threshold_pct: event.thresholdValue,
            severity: event.severity,
            rule_version: event.ruleVersion,
            analysis_status: 'pending',
        };
    }

    static async listUserEvents(id: string, openid: string, limit: number, cursor?: string): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
        await this.ensureSchema();
        // 自选股归属双通道：user_id 优先（统一账户主键），openid 兜底老微信数据（user_id 空的历史行）
        const scopeWhere = '(us.user_id = $1 OR (us.user_id IS NULL AND us.openid = $2))';
        // 参数顺序：$1=id, $2=openid, $3=LIMIT(=limit+1), $4=cursor
        const params: unknown[] = [id, openid, limit + 1];
        const cursorClause = cursor ? `AND e.first_triggered_at < $4::timestamptz` : '';
        if (cursor) params.push(cursor);
        const result = await pool.query(`
            SELECT e.event_id, e.symbol, e.stock_name, e.direction, e.first_triggered_at, e.current_trigger_revision,
                   e.current_severity, ue.read_at, r.latest_price, r.previous_close, r.actual_value AS change_pct,
                   r.threshold_value, r.rule_version,
                   CASE
                     WHEN a.event_id IS NOT NULL THEN 'completed'
                     WHEN rr.result_id IS NOT NULL AND (rr.validation_status = 'rejected' OR rr.processing_status = 'failed') THEN 'unavailable'
                     ELSE 'processing'
                   END AS analysis_status,
                   (SELECT r3.primary_phrase FROM stock_trace_results r3 WHERE r3.result_id = a.result_id LIMIT 1) AS primary_cause
            -- 列表可见性实时跟随当前自选（INNER JOIN user_stocks）：
            -- 移出自选立即消失、之后加入自选可见历史事件，与 insights 一致。
            -- stock_trace_user_events 仅作已读状态落点（LEFT JOIN 取 read_at）与推送对象。
            FROM stock_trace_events e
            INNER JOIN user_stocks us ON us.symbol = e.symbol AND ${scopeWhere}
            LEFT JOIN stock_trace_user_events ue ON ue.event_id = e.event_id AND ue.openid = $2
            INNER JOIN stock_trace_event_revisions r ON r.event_id = e.event_id
                AND r.trigger_revision = e.current_trigger_revision
            LEFT JOIN LATERAL (
                SELECT a.event_id, a.result_id
                FROM stock_trace_artifacts a
                WHERE a.event_id = e.event_id
                  AND a.is_effective = TRUE AND a.expires_at > CURRENT_TIMESTAMP
                ORDER BY a.artifact_version DESC
                LIMIT 1
            ) a ON TRUE
            LEFT JOIN LATERAL (
                SELECT r2.result_id, r2.validation_status, r2.processing_status, r2.primary_phrase
                FROM stock_trace_results r2
                INNER JOIN stock_trace_snapshots s2 ON s2.snapshot_id = r2.snapshot_id
                WHERE r2.event_id = e.event_id AND s2.trigger_revision = e.current_trigger_revision
                ORDER BY r2.created_at DESC
                LIMIT 1
            ) rr ON TRUE
            WHERE ${scopeWhere} ${cursorClause}
            ORDER BY e.first_triggered_at DESC
            LIMIT $3
        `, params);
        const rows = result.rows.slice(0, limit);
        return {
            items: rows.map((row: Record<string, unknown>) => ({
                event_id: row.event_id,
                trigger_revision: row.current_trigger_revision,
                symbol: row.symbol,
                stock_name: row.stock_name,
                event_type: 'price',
                direction: row.direction,
                triggered_at: (row.first_triggered_at as Date).toISOString(),
                latest_price: toNumber(row.latest_price as string | number),
                previous_close: toNumber(row.previous_close as string | number),
                change_pct: toNumber(row.change_pct as string | number),
                threshold_pct: toNumber(row.threshold_value as string | number),
                severity: row.current_severity,
                rule_version: row.rule_version,
                read_at: row.read_at,
                // 与详情接口 presentStockTraceAnalysis 保持一致：artifact→completed / rejected|failed→unavailable / 其他→processing
                analysis_status: String(row.analysis_status ?? 'processing'),
                // 简短主因短语（LLM 生成），供列表/卡片展示；无归因结果时为 null
                primary_cause: row.primary_cause ? String(row.primary_cause) : null,
            })),
            nextCursor: result.rows.length > limit ? (rows[rows.length - 1]?.first_triggered_at as Date).toISOString() : null,
        };
    }

    /**
     * 未登录降级：返回最近的全局异动事件（不按 openid 过滤）。
     * 用于 monitor 页面在用户未登录时也能看到系统真实数据，符合"登录非必需"项目约束。
     * read_at 始终为 null（未登录无法记录已读状态）。
     */
    static async listRecentEvents(limit: number, cursor?: string): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
        await this.ensureSchema();
        const params: unknown[] = [limit + 1];
        const cursorClause = cursor ? `AND e.first_triggered_at < $2::timestamptz` : '';
        if (cursor) params.push(cursor);
        const result = await pool.query(`
            SELECT e.event_id, e.symbol, e.stock_name, e.direction, e.first_triggered_at, e.current_trigger_revision,
                   e.current_severity, r.latest_price, r.previous_close, r.actual_value AS change_pct,
                   r.threshold_value, r.rule_version,
                   CASE
                     WHEN a.event_id IS NOT NULL THEN 'completed'
                     WHEN rr.result_id IS NOT NULL AND (rr.validation_status = 'rejected' OR rr.processing_status = 'failed') THEN 'unavailable'
                     ELSE 'processing'
                   END AS analysis_status,
                   (SELECT r3.primary_phrase FROM stock_trace_results r3 WHERE r3.result_id = a.result_id LIMIT 1) AS primary_cause
            FROM stock_trace_events e
            INNER JOIN stock_trace_event_revisions r ON r.event_id = e.event_id
                AND r.trigger_revision = e.current_trigger_revision
            LEFT JOIN LATERAL (
                SELECT a.event_id, a.result_id
                FROM stock_trace_artifacts a
                WHERE a.event_id = e.event_id
                  AND a.is_effective = TRUE AND a.expires_at > CURRENT_TIMESTAMP
                ORDER BY a.artifact_version DESC
                LIMIT 1
            ) a ON TRUE
            LEFT JOIN LATERAL (
                SELECT r2.result_id, r2.validation_status, r2.processing_status, r2.primary_phrase
                FROM stock_trace_results r2
                INNER JOIN stock_trace_snapshots s2 ON s2.snapshot_id = r2.snapshot_id
                WHERE r2.event_id = e.event_id AND s2.trigger_revision = e.current_trigger_revision
                ORDER BY r2.created_at DESC
                LIMIT 1
            ) rr ON TRUE
            WHERE e.event_status = 'active' ${cursorClause}
            ORDER BY e.first_triggered_at DESC
            LIMIT $1
        `, params);
        const rows = result.rows.slice(0, limit);
        return {
            items: rows.map((row: Record<string, unknown>) => ({
                event_id: row.event_id,
                trigger_revision: row.current_trigger_revision,
                symbol: row.symbol,
                stock_name: row.stock_name,
                event_type: 'price',
                direction: row.direction,
                triggered_at: (row.first_triggered_at as Date).toISOString(),
                latest_price: toNumber(row.latest_price as string | number),
                previous_close: toNumber(row.previous_close as string | number),
                change_pct: toNumber(row.change_pct as string | number),
                threshold_pct: toNumber(row.threshold_value as string | number),
                severity: row.current_severity,
                rule_version: row.rule_version,
                read_at: null,
                // 与详情接口 presentStockTraceAnalysis 保持一致：artifact→completed / rejected|failed→unavailable / 其他→processing
                analysis_status: String(row.analysis_status ?? 'processing'),
                // 简短主因短语（LLM 生成），供列表/卡片展示；无归因结果时为 null
                primary_cause: row.primary_cause ? String(row.primary_cause) : null,
            })),
            nextCursor: result.rows.length > limit ? (rows[rows.length - 1]?.first_triggered_at as Date).toISOString() : null,
        };
    }

    static async getUserEvent(id: string, openid: string, eventId: string): Promise<Record<string, unknown> | null> {
        await this.ensureSchema();
        // 自选股归属双通道：user_id 优先（统一账户主键），openid 兜底老微信数据（user_id 空的历史行）
        const scopeWhere = '(us.user_id = $1 OR (us.user_id IS NULL AND us.openid = $2))';
        const result = await pool.query(`
            SELECT e.event_id, e.symbol, e.stock_name, e.direction, e.first_triggered_at, e.window_start_at,
                   e.window_end_at, e.current_trigger_revision, e.current_severity, ue.read_at,
                   r.triggered_at, r.latest_price, r.previous_close, r.actual_value AS change_pct,
                   r.threshold_value, r.rule_version, r.data_quality
            -- 详情归属同样实时跟随当前自选（INNER JOIN user_stocks）：
            -- 用户当前自选里没有该股票即 404，避免列表可见但详情不可见的不一致。
            FROM stock_trace_events e
            INNER JOIN user_stocks us ON us.symbol = e.symbol AND ${scopeWhere}
            LEFT JOIN stock_trace_user_events ue ON ue.event_id = e.event_id AND ue.openid = $2
            INNER JOIN stock_trace_event_revisions r ON r.event_id = e.event_id
                AND r.trigger_revision = e.current_trigger_revision
            WHERE e.event_id = $3
            LIMIT 1
        `, [id, openid, eventId]);
        if (!result.rows[0]) return null;
        const row = result.rows[0] as Record<string, unknown>;
        return {
            event_id: row.event_id,
            trigger_revision: row.current_trigger_revision,
            symbol: row.symbol,
            stock_name: row.stock_name,
            event_type: 'price',
            direction: row.direction,
            triggered_at: row.triggered_at,
            first_triggered_at: row.first_triggered_at,
            window_start_at: row.window_start_at,
            window_end_at: row.window_end_at,
            latest_price: toNumber(row.latest_price as string | number),
            previous_close: toNumber(row.previous_close as string | number),
            change_pct: toNumber(row.change_pct as string | number),
            threshold_pct: toNumber(row.threshold_value as string | number),
            severity: row.current_severity,
            rule_version: row.rule_version,
            read_at: row.read_at,
            analysis_status: 'pending',
            fact_status: 'frozen',
        };
    }

    static async getRecentEvent(eventId: string): Promise<Record<string, unknown> | null> {
        // 未登录降级：不经过 stock_trace_user_events 关联表，直接查全局事件。
        // 返回格式与 getUserEvent 一致，read_at 固定为 null（未登录无法标记已读）。
        await this.ensureSchema();
        const result = await pool.query(`
            SELECT e.event_id, e.symbol, e.stock_name, e.direction, e.first_triggered_at, e.window_start_at,
                   e.window_end_at, e.current_trigger_revision, e.current_severity,
                   r.triggered_at, r.latest_price, r.previous_close, r.actual_value AS change_pct,
                   r.threshold_value, r.rule_version, r.data_quality
            FROM stock_trace_events e
            INNER JOIN stock_trace_event_revisions r ON r.event_id = e.event_id
                AND r.trigger_revision = e.current_trigger_revision
            WHERE e.event_id = $1 AND e.event_status = 'active'
            LIMIT 1
        `, [eventId]);
        if (!result.rows[0]) return null;
        const row = result.rows[0] as Record<string, unknown>;
        return {
            event_id: row.event_id,
            trigger_revision: row.current_trigger_revision,
            symbol: row.symbol,
            stock_name: row.stock_name,
            event_type: 'price',
            direction: row.direction,
            triggered_at: row.triggered_at,
            first_triggered_at: row.first_triggered_at,
            window_start_at: row.window_start_at,
            window_end_at: row.window_end_at,
            latest_price: toNumber(row.latest_price as string | number),
            previous_close: toNumber(row.previous_close as string | number),
            change_pct: toNumber(row.change_pct as string | number),
            threshold_pct: toNumber(row.threshold_value as string | number),
            severity: row.current_severity,
            rule_version: row.rule_version,
            read_at: null,
            analysis_status: 'pending',
            fact_status: 'frozen',
        };
    }

    static async getInternalEvent(eventId: string): Promise<Record<string, unknown> | null> {
        await this.ensureSchema();
        const eventResult = await pool.query(`
            SELECT event_id, symbol, stock_name, trading_date, direction, first_triggered_at,
                   window_start_at, window_end_at, last_seen_at, recovery_started_at, event_status,
                   current_trigger_revision, current_severity, related_event_id, created_at, updated_at
            FROM stock_trace_events WHERE event_id = $1 LIMIT 1
        `, [eventId]);
        if (!eventResult.rows[0]) return null;
        const revisions = await pool.query(`
            SELECT trigger_revision, triggered_at, rule_version, trigger_type, threshold_value,
                   actual_value, latest_price, previous_close, severity, revision_reason, data_quality
            FROM stock_trace_event_revisions WHERE event_id = $1 ORDER BY trigger_revision
        `, [eventId]);
        const signals = await pool.query(`
            SELECT id, trigger_revision, signal_type, direction, threshold_value, actual_value,
                   source, observed_at, raw_fact
            FROM stock_trace_signals WHERE event_id = $1 ORDER BY observed_at
        `, [eventId]);
        return { event: eventResult.rows[0], revisions: revisions.rows, signals: signals.rows };
    }

    static async getTriggerEvent(eventId: string, triggerRevision?: number): Promise<TriggerEvent | null> {
        await this.ensureSchema();
        const result = await pool.query(`
            SELECT e.event_id, e.symbol, e.stock_name, e.trading_date, e.direction, e.window_start_at, e.window_end_at,
                   r.trigger_revision, r.triggered_at, r.latest_price, r.previous_close,
                   r.actual_value, r.threshold_value, r.severity, r.rule_version
            FROM stock_trace_events e
            INNER JOIN stock_trace_event_revisions r ON r.event_id = e.event_id
            WHERE e.event_id = $1 AND r.trigger_revision = COALESCE($2, e.current_trigger_revision)
            LIMIT 1
        `, [eventId, triggerRevision || null]);
        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
            eventId: String(row.event_id), triggerRevision: Number(row.trigger_revision), symbol: String(row.symbol),
            stockName: String(row.stock_name), tradingDate: String(row.trading_date).slice(0, 10),
            direction: row.direction as TraceDirection, triggeredAt: row.triggered_at as Date,
            windowStartAt: row.window_start_at as Date, windowEndAt: row.window_end_at as Date,
            latestPrice: toNumber(row.latest_price as string | number), previousClose: toNumber(row.previous_close as string | number),
            actualValue: toNumber(row.actual_value as string | number), thresholdValue: toNumber(row.threshold_value as string | number),
            severity: row.severity as TraceSeverity, ruleVersion: String(row.rule_version),
        };
    }

    static async markRead(openid: string, eventId: string): Promise<boolean> {
        await this.ensureSchema();
        // upsert：列表可见性已改由 user_stocks 实时决定，用户可能"之后加入自选"而
        // 关联表里没有既有行，此时也要能标记已读（不再依赖 createUserEvents 预建行）。
        const result = await pool.query(`
            INSERT INTO stock_trace_user_events (id, event_id, openid, read_at)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            ON CONFLICT (event_id, openid) DO UPDATE SET read_at = CURRENT_TIMESTAMP
            RETURNING id
        `, [randomUUID(), eventId, openid]);
        return (result.rowCount || 0) > 0;
    }
}
