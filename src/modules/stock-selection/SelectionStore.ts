import pool from '../../core/db';
import { Batch, MarketDay, RULE_VERSION } from './types';

export interface Run {
    id: string; tradeDate: string; status: 'generating' | 'ready' | 'failed';
    generatedAt: string | null; dataAsOf: string; batch: Batch | null;
}
export interface SelectionStore {
    ensureSchema(): Promise<void>;
    snapshot(date: string): Promise<MarketDay | null>;
    saveSnapshot(day: MarketDay): Promise<void>;
    latest(date?: string): Promise<Run | null>;
    run(date: string, build: () => Promise<Batch>): Promise<{ status: string; runId?: string }>;
}

export class PostgresSelectionStore implements SelectionStore {
    private schema: Promise<void> | null = null;
    ensureSchema(): Promise<void> {
        if (!this.schema) this.schema = pool.query(`
            CREATE TABLE IF NOT EXISTS stock_selection_market_days (
                trade_date DATE PRIMARY KEY, payload JSONB NOT NULL, fetched_at TIMESTAMPTZ NOT NULL
            );
            CREATE TABLE IF NOT EXISTS stock_selection_runs (
                id BIGSERIAL PRIMARY KEY, trade_date DATE NOT NULL, rule_version TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('generating','ready','failed')),
                started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), generated_at TIMESTAMPTZ,
                data_as_of TIMESTAMPTZ NOT NULL, batch JSONB, error_message TEXT
            );
            CREATE INDEX IF NOT EXISTS stock_selection_runs_date ON stock_selection_runs(trade_date DESC, id DESC);
        `).then(() => undefined).catch(e => { this.schema = null; throw e; });
        return this.schema;
    }
    async snapshot(date: string): Promise<MarketDay | null> {
        const r = await pool.query('SELECT payload FROM stock_selection_market_days WHERE trade_date=$1::date', [date]);
        return r.rows[0]?.payload || null;
    }
    async saveSnapshot(day: MarketDay): Promise<void> {
        await pool.query(`INSERT INTO stock_selection_market_days(trade_date,payload,fetched_at) VALUES($1::date,$2::jsonb,$3::timestamptz)
            ON CONFLICT(trade_date) DO NOTHING`, [day.date, JSON.stringify(day), day.fetchedAt]);
    }
    async latest(date?: string): Promise<Run | null> {
        const r = await pool.query(`SELECT id::text, trade_date::text, status, generated_at::text, data_as_of::text, batch, started_at
            FROM stock_selection_runs WHERE rule_version=$1 ${date ? 'AND trade_date=$2::date' : ''}
            ORDER BY trade_date DESC, id DESC LIMIT 1`, date ? [RULE_VERSION, date] : [RULE_VERSION]);
        const row = r.rows[0];
        if (!row) return null;
        // A process crash must not leave the UI generating forever. Never expose an older batch silently.
        const abandoned = row.status === 'generating' && Date.now() - new Date(row.started_at).getTime() > 2 * 3600_000;
        return { id: row.id, tradeDate: row.trade_date, status: abandoned ? 'failed' : row.status,
            generatedAt: row.generated_at, dataAsOf: row.data_as_of, batch: row.status === 'ready' ? row.batch : null };
    }
    async run(date: string, build: () => Promise<Batch>): Promise<{ status: string; runId?: string }> {
        await this.ensureSchema();
        const client = await pool.connect();
        let locked = false, runId: string | undefined;
        try {
            const lock = await client.query('SELECT pg_try_advisory_lock(73140921) AS locked');
            locked = lock.rows[0].locked;
            if (!locked) return { status: 'generating' };
            const existing = await client.query(`SELECT id::text FROM stock_selection_runs WHERE trade_date=$1::date AND rule_version=$2 AND status='ready' LIMIT 1`, [date, RULE_VERSION]);
            if (existing.rows.length) return { status: 'ready', runId: existing.rows[0].id };
            const r = await client.query(`INSERT INTO stock_selection_runs(trade_date,rule_version,status,data_as_of)
                VALUES($1::date,$2,'generating',$3::timestamptz) RETURNING id::text`, [date, RULE_VERSION, `${date}T15:00:00+08:00`]);
            runId = r.rows[0].id;
            const batch = await build();
            // A single UPDATE publishes the complete four-method batch atomically.
            await client.query(`UPDATE stock_selection_runs SET batch=$2::jsonb,status='ready',generated_at=NOW() WHERE id=$1`, [runId, JSON.stringify(batch)]);
            return { status: 'ready', runId };
        } catch (error) {
            if (runId) await client.query(`UPDATE stock_selection_runs SET status='failed',error_message=$2 WHERE id=$1`, [runId, error instanceof Error ? error.message : String(error)]);
            throw error;
        } finally {
            try { if (locked) await client.query('SELECT pg_advisory_unlock(73140921)'); }
            finally { client.release(); }
        }
    }
}
