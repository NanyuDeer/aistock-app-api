/**
 * RotationBoardStore.replaceRotationRows：按交易日覆盖写入（先删后插，单事务）
 *
 * 背景：板块池随时间变化，而历史用「当前池」全量重算；只 upsert 会残留旧池板块行，
 * 使同一交易日出现两套涨/跌榜 → 下游「上榜次数」被放大。故改为先按交易日删除再插入。
 *
 * 运行：node --import tsx --test src/modules/monitor/__tests__/rotationBoardStore.spec.ts
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import pool from '../../../core/db';
import { replaceRotationRows, type DailyRotationRow } from '../RotationBoardStore';

function makeRows(): DailyRotationRow[] {
    return [
        { trading_date: '2026-10-09', board_code: '881274', board_name: '影视院线', up_rank: 1, down_rank: null, pct_change: 7.23 },
        { trading_date: '2026-10-09', board_code: '885001', board_name: '某概念', up_rank: null, down_rank: 1, pct_change: -5 },
        { trading_date: '2026-10-08', board_code: '881274', board_name: '影视院线', up_rank: 1, down_rank: null, pct_change: 3 },
    ];
}

interface RecordedCall { sql: string; values?: unknown[] }

function fakeClient(calls: RecordedCall[], failOnInsert = false): { client: unknown; released: () => number } {
    let releasedCount = 0;
    const client = {
        query: async (sql: string, values?: unknown[]) => {
            calls.push({ sql, values });
            if (failOnInsert && sql.includes('INSERT INTO board_rotation_daily')) {
                throw new Error('insert boom');
            }
            return { rows: [] };
        },
        release: () => { releasedCount++; },
    };
    return { client, released: () => releasedCount };
}

afterEach(() => {
    mock.restoreAll();
});

describe('replaceRotationRows：按交易日覆盖写入', () => {
    it('事务内先按交易日删除旧行（日期去重），再插入新行，最后 COMMIT', async () => {
        const calls: RecordedCall[] = [];
        const { client, released } = fakeClient(calls);
        mock.method(pool, 'connect', (async () => client) as unknown as typeof pool.connect);

        await replaceRotationRows(makeRows());

        assert.equal(calls[0].sql, 'BEGIN', '应先开启事务');
        const del = calls.find((c) => c.sql.includes('DELETE FROM board_rotation_daily'));
        assert.ok(del, '应发出 DELETE 清理旧行');
        assert.ok(del!.sql.includes('ANY($1::date[])'), 'DELETE 应按交易日数组删除');
        assert.deepEqual(del!.values?.[0], ['2026-10-09', '2026-10-08'], 'DELETE 日期应去重');
        const ins = calls.find((c) => c.sql.includes('INSERT INTO board_rotation_daily'));
        assert.ok(ins, '应发出 INSERT 写入新行');
        assert.equal(calls[calls.length - 1].sql, 'COMMIT', '应以 COMMIT 收尾');
        assert.equal(released(), 1, 'client 应被释放');
    });

    it('插入失败 → ROLLBACK 并向上抛错', async () => {
        const calls: RecordedCall[] = [];
        const { client, released } = fakeClient(calls, true);
        mock.method(pool, 'connect', (async () => client) as unknown as typeof pool.connect);

        await assert.rejects(() => replaceRotationRows(makeRows()), /insert boom/);
        assert.equal(calls[calls.length - 1].sql, 'ROLLBACK', '失败应回滚');
        assert.equal(released(), 1, 'client 应被释放');
    });

    it('空 rows → 不触达数据库', async () => {
        let connected = false;
        mock.method(pool, 'connect', (async () => { connected = true; return fakeClient([]).client; }) as unknown as typeof pool.connect);

        await replaceRotationRows([]);

        assert.equal(connected, false, '空数据不应建立连接');
    });
});
