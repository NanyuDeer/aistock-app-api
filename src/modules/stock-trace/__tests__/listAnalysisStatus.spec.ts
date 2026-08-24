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
        const page = await StockTraceService.listUserEvents('openid-1', 5);
        assert.equal(page.items[0]?.analysis_status, 'completed');
    });

    it('最新 result 被拒或失败时派生 unavailable', async () => {
        mockMainQuery([row('unavailable')]);
        const page = await StockTraceService.listUserEvents('openid-1', 5);
        assert.equal(page.items[0]?.analysis_status, 'unavailable');
    });

    it('无 artifact/result 时派生 processing', async () => {
        mockMainQuery([row('processing')]);
        const page = await StockTraceService.listUserEvents('openid-1', 5);
        assert.equal(page.items[0]?.analysis_status, 'processing');
    });

    it('analysis_status 缺失时回退 processing', async () => {
        mockMainQuery([row()]);
        const page = await StockTraceService.listUserEvents('openid-1', 5);
        assert.equal(page.items[0]?.analysis_status, 'processing');
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
