/**
 * StockTrace `since`（YYYY-MM-DD 时间下界，opt-in）测试
 *
 * 背景（2026-10-07 计划 Task 1）：洞察/异动列表只显示最近 14 个自然日（上海日期）。
 * 前端算出 since = 今天 - 13 天（YYYY-MM-DD）传参；**后端只做纯日期比较**
 * `AND e.trading_date >= $N::date`，不承担"两周"业务口径。
 *
 * 关键护栏：
 * - 不传 since 时 SQL 逐字不含该谓词。
 * - 非法 since（2026-9-3 / abc / '' / 2026-13-45）被忽略，不影响其它参数与 SQL 形状。
 * - **参数序号（唯一高风险点）**：since 与 cursor 都是动态追加，SQL 子句顺序必须与
 *   params.push 顺序严格一致。三者（since + cursor + visibleOnly）同时传时锁定占位符一一对应。
 * - internalRouter 路径第 5 实参 options 仍为 undefined（既有 internalRouter-events.spec 覆盖）。
 *
 * Mock 策略：mock pool.query，主查询按 SQL 文本区分。
 * 运行：`node --import tsx --test --test-force-exit src/modules/stock-trace/__tests__/sinceWindow.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../../core/db';
import { StockTraceService } from '../StockTraceService';

afterEach(() => {
    mock.restoreAll();
});

/** 捕获主查询 SQL 文本；listUserEvents 主查询含 JOIN user_stocks，listRecentEvents 含 FROM stock_trace_events e */
async function captureSql(
    run: () => Promise<unknown>,
    kind: 'userEvents' | 'recentEvents',
): Promise<{ text: string; params: unknown[] | null }> {
    let captured: { text: string; params: unknown[] | null } | null = null;
    mock.method(pool, 'query', (async (text: string, params?: unknown[]) => {
        const sql = String(text);
        const isUserEvents = sql.includes('JOIN user_stocks');
        const isRecentEvents = sql.includes('FROM stock_trace_events e') && !sql.includes('JOIN user_stocks');
        if (kind === 'userEvents' && isUserEvents) captured = { text: sql, params: params ?? null };
        if (kind === 'recentEvents' && isRecentEvents) captured = { text: sql, params: params ?? null };
        return { rows: [] };
    }) as unknown as typeof pool.query);
    await run();
    assert.ok(captured, `${kind} 应发起主查询`);
    return captured as { text: string; params: unknown[] | null };
}

const SINCE_RE = /AND e\.trading_date >= \$\d+::date/;

describe('listUserEvents `since` SQL', () => {
    it('传 since 时含 `e.trading_date >= $N::date`，无 cursor 时 since 占 $4', async () => {
        const { text, params } = await captureSql(
            () => StockTraceService.listUserEvents('u1', 'o1', 5, undefined, { since: '2026-09-23' }),
            'userEvents',
        );
        assert.match(text, /AND e\.trading_date >= \$4::date/, 'since 谓词应为 e.trading_date >= $4::date（无 cursor）');
        // params: [id, openid, limit+1, since] → since 下标 3 → $4
        assert.equal(params?.[3], '2026-09-23', '第 4 参应为 since');
    });

    it('不传 since 时 SQL 完全不含该谓词', async () => {
        const { text } = await captureSql(
            () => StockTraceService.listUserEvents('u1', 'o1', 5),
            'userEvents',
        );
        assert.ok(!SINCE_RE.test(text), '未传 since 时不得含 e.trading_date >= 谓词');
        assert.ok(!text.includes('trading_date >='), '未传 since 时不得出现 trading_date >= 文本');
    });
});

describe('listRecentEvents `since` SQL', () => {
    it('传 since 时含 `e.trading_date >= $N::date`，无 cursor 时 since 占 $2', async () => {
        const { text, params } = await captureSql(
            () => StockTraceService.listRecentEvents(5, undefined, { since: '2026-09-23' }),
            'recentEvents',
        );
        assert.match(text, /AND e\.trading_date >= \$2::date/, 'since 谓词应为 e.trading_date >= $2::date（无 cursor）');
        // params: [limit+1, since] → since 下标 1 → $2
        assert.equal(params?.[1], '2026-09-23', '第 2 参应为 since');
    });

    it('不传 since 时 SQL 完全不含该谓词', async () => {
        const { text } = await captureSql(
            () => StockTraceService.listRecentEvents(5),
            'recentEvents',
        );
        assert.ok(!SINCE_RE.test(text), '未传 since 时不得含 e.trading_date >= 谓词');
        assert.ok(!text.includes('trading_date >='), '未传 since 时不得出现 trading_date >= 文本');
    });
});

