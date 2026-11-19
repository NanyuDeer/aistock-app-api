import type { PoolClient } from 'pg';

/** A checked-out pg client has no pool error listener. Keep one until release, including external I/O waits. */
export class SelectionSession {
    private failure: Error | null = null;
    private released = false;
    private readonly onError = (error: Error) => {
        this.failure ??= error;
        console.error('[SelectionSession] connection lost:', error.message);
    };
    constructor(private client: PoolClient) { client.on('error', this.onError); }
    assertUsable() {
        if (this.failure) throw new Error(`选股会话连接已失效，禁止发布: ${this.failure.message}`);
    }
    async release(lockKey?: number) {
        if (this.released) return;
        this.released = true;
        let destroy = Boolean(this.failure);
        try {
            if (!destroy && lockKey !== undefined) await this.client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        } catch (error) {
            destroy = true;
            console.error('[SelectionSession] unlock failed:', error instanceof Error ? error.message : String(error));
        } finally {
            // pg-pool installs its idle listener during release. Never put a failed/possibly locked session back.
            this.client.release(destroy || Boolean(this.failure));
            this.client.removeListener('error', this.onError);
        }
    }
}
