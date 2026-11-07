import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../../core/db';
import { PostgresSelectionStore } from '../SelectionStore';
import { Batch } from '../types';

test('持久化任务：整批发布、会话锁释放、同日幂等、失败后记录状态', async () => {
    let locked = true, ready = false, released = 0;
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
        query: async (sql: string, values?: unknown[]) => {
            statements.push({ sql, values });
            if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
            if (sql.includes("status='ready' LIMIT")) return { rows: ready ? [{ id: '17' }] : [] };
            if (sql.includes('INSERT INTO stock_selection_runs')) return { rows: [{ id: '18' }] };
            return { rows: [] };
        },
        release: () => { released++; },
    };
    const query = mock.method(pool, 'query', (async () => ({ rows: [] })) as unknown as typeof pool.query);
    const connect = mock.method(pool, 'connect', (async () => client) as unknown as typeof pool.connect);
    try {
        const store = new PostgresSelectionStore();
        let builds = 0;
        const build = async () => { builds++; return { stocks: [] } as unknown as Batch; };
        assert.deepEqual(await store.run('2026-11-04', build), { status: 'ready', runId: '18' });
        assert.ok(statements.some(s => s.sql.includes("batch=$2::jsonb,status='ready'")));
        assert.ok(statements.at(-1)!.sql.includes('pg_advisory_unlock'));
        ready = true;
        assert.equal((await store.run('2026-11-04', build)).runId, '17');
        assert.equal(builds, 1);
        locked = false;
        assert.equal((await store.run('2026-11-04', build)).status, 'generating');
        assert.equal(builds, 1);
        locked = true; ready = false;
        await assert.rejects(store.run('2026-11-04', async () => { throw new Error('missing data'); }), /missing data/);
        assert.ok(statements.some(s => s.sql.includes("status='failed'") && s.values?.[1] === 'missing data'));
        assert.ok(statements.at(-1)!.sql.includes('pg_advisory_unlock'));
        assert.equal(released, 4);
    } finally { query.mock.restore(); connect.mock.restore(); }
});
