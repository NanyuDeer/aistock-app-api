import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { __selectionMarketDependencies as deps, selectionMarketDay, selectionPages } from '../SelectionMarketData';

test('批量分页完整读取第二页，拒绝数据源忽略offset的重复页', async () => {
    const page = Array.from({ length: 5000 }, (_, i) => ({ ts_code: String(i), trade_date: '20261104' }));
    const hook = mock.method(deps, 'request', async (_api: string, params: Record<string, unknown>) => params.offset === 0 ? page : [{ ts_code: '5000', trade_date: '20261104' }]);
    try {
        assert.equal((await selectionPages('daily', {}, '')).length, 5001);
        assert.equal(hook.mock.calls[1].arguments[1].offset, 5000);
    } finally { hook.mock.restore(); }
    const repeated = mock.method(deps, 'request', async () => page);
    try { await assert.rejects(selectionPages('daily', {}, ''), /分页未前进/); }
    finally { repeated.mock.restore(); }
});
test('网络错误和限频重试后继续，业务错误立即失败', async () => {
    const sleep = mock.method(deps, 'sleep', async () => {});
    let calls = 0;
    const flaky = mock.method(deps, 'request', async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        if (calls === 2) throw new Error('Tushare daily 业务错误: 抱歉，您每分钟最多访问该接口200次');
        return [{ ts_code: '600000.SH', trade_date: '20261104' }];
    });
    try {
        assert.equal((await selectionPages('daily', {}, '')).length, 1);
        assert.equal(calls, 3);
        assert.equal(sleep.mock.callCount(), 2);
    } finally { flaky.mock.restore(); }
    const denied = mock.method(deps, 'request', async () => { throw new Error('Tushare daily 业务错误: 没有接口访问权限'); });
    try {
        await assert.rejects(selectionPages('daily', {}, ''), /没有接口访问权限/);
        assert.equal(denied.mock.callCount(), 1);
    } finally { denied.mock.restore(); sleep.mock.restore(); }
});
test('成交量手转股、成交额千元转元，按日期和股票匹配因子；缺失不填1', async () => {
    const daily = ['600000.SH', '600001.SH', '600002.SH'].map(ts_code => ({ ts_code, trade_date: '20261104', open: 10, high: 11, low: 9, close: 10, vol: 100, amount: 500, pct_chg: 2 }));
    const hook = mock.method(deps, 'request', async (api: string) => api === 'daily' ? daily : [
        { ts_code: '600000.SH', trade_date: '20261104', adj_factor: 2 },
        { ts_code: '600001.SH', trade_date: '20261103', adj_factor: 3 },
    ]);
    try {
        const day = await selectionMarketDay('2026-11-04');
        assert.deepEqual(Object.keys(day.bars), ['600000']);
        assert.equal(day.bars['600000'].volume, 10000);
        assert.equal(day.bars['600000'].amount, 500000);
        assert.equal(day.bars['600000'].factor, 2);
    } finally { hook.mock.restore(); }
});