describe('since + cursor + visibleOnly 三者同时传（参数序号严格正确）', () => {
    it('listUserEvents：params 与 SQL $n 一一对应（cursor $4/$5，since $6 紧随其后）', async () => {
        const cursor = '2026-08-19T07:26:22.789Z|mv:601318:2026-08-19:1:up';
        const { text, params } = await captureSql(
            () => StockTraceService.listUserEvents('u1', 'o1', 5, cursor, { visibleOnly: true, since: '2026-09-23' }),
            'userEvents',
        );
        // LIMIT $3 → cursor 行值比较 $4/$5 → since $6 → visible 谓词零占位符
        assert.match(text, /AND \(e\.first_triggered_at, e\.event_id\) < \(\$4::timestamptz, \$5\)/, 'cursor 应占 $4/$5');
        assert.match(text, /AND e\.trading_date >= \$6::date/, 'since 应紧随 cursor 之后占 $6');
        assert.match(text, /NOT \(\s*a\.event_id IS NULL/, 'visibleOnly 谓词①应在（零占位符）');
        assert.match(text, /IS DISTINCT FROM 'low'/, 'visibleOnly 谓词②应在');
        // params: [id, openid, limit+1, ts, eid, since]
        assert.equal(params?.[3], '2026-08-19T07:26:22.789Z', '下标3=cursorTs');
        assert.equal(params?.[4], 'mv:601318:2026-08-19:1:up', '下标4=cursorEid');
        assert.equal(params?.[5], '2026-09-23', '下标5=since');
    });

    it('listRecentEvents：params 与 SQL $n 一一对应（cursor $2/$3，since $4 紧随其后）', async () => {
        const cursor = '2026-08-19T07:26:22.789Z|mv:601318:2026-08-19:1:up';
        const { text, params } = await captureSql(
            () => StockTraceService.listRecentEvents(5, cursor, { visibleOnly: true, since: '2026-09-23' }),
            'recentEvents',
        );
        // LIMIT $1 → cursor $2/$3 → since $4 → visible 谓词零占位符
        assert.match(text, /AND \(e\.first_triggered_at, e\.event_id\) < \(\$2::timestamptz, \$3\)/, 'cursor 应占 $2/$3');
        assert.match(text, /AND e\.trading_date >= \$4::date/, 'since 应紧随 cursor 之后占 $4');
        assert.match(text, /NOT \(\s*a\.event_id IS NULL/, 'visibleOnly 谓词①应在');
        assert.match(text, /IS DISTINCT FROM 'low'/, 'visibleOnly 谓词②应在');
        // params: [limit+1, ts, eid, since]
        assert.equal(params?.[1], '2026-08-19T07:26:22.789Z', '下标1=cursorTs');
        assert.equal(params?.[2], 'mv:601318:2026-08-19:1:up', '下标2=cursorEid');
        assert.equal(params?.[3], '2026-09-23', '下标3=since');
    });
});

describe('非法 since 被忽略', () => {
    const badSinces = ['2026-9-3', 'abc', '', '2026-13-45'];

    for (const bad of badSinces) {
        it(`listUserEvents 忽略 since="${bad}"（不加谓词、不影响场景/参数形状）`, async () => {
            const cursor = '2026-08-19T07:26:22.789Z|mv:601318:2026-08-19:1:up';
            const { text, params } = await captureSql(
                () => StockTraceService.listUserEvents('u1', 'o1', 5, cursor, { visibleOnly: true, since: bad }),
                'userEvents',
            );
            assert.ok(!SINCE_RE.test(text), `since="${bad}" 非法应被忽略，不含谓词`);
            // 其余场景不受影响：cursor $4/$5 保持、visible 谓词在、params 无 since
            assert.match(text, /AND \(e\.first_triggered_at, e\.event_id\) < \(\$4::timestamptz, \$5\)/, '非法 since 不改变 cursor $4/$5');
            assert.match(text, /NOT \(\s*a\.event_id IS NULL/, '非法 since 不影响 visibleOnly 谓词①');
            assert.match(text, /IS DISTINCT FROM 'low'/, '非法 since 不影响 visibleOnly 谓词②');
            assert.equal(params?.length, 5, 'params 应只有 [id, openid, limit+1, ts, eid]，无 since');
            assert.equal(params?.[5], undefined, '下标5应为 undefined（非法 since 未 push）');
        });

        it(`listRecentEvents 忽略 since="${bad}"（不加谓词、不影响场景/参数形状）`, async () => {
            const cursor = '2026-08-19T07:26:22.789Z|mv:601318:2026-08-19:1:up';
            const { text, params } = await captureSql(
                () => StockTraceService.listRecentEvents(5, cursor, { visibleOnly: true, since: bad }),
                'recentEvents',
            );
            assert.ok(!SINCE_RE.test(text), `since="${bad}" 非法应被忽略，不含谓词`);
            assert.match(text, /AND \(e\.first_triggered_at, e\.event_id\) < \(\$2::timestamptz, \$3\)/, '非法 since 不改变 cursor $2/$3');
            assert.match(text, /NOT \(\s*a\.event_id IS NULL/, '非法 since 不影响 visibleOnly 谓词①');
            assert.match(text, /IS DISTINCT FROM 'low'/, '非法 since 不影响 visibleOnly 谓词②');
            assert.equal(params?.length, 3, 'params 应只有 [limit+1, ts, eid]，无 since');
            assert.equal(params?.[3], undefined, '下标3应为 undefined（非法 since 未 push）');
        });
    }
});