import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { HotBurstService } from '../HotBurstService';
import pool from '../../../core/db';
import { TencentQuoteService } from '../../quote/TencentQuoteService';

test('重现pg无时区读取偏移；显式UTC的timestamptz解析在不同进程时区一致', () => {
    const script = `const pg = require('pg'); console.log(JSON.stringify({
        legacy: pg.types.getTypeParser(1114)('2026-11-20 06:30:00.623').toISOString(),
        utc: pg.types.getTypeParser(1184)('2026-11-20 06:30:00.623+00').toISOString()
    }));`;
    const parse = (tz: string) => JSON.parse(execFileSync(process.execPath, ['-e', script], {
        cwd: process.cwd(), env: { ...process.env, TZ: tz }, encoding: 'utf8',
    })) as { legacy: string; utc: string };
    const sh = parse('Asia/Shanghai');
    const utc = parse('UTC');
    const ny = parse('America/New_York');
    assert.equal(sh.legacy, '2026-11-19T22:30:00.623Z');
    assert.notEqual(sh.legacy, utc.legacy);
    for (const result of [sh, utc, ny]) assert.equal(result.utc, '2026-11-20T06:30:00.623Z');
});

test('历史写入显式存UTC；各查询分支显式还原UTC并按UTC窗口比较', async t => {
    t.after(() => mock.restoreAll());
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    mock.method(pool, 'query', async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [] };
    });
    mock.method(TencentQuoteService, 'getCachedBatchQuotes', async () => []);
    const signal = { symbol: '000001', resonanceCount: 2, triggerTags: [] };
    await HotBurstService.saveHistory({
        update_time: '2026-11-20T06:30:00.623Z', outbreaks: [signal],
    } as unknown as Parameters<typeof HotBurstService.saveHistory>[0]);
    assert.match(queries[0].sql, /\$1::timestamptz AT TIME ZONE 'UTC'/);
    assert.equal(queries[0].params[0], '2026-11-20T06:30:00.623Z');
    queries.length = 0;
    await HotBurstService.getHistory(50, 0, true, 3, 2);
    await HotBurstService.getHistory(50, 0, true, 3);
    await HotBurstService.getHistory(50, 0, false, 3);
    await HotBurstService.getLatestFromDB(5);
    const fallback = HotBurstService as unknown as { fallbackFromDB: (h: number, n: number) => Promise<unknown> };
    await fallback.fallbackFromDB(6, 2);
    const selects = queries.filter(q => q.sql.includes('SELECT ') && !q.sql.includes('COUNT('));
    assert.equal(selects.length, 5);
    for (const q of selects) assert.match(q.sql, /\(detected_at AT TIME ZONE 'UTC'\) AS detected_at/);
    for (const q of queries.filter(q => q.sql.includes('detected_at >='))) {
        assert.match(q.sql, /NOW\(\) AT TIME ZONE 'UTC'/);
    }
});
