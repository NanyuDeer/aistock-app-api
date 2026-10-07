/**
 * StockTrace visible_only（SQL 过滤前置）+ cursor tiebreaker 测试
 *
 * 背景（2026-10-07 计划 Task 1）：后端先 LIMIT、前端再过滤（隐藏 unavailable / 低置信 low），
 * 被丢掉的行走白白占窗口。本次把两条机器枚举规则 opt-in 下沉到 SQL：
 *   ① 排除"不可归因"：无 artifact 且最新 result rejected/failed（**必须带 a.event_id IS NULL 守卫**）
 *   ② 排除低置信：confidence_level 为 low（**必须 IS DISTINCT FROM 'low'**，放行 NULL）
 * 并对 cursor 加 tiebreaker（复合键 "ts|event_id" + 行值比较），修复同毫秒跨页漏行。
 *
 * 关键护栏：**不传 options（agent-py 读层 internalRouter）时 SQL 逐字不含这两个谓词**，
 * 保证 agent 读层语义与改动前完全一致；internalRouter.ts 一字不改。
 *
 * Mock 策略：mock pool.query（core/db 默认导出），主查询按 SQL 文本区分。
 * 运行：`node --import tsx --test src/modules/stock-trace/__tests__/visibleOnly.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../../core/db';
import { StockTraceService } from '../StockTraceService';

afterEach(() => {
    mock.restoreAll();
});

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        event_id: 'mv:601318:2026-08-19:1:up',
        current_trigger_revision: 1,
        symbol: '601318',
        stock_name: '中国平安',
        direction: 'up',
        first_triggered_at: new Date('2026-08-19T07:26:22.789Z'),
        window_end_at: new Date('2026-08-19T07:26:22.789Z'),
        current_severity: 'high',
        read_at: null,
        latest_price: '100',
        previous_close: '100',
        change_pct: '8.5',
        threshold_value: '7',
        rule_version: 'price-v1',
        analysis_status: 'processing',
        is_limit_up: false,
        ...over,
    };
}

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

const VO_PRED_P1 = 'a.event_id IS NULL';

describe('listUserEvents visible_only SQL', () => {
    it('visibleOnly:true 时含两条谓词（含守卫 + IS DISTINCT FROM）', async () => {
        const { text } = await captureSql(
            () => StockTraceService.listUserEvents('u1', 'o1', 5, undefined, { visibleOnly: true }),
            'userEvents',
        );
        // 谓词①：NOT (a.event_id IS NULL ... ) —— 守卫必须在 NOT 之后紧跟
        assert.match(text, /NOT \(\s*a\.event_id IS NULL/, '谓词①必须以 a.event_id IS NULL 守卫开头');
        assert.match(text, /rr\.result_id IS NOT NULL/, '谓词①应含 rr.result_id IS NOT NULL');
        assert.match(text, /rr\.validation_status = 'rejected' OR rr\.processing_status = 'failed'/, '谓词①应列出 result 被拒/失败');
        // 谓词②：IS DISTINCT FROM 'low'（放行 NULL）
        assert.match(text, /IS DISTINCT FROM 'low'/, '谓词②必须用 IS DISTINCT FROM 放行 NULL 置信度');
        assert.ok(!text.includes("<> 'low'"), '不得使用 <>\'low\'（NULL 会被误判为被排除）');
    });

    it('不传 options 时 SQL 完全不含两条谓词（保护 agent-py 读层）', async () => {
        const { text } = await captureSql(
            () => StockTraceService.listUserEvents('u1', 'o1', 5),
            'userEvents',
        );
        assert.ok(!text.includes(VO_PRED_P1), '未开 visibleOnly 时不得出现 a.event_id IS NULL 谓词');
        assert.ok(!text.includes('IS DISTINCT FROM'), '未开 visibleOnly 时不得出现低置信谓词');
        // 回归：still WHERE true 窗口（未添加额外 AND 谓词）
        assert.match(text, /WHERE true\s*$/m, '未开 visibleOnly 时 WHERE true 之后不应追加谓词');
    });

    it('等价性回归（关键）：SQL 含 a.event_id IS NULL 守卫，绝不排除"有 artifact 但 result 被拒"的行', async () => {
        const { text } = await captureSql(
            () => StockTraceService.listUserEvents('u1', 'o1', 5, undefined, { visibleOnly: true }),
            'userEvents',
        );
        // 若删除守卫（写成 NOT (rr.result_id IS NOT NULL AND ...)，则 a.event_id IS NULL 守卫消失，
        // "有有效 artifact（重新归因场景）但当前修订最新 result 被拒"的行会被提前排除 → 静默丢卡。
        // 断言守卫紧跟 NOT ( 的语义；删掉守卫后此正则不命中从而变红。
        assert.match(text, /NOT \(\s*a\.event_id IS NULL/, '守卫必须在 NOT ( 之后，防止漏排除带有效 artifact 的行');
        assert.ok(!/NOT \(\s*rr\.result_id IS NOT NULL/.test(text), '谓词①不得缺少 a.event_id IS NULL 守卫开头');
    });
});

describe('listRecentEvents visible_only SQL', () => {
    it('visibleOnly:true 时含两条谓词', async () => {
        const { text } = await captureSql(
            () => StockTraceService.listRecentEvents(5, undefined, { visibleOnly: true }),
            'recentEvents',
        );
        assert.match(text, /NOT \(\s*a\.event_id IS NULL/, '谓词①守卫');
        assert.match(text, /IS DISTINCT FROM 'low'/, '谓词②必须 IS DISTINCT FROM');
    });

    it('不传 options 时 SQL 完全不含两条谓词', async () => {
        const { text } = await captureSql(
            () => StockTraceService.listRecentEvents(5),
            'recentEvents',
        );
        assert.ok(!text.includes(VO_PRED_P1), '未开 visibleOnly 时不得出现谓词①');
        assert.ok(!text.includes('IS DISTINCT FROM'), '未开 visibleOnly 时不得出现谓词②');
        assert.match(text, /WHERE e\.event_status = 'active'\s*$/m, '未开 visibleOnly 时 WHERE active 后无追加');
    });

    it('不因 analysis_status/failed (job dead_letter) 排除：谓词①只针对 result，不新增 job 条件', async () => {
        const { text } = await captureSql(
            () => StockTraceService.listRecentEvents(5, undefined, { visibleOnly: true }),
            'recentEvents',
        );
        // 谓词①不引用 stock_trace_jobs / j. 前缀（dead_letter 行前端刻意保持可见）
        assert.ok(!/AND NOT \([\s\S]*j\.status/.test(text), '可见性谓词不得包含 job 状态条件');
    });
});

describe('visibleOnly + cursor tiebreaker', () => {
    it('listUserEvents nextCursor 为 "<ISO>|<event_id>" 复合键（超页时）', async () => {
        mock.method(pool, 'query', (async (text: string) => {
            // 两条行，limit=1 → result.rows.length(2) > 1 → nextCursor 有值
            if (String(text).includes('JOIN user_stocks')) {
                return { rows: [row(), row({ event_id: 'mv:601318:2026-08-18:1:up', first_triggered_at: new Date('2026-08-18T07:00:00.000Z') })] };
            }
            return { rows: [] };
        }) as unknown as typeof pool.query);
        const page = await StockTraceService.listUserEvents('u1', 'o1', 1);
        const nc = page.nextCursor ?? '';
        const [tsPart, eidPart] = nc.split('|');
        assert.match(tsPart, /^[0-9TZ:.\-]+$/, 'nextCursor 首段应为 ISO 时间戳');
        assert.equal(eidPart, 'mv:601318:2026-08-19:1:up', 'nextCursor 尾段应为 event_id');
        assert.match(nc, /^[^|]+\|[^|]+$/, 'nextCursor 应为 "<ts ISO>|<event_id>" 复合键');
    });

    it('有 cursor 时 listUserEvents 下页 SQL 用行值比较且 ORDER BY 含 e.event_id DESC', async () => {
        const cursor = '2026-08-19T07:26:22.789Z|mv:601318:2026-08-19:1:up';
        const { text, params } = await captureSql(
            () => StockTraceService.listUserEvents('u1', 'o1', 5, cursor),
            'userEvents',
        );
        assert.match(text, /AND \(e\.first_triggered_at, e\.event_id\) < \(\$4::timestamptz, \$5\)/, '下页应行值比较 (first_triggered_at, event_id) < ($ts, $eid)');
        assert.match(text, /ORDER BY e\.first_triggered_at DESC, e\.event_id DESC/, 'ORDER BY 应含 e.event_id DESC tiebreaker');
        // params: [id, openid, limit+1, ts, eid]
        assert.equal(params?.[3], '2026-08-19T07:26:22.789Z', '第 4 参应为 cursorTs');
        assert.equal(params?.[4], 'mv:601318:2026-08-19:1:up', '第 5 参应为 cursorEid');
    });

    it('有 cursor 时 listRecentEvents 下页 SQL 用行值比较且 ORDER BY 含 e.event_id DESC', async () => {
        const cursor = '2026-08-19T07:26:22.789Z|mv:601318:2026-08-19:1:up';
        const { text, params } = await captureSql(
            () => StockTraceService.listRecentEvents(5, cursor),
            'recentEvents',
        );
        assert.match(text, /AND \(e\.first_triggered_at, e\.event_id\) < \(\$2::timestamptz, \$3\)/, 'listRecentEvents 下页行值比较 ($2, $3)');
        assert.match(text, /ORDER BY e\.first_triggered_at DESC, e\.event_id DESC/, 'listRecentEvents ORDER BY 应含 e.event_id DESC');
        assert.equal(params?.[1], '2026-08-19T07:26:22.789Z', '第 2 参应为 cursorTs');
        assert.equal(params?.[2], 'mv:601318:2026-08-19:1:up', '第 3 参应为 cursorEid');
    });

    it('listUserEvents nextCursor 为 null（未超页 rows.length <= limit）—— 前端 hasMore 契约', async () => {
        mock.method(pool, 'query', (async (text: string) => {
            // 3 行，limit=5 → rows.length(3) <= 5 → 未超页，nextCursor 必须为 null
            if (String(text).includes('JOIN user_stocks')) {
                return { rows: [row(), row(), row()] };
            }
            return { rows: [] };
        }) as unknown as typeof pool.query);
        const page = await StockTraceService.listUserEvents('u1', 'o1', 5);
        assert.equal(page.nextCursor, null, 'rows.length <= limit 时 nextCursor 必须为 null（hasMore=false）');
    });

    it('listRecentEvents nextCursor 为 null（未超页 rows.length <= limit）', async () => {
        mock.method(pool, 'query', (async (text: string) => {
            if (String(text).includes('FROM stock_trace_events e')) {
                return { rows: [row(), row()] };
            }
            return { rows: [] };
        }) as unknown as typeof pool.query);
        const page = await StockTraceService.listRecentEvents(5);
        assert.equal(page.nextCursor, null, 'rows.length <= limit 时 nextCursor 必须为 null');
    });

    it('cursor + visibleOnly 同时传（listUserEvents）：谓词零占位符、双谓词、序号仍 $4/$5', async () => {
        const cursor = '2026-08-19T07:26:22.789Z|mv:601318:2026-08-19:1:up';
        const { text, params } = await captureSql(
            () => StockTraceService.listUserEvents('u1', 'o1', 5, cursor, { visibleOnly: true }),
            'userEvents',
        );
        // 下页游标行值比较占位符仍紧随 LIMIT 之后（$4::timestamptz, $5）——可见性谓词零占位符、未打乱序号
        assert.match(text, /AND \(e\.first_triggered_at, e\.event_id\) < \(\$4::timestamptz, \$5\)/, 'cursor 谓词序号仍为 $4/$5（谓词零占位符）');
        // 可见性两条谓词同时存在
        assert.match(text, /NOT \(\s*a\.event_id IS NULL/, '同时传 visibleOnly 时可见性谓词①必须存在');
        assert.match(text, /IS DISTINCT FROM 'low'/, '同时传 visibleOnly 时可见性谓词②必须存在');
        // params 尾部即 cursorTs/cursorEid，无谓词占位符插入导致错位
        assert.equal(params?.[3], '2026-08-19T07:26:22.789Z', '第 4 参应为 cursorTs');
        assert.equal(params?.[4], 'mv:601318:2026-08-19:1:up', '第 5 参应为 cursorEid');
    });

    it('cursor + visibleOnly 同时传（listRecentEvents）：谓词零占位符、双谓词、序号仍 $2/$3', async () => {
        const cursor = '2026-08-19T07:26:22.789Z|mv:601318:2026-08-19:1:up';
        const { text, params } = await captureSql(
            () => StockTraceService.listRecentEvents(5, cursor, { visibleOnly: true }),
            'recentEvents',
        );
        assert.match(text, /AND \(e\.first_triggered_at, e\.event_id\) < \(\$2::timestamptz, \$3\)/, 'cursor 谓词序号仍为 $2/$3（谓词零占位符）');
        assert.match(text, /NOT \(\s*a\.event_id IS NULL/, '同时传 visibleOnly 时可见性谓词①必须存在');
        assert.match(text, /IS DISTINCT FROM 'low'/, '同时传 visibleOnly 时可见性谓词②必须存在');
        assert.equal(params?.[1], '2026-08-19T07:26:22.789Z', '第 2 参应为 cursorTs');
        assert.equal(params?.[2], 'mv:601318:2026-08-19:1:up', '第 3 参应为 cursorEid');
    });
});
