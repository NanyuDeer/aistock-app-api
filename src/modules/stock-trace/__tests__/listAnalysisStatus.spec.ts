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
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../../core/db';
import { StockTraceService } from '../StockTraceService';

afterEach(() => {
    mock.restoreAll();
});

/** 构造主查询行（与 listUserEvents SELECT 列一致） */
function row(analysisStatus?: string): Record<string, unknown> {
    return {
        event_id: 'mv:601318:2026-08-19:1:up',
        current_trigger_revision: 1,
        symbol: '601318',
        stock_name: '中国平安',
        direction: 'up',
        first_triggered_at: new Date('2026-08-19T07:26:22.789Z'),
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
            /WHERE \(us\.user_id = \$1 OR \(us\.user_id IS NULL AND us\.openid = \$2\)\)/,
            'WHERE 应同样双通道过滤',
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
});
