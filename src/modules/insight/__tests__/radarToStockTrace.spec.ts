/**
 * runCycle 命中改走 stock-trace：行情解析纯函数 + 分支契约。
 * 运行：node --import tsx --test src/modules/insight/__tests__/radarToStockTrace.spec.ts
 *
 * 注意：模块为 CJS（tsconfig module: commonjs），tsx 下命名导出是 configurable:false 的 getter，
 * 无法用 mock.method 拦截。radarHitToPriceEvent 集成测试由 runCycleEnqueue.spec.ts 覆盖。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as insightNs from '../InsightService';

const ns = insightNs as unknown as { default?: Record<string, unknown> };
const api = (ns.default ?? insightNs) as {
    parseActivityQuote: (row: Record<string, unknown>) => { latest: number | null; prevClose: number | null; changePct: number | null; name: string };
    radarHitToPriceEvent: (symbol: string, securities: unknown[]) => Promise<{ triggered: boolean }>;
};

describe('parseActivityQuote（涨停雷达命中→stock-trace 行情解析）', () => {
    it('解析 activity 行情字段（中文键→数值）', () => {
        const q = api.parseActivityQuote({ 股票代码: '600000', 股票简称: '浦发银行', 最新价: '10.8', 昨收价: '10', 涨跌幅: '8.00' });
        assert.equal(q.latest, 10.8);
        assert.equal(q.prevClose, 10);
        assert.equal(q.changePct, 8);
        assert.equal(q.name, '浦发银行');
    });

    it('缺字段→返回 null 不抛异常', () => {
        const q = api.parseActivityQuote({ 股票代码: '600000', 股票简称: '浦发银行', 最新价: '10.8' });
        assert.equal(q.prevClose, null);
        assert.equal(q.changePct, null);
    });

    it('非数值字段→返回 null', () => {
        const q = api.parseActivityQuote({ 股票代码: '600000', 股票简称: '浦发银行', 最新价: 'abc', 昨收价: '10', 涨跌幅: '8.00' });
        assert.equal(q.latest, null);
    });

    it('name 非字符串时回退为空串', () => {
        const q = api.parseActivityQuote({ 股票代码: '600000', 股票简称: 123, 最新价: '10.8', 昨收价: '10', 涨跌幅: '8.00' });
        assert.equal(q.name, '');
    });

    it('radarHitToPriceEvent 存在且为函数（分支契约）', () => {
        assert.equal(typeof api.radarHitToPriceEvent, 'function');
    });
});