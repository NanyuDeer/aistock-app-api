/**
 * stock-trace 事件载荷字段测试
 *
 * 覆盖两处字段缺口（2026-09-24 修复）：
 * ① 列表接口 listUserEvents / listRecentEvents 透出 `window_end_at`——
 *    前端卡片按 `window_end_at || triggered_at` 取"最近异动时间"，缺该字段时恒退化为首次触发时刻。
 * ② `toPublicEvent`（WS 新建推送 / internal 触发响应）透出 `is_limit_up`，
 *    且 `analysis_status` 与列表派生口径一致（无 artifact/result 时为 processing，不再是硬编码 pending）。
 *
 * Mock 策略：mock pool.query（core/db 默认导出），主查询按 SQL 文本区分，
 * ensureSchema 的 DDL 返回空 rows。仓库惯例：node:test + .spec.ts + __tests__。
 * 运行：`node --import tsx --test src/modules/stock-trace/__tests__/eventPayloadFields.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../../core/db';
import { StockTraceService } from '../StockTraceService';
import { PRICE_RULE_VERSION, type TriggerEvent } from '../types';

afterEach(() => {
    mock.restoreAll();
});

const WINDOW_END_AT = new Date('2026-08-19T09:10:00.000Z');
const FIRST_TRIGGERED_AT = new Date('2026-08-19T07:26:22.789Z');

/** 构造主查询行（与列表 SELECT 列一致） */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        event_id: 'mv:601318:2026-08-19:1:up',
        current_trigger_revision: 1,
        symbol: '601318',
        stock_name: '中国平安',
        direction: 'up',
        first_triggered_at: FIRST_TRIGGERED_AT,
        window_end_at: WINDOW_END_AT,
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

function mockMainQuery(rows: Record<string, unknown>[]): void {
    mock.method(pool, 'query', (async (text: string) => {
        if (String(text).includes('JOIN user_stocks')) return { rows };
        if (String(text).includes('FROM stock_trace_events e')) return { rows };
        return { rows: [] };
    }) as unknown as typeof pool.query);
}

/** 捕获主查询 SQL 文本 */
async function captureMainSql(run: () => Promise<unknown>): Promise<string> {
    let captured = '';
    mock.method(pool, 'query', (async (text: string) => {
        const sql = String(text);
        if (sql.includes('JOIN user_stocks') || sql.includes('FROM stock_trace_events e')) captured = sql;
        return { rows: [] };
    }) as unknown as typeof pool.query);
    await run();
    return captured;
}

describe('列表接口透出 window_end_at（最近异动时间）', () => {
    it('listUserEvents 返回 window_end_at（ISO 字符串）', async () => {
        mockMainQuery([row()]);
        const page = await StockTraceService.listUserEvents('user-id-1', 'openid-1', 5);
        assert.equal(page.items[0]?.window_end_at, WINDOW_END_AT.toISOString());
    });

    it('listUserEvents 的 SELECT 含 e.window_end_at', async () => {
        const sql = await captureMainSql(() => StockTraceService.listUserEvents('user-id-1', 'openid-1', 5));
        assert.match(sql, /e\.window_end_at/, 'listUserEvents 应 SELECT e.window_end_at');
    });

    it('listRecentEvents 返回 window_end_at（ISO 字符串）', async () => {
        mockMainQuery([row()]);
        const page = await StockTraceService.listRecentEvents(5);
        assert.equal(page.items[0]?.window_end_at, WINDOW_END_AT.toISOString());
    });

    it('listRecentEvents 的 SELECT 含 e.window_end_at', async () => {
        const sql = await captureMainSql(() => StockTraceService.listRecentEvents(5));
        assert.match(sql, /e\.window_end_at/, 'listRecentEvents 应 SELECT e.window_end_at');
    });
});

describe('toPublicEvent 字段完整性（WS 新建推送 / internal 触发响应）', () => {
    function event(over: Partial<TriggerEvent> = {}): TriggerEvent {
        return {
            eventId: 'mv:601318:2026-08-19:1:up',
            triggerRevision: 1,
            symbol: '601318',
            stockName: '中国平安',
            tradingDate: '2026-08-19',
            direction: 'up',
            triggeredAt: FIRST_TRIGGERED_AT,
            windowStartAt: FIRST_TRIGGERED_AT,
            windowEndAt: WINDOW_END_AT,
            latestPrice: 100,
            previousClose: 92.16,
            actualValue: 8.5,
            thresholdValue: 7,
            severity: 'high',
            ruleVersion: PRICE_RULE_VERSION,
            ...over,
        };
    }

    it('透出 is_limit_up（涨停文章命中为 true）', () => {
        assert.equal(StockTraceService.toPublicEvent(event({ isLimitUp: true })).is_limit_up, true);
    });

    it('is_limit_up 缺省为 false（行情打点不猜板阈值）', () => {
        assert.equal(StockTraceService.toPublicEvent(event()).is_limit_up, false);
    });

    it('analysis_status 与列表派生口径一致（创建即 processing，不是硬编码 pending）', () => {
        assert.equal(StockTraceService.toPublicEvent(event()).analysis_status, 'processing');
    });

    it('window_end_at 仍按 ISO 字符串透出（回归护栏）', () => {
        assert.equal(StockTraceService.toPublicEvent(event()).window_end_at, WINDOW_END_AT.toISOString());
    });
});
