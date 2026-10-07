/**
 * StockTrace 列表 analysis_status 派生逻辑测试
 *
 * 覆盖：listUserEvents / listRecentEvents 返回的 analysis_status 与详情接口
 * presentStockTraceAnalysis 保持一致（artifact→completed / rejected|failed→unavailable / 其他→processing），
 * 缺失时回退 processing。
 *
 * Mock 策略：mock pool.query（core/db 默认导出），主查询按 SQL 文本区分，
 * ensureSchema 的 DDL 返回空 rows。仓库惯例：node:test + .spec.ts + __tests__。
 * 运行：`node --import tsx --test src/modules/stock-trace/__tests__/listAnalysisStatus.spec.ts`
 *
 * 护栏分层（2026-10-07 评审收紧）：
 * - dead_letter→failed 派生是纯 SQL 层行为，mock 绕过了 SQL，因此行为用例只验证
 *   service 对"后端派生后的 analysis_status"的透传；真正的派生护栏在下方 SQL 断言语义测试，
 *   它同时锁定：job LATERAL JOIN 确实加入（放锚点收紧到 SELECT j.status FROM stock_trace_jobs j）、
 *   `WHEN j.status = 'dead_letter' THEN 'failed'` 分支确实存在、且其位置在 unavailable 分支之后。
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../../core/db';
import { StockTraceService } from '../StockTraceService';

afterEach(() => {
    mock.restoreAll();
});

/** 构造主查询行（与 listUserEvents SELECT 列一致）。analysis_status 即"后端派生后的值"，
 *  此函数只表达透传，不表达派生逻辑（派生在 SQL 层，见下方 SQL 断言语义测试）。 */
function row(analysisStatus?: string): Record<string, unknown> {
    return {
        event_id: 'mv:601318:2026-08-19:1:up',
        current_trigger_revision: 1,
        symbol: '601318',
        stock_name: '中国平安',
        direction: 'up',
        first_triggered_at: new Date('2026-08-19T07:26:22.789Z'),
        // SELECT 列同步（2026-09-24 列表透出最近窗口结束时间）
        window_end_at: new Date('2026-08-19T07:26:22.789Z'),
        current_severity: 'high',
        read_at: null,
        latest_price: '100',
        previous_close: '100',
        change_pct: '8.5',
        threshold_value: '7',
        rule_version: 'price-v1',
        ...(analysisStatus === undefined ? {} : { analysis_status: analysisStatus }),
    };
}

function mockMainQuery(rows: Record<string, unknown>[]): void {
    mock.method(pool, 'query', (async (text: string, _params?: unknown[]) => {
        // listUserEvents 主查询含 JOIN user_stocks（实时跟随自选）；listRecentEvents 不含，先匹配前者
        if (String(text).includes('JOIN user_stocks')) return { rows };
        if (String(text).includes('FROM stock_trace_events e')) return { rows };
        return { rows: [] };
    }) as unknown as typeof pool.query);
}

