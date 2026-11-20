import { EventEmitter } from 'node:events';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { SelectionSession } from '../SelectionSession';
import { PostgresSelectionStore } from '../SelectionStore';
import pool from '../../../core/db';
import { Batch } from '../types';

test('借出连接在外部I/O期间断线：消费error事件、禁止发布、销毁且仅释放一次', async () => {
    const client = Object.assign(new EventEmitter(), { query: mock.fn(async () => ({ rows: [] })), release: mock.fn() });
    const session = new SelectionSession(client as unknown as PoolClient);
    assert.doesNotThrow(() => client.emit('error', new Error('simulated socket loss')));
    assert.throws(() => session.assertUsable(), /连接已失效.*simulated socket loss/);
    await session.release(73140922); await session.release(73140922);
    assert.equal(client.query.mock.callCount(), 0);
    assert.equal(client.release.mock.callCount(), 1);
    assert.deepEqual(client.release.mock.calls[0].arguments, [true]);
    assert.equal(client.listenerCount('error'), 0);
});

test('解锁失败销毁连接；正常解锁保留池连接，并移除自身监听', async () => {
    for (const failUnlock of [false, true]) {
        const client = Object.assign(new EventEmitter(), { query: mock.fn(async () => {
            if (failUnlock) throw new Error('unlock failed');
            return { rows: [] };
        }), release: mock.fn() });
        const other = () => {};
        client.on('error', other);
        const session = new SelectionSession(client as unknown as PoolClient);
        await session.release(73140921);
        assert.deepEqual(client.release.mock.calls[0].arguments, [failUnlock]);
        assert.equal(client.listenerCount('error'), 1);
        client.removeListener('error', other);
    }
});

test('规则生成期间连接断线：不发布ready，用独立连接尽力记录failed，并销毁持锁连接', async () => {
    const statements: string[] = [];
    const client = Object.assign(new EventEmitter(), {
        query: async (sql: string) => {
            statements.push(sql);
            if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
            if (sql.includes('INSERT INTO stock_selection_runs')) return { rows: [{ id: 'broken-1' }] };
            return { rows: [] };
        }, release: mock.fn(),
    });
    const failures: string[] = [];
    const query = mock.method(pool, 'query', (async (sql: string) => { failures.push(sql); return { rows: [] }; }) as never);
    const connect = mock.method(pool, 'connect', (async () => client) as never);
    try {
        await assert.rejects(new PostgresSelectionStore().run('2026-11-20', async () => {
            client.emit('error', new Error('connection reset during build'));
            return { stocks: [] } as unknown as Batch;
        }), /连接已失效/);
        assert.ok(!statements.some(sql => sql.includes("status='ready',generated_at")));
        assert.ok(failures.some(sql => sql.includes("status='failed'") && sql.includes("status='generating'")));
        assert.deepEqual(client.release.mock.calls[0].arguments, [true]);
    } finally { query.mock.restore(); connect.mock.restore(); }
});