describe('StockTraceService.listUserEvents analysis_status', () => {
    it('有 artifact 时派生 completed', async () => {
        mockMainQuery([row('completed')]);
        const page = await StockTraceService.listUserEvents('user-id-1', 'openid-1', 5);
        assert.equal(page.items[0]?.analysis_status, 'completed');
    });

    it('最新 result 被拒或失败时派生 unavailable', async () => {
        mockMainQuery([row('unavailable')]);
        const page = await StockTraceService.listUserEvents('user-id-1', 'openid-1', 5);
        assert.equal(page.items[0]?.analysis_status, 'unavailable');
    });

    it('无 artifact/result 时派生 processing', async () => {
        mockMainQuery([row('processing')]);
        const page = await StockTraceService.listUserEvents('user-id-1', 'openid-1', 5);
        assert.equal(page.items[0]?.analysis_status, 'processing');
    });

    it('service 透传后端派生的 failed（mock 绕过 SQL，派生真护栏在 SQL 断言）', async () => {
        mockMainQuery([row('failed')]);
        const page = await StockTraceService.listUserEvents('user-id-1', 'openid-1', 5);
        assert.equal(page.items[0]?.analysis_status, 'failed');
    });

    it('listUserEvents SQL 含 dead_letter→failed 分支、job LATERAL JOIN，且分支位于 unavailable 之后', async () => {
        let sql = '';
        mock.method(pool, 'query', (async (text: string) => {
            if (String(text).includes('JOIN user_stocks')) sql = String(text);
            return { rows: [] };
        }) as unknown as typeof pool.query);
        await StockTraceService.listUserEvents('user-id-1', 'openid-1', 5);
        assert.match(sql, /SELECT j\.status FROM stock_trace_jobs j/, '应 SELECT j.status 取最新 job 状态');
        // 收紧到只有一个 LATERAL 选 j.status（原有两个 LATERAL 分别选 a.event_id,a.result_id 与 r2.result_id，不误命中）
        assert.match(
            sql,
            /LEFT JOIN LATERAL \(\s*SELECT j\.status FROM stock_trace_jobs j/,
            '应通过 LEFT JOIN LATERAL 加入 job 状态拉取',
        );
        // 优先级：unavailable 分支（result 失败）必须在 dead_letter→failed 之前，锁 unavailable > failed
        const unavailableIdx = sql.indexOf('WHEN rr.result_id');
        const failIdx = sql.indexOf("WHEN j.status = 'dead_letter' THEN 'failed'");
        assert.ok(unavailableIdx !== -1, '应存在 result 失败→unavailable 分支');
        assert.ok(failIdx !== -1, '应存在 dead_letter→failed 分支');
        assert.ok(
            unavailableIdx < failIdx,
            'unavailable 分支应在 dead_letter→failed 之前（result 失败优先于 job 死信，unavailable > failed）',
        );
    });

    it('analysis_status 缺失时回退 processing', async () => {
        mockMainQuery([row()]);
        const page = await StockTraceService.listUserEvents('user-id-1', 'openid-1', 5);
        assert.equal(page.items[0]?.analysis_status, 'processing');
    });

    it('SQL 用统一账户双通道过滤自选股（user_id 优先 + openid 兜底老微信数据）', async () => {
        let captured: { text: string; params: unknown[] } | null = null;
        mock.method(pool, 'query', (async (text: string, params?: unknown[]) => {
            if (String(text).includes('JOIN user_stocks')) {
                captured = { text: String(text), params: params ?? [] };
                return { rows: [] };
            }
            return { rows: [] };
        }) as unknown as typeof pool.query);

        await StockTraceService.listUserEvents('email-user-id', '', 5);

        assert.ok(captured, 'listUserEvents 应发起主查询');
        const sql = captured as { text: string; params: unknown[] };
        assert.match(
            sql.text,
            /INNER JOIN user_stocks us ON us\.symbol = e\.symbol AND \(us\.user_id = \$1 OR \(us\.user_id IS NULL AND us\.openid = \$2\)\)/,
            'JOIN 条件应 user_id 优先、openid 兜底',
        );
        assert.match(
            sql.text,
            /AND e\.first_triggered_at >= us\.created_at/,
            'JOIN 应限定持仓期内触发（2026-09-04：新加入股只显示加入后触发的事件）',
        );
        assert.equal(sql.params[0], 'email-user-id', '第一个参数应为统一账户 id（邮箱用户）');
        assert.equal(sql.params[1], '', '第二个参数应为 openid（邮箱用户为空串）');
        assert.equal(sql.params[2], 6, '第三个参数应为 limit+1');
    });
});

describe('StockTraceService.listRecentEvents analysis_status', () => {
    it('有 artifact 时派生 completed', async () => {
        mockMainQuery([row('completed')]);
        const page = await StockTraceService.listRecentEvents(5);
        assert.equal(page.items[0]?.analysis_status, 'completed');
    });

    it('无 artifact/result 时派生 processing', async () => {
        mockMainQuery([row('processing')]);
        const page = await StockTraceService.listRecentEvents(5);
        assert.equal(page.items[0]?.analysis_status, 'processing');
    });

    it('service 透传后端派生的 failed（mock 绕过 SQL，派生真护栏在 SQL 断言）', async () => {
        mockMainQuery([row('failed')]);
        const page = await StockTraceService.listRecentEvents(5);
        assert.equal(page.items[0]?.analysis_status, 'failed');
    });

    it('listRecentEvents SQL 含 dead_letter→failed 分支、job LATERAL JOIN，且分支位于 unavailable 之后', async () => {
        let sql = '';
        mock.method(pool, 'query', (async (text: string) => {
            if (String(text).includes('FROM stock_trace_events e')) sql = String(text);
            return { rows: [] };
        }) as unknown as typeof pool.query);
        await StockTraceService.listRecentEvents(5);
        assert.match(sql, /SELECT j\.status FROM stock_trace_jobs j/, '应 SELECT j.status 取最新 job 状态');
        // 收紧到只有一个 LATERAL 选 j.status（原有两个 LATERAL 分别选 a.event_id,a.result_id 与 r2.result_id，不误命中）
        assert.match(
            sql,
            /LEFT JOIN LATERAL \(\s*SELECT j\.status FROM stock_trace_jobs j/,
            '应通过 LEFT JOIN LATERAL 加入 job 状态拉取',
        );
        // 优先级：unavailable 分支（result 失败）必须在 dead_letter→failed 之前，锁 unavailable > failed
        const unavailableIdx = sql.indexOf('WHEN rr.result_id');
        const failIdx = sql.indexOf("WHEN j.status = 'dead_letter' THEN 'failed'");
        assert.ok(unavailableIdx !== -1, '应存在 result 失败→unavailable 分支');
        assert.ok(failIdx !== -1, '应存在 dead_letter→failed 分支');
        assert.ok(
            unavailableIdx < failIdx,
            'unavailable 分支应在 dead_letter→failed 之前（result 失败优先于 job 死信，unavailable > failed）',
        );
    });
});
