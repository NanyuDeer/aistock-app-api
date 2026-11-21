import { EventEmitter } from 'node:events';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../db';
import { __aiSelectionDependencies as deps, triggerAiStockSelection, aiEntryPerformance, loadCandidates, selectWithAi } from '../aiStockSelectionRouter';
import { tradingCalendarStore, __tradingCalendarStoreDependencies } from '../../../shared/utils/tradingCalendarStore';
import { TradingCalendarRefreshService } from '../../../modules/market/TradingCalendarRefreshService';

test('AI持锁到执行结束；成功同日复用，降级重试，force重跑；获取锁后清理遗留任务', async () => {
    const queries: string[] = [];
    let locked = true, ready = false, nextId = 1;
    let finish!: () => void;
    const client = Object.assign(new EventEmitter(), { query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
        if (sql.includes('SELECT id FROM')) return { rows: ready ? [{ id: 7 }] : [] };
        if (sql.includes('INSERT INTO ai_stock_selection_runs')) return { rows: [{ id: nextId++ }] };
        return { rows: [] };
    }, release: mock.fn() });
    const schema = mock.method(pool, 'query', (async () => ({ rows: [] })) as never);
    const connect = mock.method(pool, 'connect', (async () => client) as never);
    const execute = mock.method(deps, 'execute', async () => new Promise<void>(resolve => { finish = resolve; }));
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));
    try {
        assert.equal((await triggerAiStockSelection('schedule', '2026-11-20')).status, 'generating');
        assert.equal(client.release.mock.callCount(), 0);
        locked = false;
        assert.equal((await triggerAiStockSelection('schedule', '2026-11-20')).status, 'generating');
        assert.equal(execute.mock.callCount(), 1);
        finish(); await flush(); locked = true;
        // A fallback has no successful model row, so the next slot runs again.
        assert.equal((await triggerAiStockSelection('schedule', '2026-11-20')).status, 'generating');
        finish(); await flush(); ready = true;
        assert.deepEqual(await triggerAiStockSelection('schedule', '2026-11-20'), { runId: 7, status: 'ready' });
        assert.equal(execute.mock.callCount(), 2);
        assert.equal((await triggerAiStockSelection('manual', '2026-11-20', true)).status, 'generating');
        finish(); await flush();
        assert.equal(execute.mock.callCount(), 3);
        assert.ok(queries.some(sql => sql.includes("WHERE status='generating'")));
        assert.ok(queries.some(sql => sql.includes('model IS NOT NULL')));
    } finally { schema.mock.restore(); connect.mock.restore(); execute.mock.restore(); }
});

test('AI连续入选跨周末但不跨缺失交易日，开盘价基准按复权因子计算', async () => {
    const cal = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(Date.UTC(2026, 10, 9 + i));
        return { cal_date: d.toISOString().slice(0, 10), is_open: ![0, 6].includes(d.getUTCDay()), pretrade_date: null };
    });
    const cq = mock.method(__tradingCalendarStoreDependencies, 'query', async () => ({ rows: cal }));
    const refresh = mock.method(TradingCalendarRefreshService, 'refresh', async () => ({ fetched: 0, upserted: 0, minDate: null, maxDate: null }));
    let gap = false;
    const query = mock.method(pool, 'query', (async (sql: string, params: unknown[]) => {
        if (sql.includes('AS members')) return { rows: params[0] === '2026-11-16' ? [
            ...(!gap ? [{ date: '2026-11-13', members: ['600001'] }] : []),
            { date: '2026-11-12', members: ['600001'] },
        ] : [] };
        if (sql.includes('SELECT trade_date::text AS date FROM stock_selection_market_days')) return { rows: [{ date: '2026-11-16' }] };
        if (sql.includes('jsonb_object_agg')) return { rows: [{ date: params[0], bars: { '600001': { open: 100, close: params[0] === '2026-11-16' ? 55 : 100, factor: params[0] === '2026-11-16' ? 2 : 1 } } }] };
        return { rows: [] };
    }) as never);
    try {
        tradingCalendarStore.__resetForTest(); await tradingCalendarStore.load();
        const result = await aiEntryPerformance('2026-11-16', ['600001'], 1);
        assert.equal(result.entries.get('600001')?.sessions, 3);
        assert.equal(result.entries.get('600001')?.date, '2026-11-12');
        assert.ok(Math.abs(result.entries.get('600001')!.closeReturn! - 10) < 1e-8);
        gap = true;
        assert.equal((await aiEntryPerformance('2026-11-16', ['600001'], 1)).entries.get('600001')?.sessions, 1);
        cal.splice(cal.findIndex(row => row.cal_date === '2026-11-13'), 1);
        await tradingCalendarStore.load();
        assert.equal((await aiEntryPerformance('2026-11-16', ['600001'], 1)).entries.get('600001')?.sessions, 1);
    } finally { cq.mock.restore(); refresh.mock.restore(); query.mock.restore(); tradingCalendarStore.__resetForTest(); }
});

test('单个候选来源失败不阻断其余来源；全部没有有效候选返回空池', async () => {
    const query = mock.method(pool, 'query', (async (sql: string) => {
        if (sql.includes('FROM trend_scores')) throw new Error('trend unavailable');
        if (sql.includes('forecast_netprofit IS NOT NULL')) return { rows: [{ symbol: '600001', name: '测试', industry: '测试行业', forecast_netprofit: 100 }] };
        return { rows: [] };
    }) as never);
    try { assert.deepEqual((await loadCandidates('2026-11-20')).map(c => c.symbol), ['600001']); }
    finally { query.mock.restore(); }
});

test('模型只接受实际发送的股票与正确指标；伪造指标降级', async () => {
    const saved = { QWEN_BASE_URL: process.env.QWEN_BASE_URL, QWEN_API_KEY: process.env.QWEN_API_KEY, QWEN_MODEL: process.env.QWEN_MODEL };
    Object.assign(process.env, { QWEN_BASE_URL: 'https://model.invalid', QWEN_API_KEY: 'test', QWEN_MODEL: 'test-model' });
    let wrong = false;
    const fetcher = mock.method(deps, 'modelFetch', async (_url: string | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body));
        assert.ok(request.messages[0].content.length + request.messages[1].content.length <= 42_000);
        const output = { summary: '当前市场存在波动风险', stocks: [{ symbol: '600001', rank: 1, reason: [{ field: 'market.price', analysis: '股价位于MA20上方' }], recommendationLevel: '关注', riskTip: '注意市场波动', evidence: [{ field: 'market.price', value: wrong ? 21 : 12.34 }] }] };
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
    });
    const candidate = { symbol: '600001', name: '测试', industry: '测试行业', sourceRanks: { shortTermRank: null, trendRank: 1, institutionRank: null, netProfitForecastRank: null, epsForecastRank: null, netProfitGrowthRank: null, epsGrowthRank: null },
        trend: {}, institution: {}, forecast: {}, market: { price: 12.34 }, technical: {}, capitalFlow: {}, events: { recentNews: [] }, riskFlags: {} };
    try {
        const success = await selectWithAi([candidate]);
        assert.equal(success.model, 'test-model');
        assert.deepEqual(success.output.stocks[0].reason, ['现价12.34元；股价位于MA20上方']);
        wrong = true;
        assert.equal((await selectWithAi([candidate])).model, null);
    } finally {
        fetcher.mock.restore();
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
});

test('AI当天盘后快照尚不存在时只用冻结开盘价；开盘价缺失不冒用其他价格', async () => {
    let hasOpening = true;
    const query = mock.method(pool, 'query', (async (sql: string) => {
        if (sql.includes('AS members')) return { rows: [] };
        if (sql.includes('jsonb_object_agg')) return { rows: [] };
        if (sql.includes("candidate_payload->'market'->>'open'")) return { rows: [{ symbol: '600001', date: '2026-11-20', open: hasOpening ? '10' : null }] };
        return { rows: [] };
    }) as never);
    try {
        const result = await aiEntryPerformance('2026-11-20', ['600001'], 1);
        assert.equal(result.entries.get('600001')?.price, 10);
        assert.equal(result.entries.get('600001')?.liveBasePrice, 10);
        assert.equal(result.entries.get('600001')?.closeReturn, null);
        hasOpening = false;
        assert.equal((await aiEntryPerformance('2026-11-20', ['600001'], 1)).entries.get('600001')?.price, null);
    } finally { query.mock.restore(); }
});

test('AI等待模型期间会话断线：接收模型结果后仍禁止持久化，不发布ready', async () => {
    const { SelectionSession } = await import('../../../modules/stock-selection/SelectionSession');
    const { TencentQuoteService } = await import('../../../modules/quote/TencentQuoteService');
    const { TushareKlineService } = await import('../../../modules/quote/TushareKlineService');
    const { ClsStockNewsService } = await import('../../../modules/monitor/ClsStockNewsService');
    const statements: string[] = [];
    const client = Object.assign(new EventEmitter(), { query: async (sql: string) => { statements.push(sql); return { rows: [] }; }, release: mock.fn() });
    const session = new SelectionSession(client as never);
    const saved = { QWEN_BASE_URL: process.env.QWEN_BASE_URL, QWEN_API_KEY: process.env.QWEN_API_KEY, QWEN_MODEL: process.env.QWEN_MODEL };
    Object.assign(process.env, { QWEN_BASE_URL: 'https://model.invalid', QWEN_API_KEY: 'test', QWEN_MODEL: 'test-model' });
    const failures: string[] = [];
    const hooks = [
        mock.method(pool, 'query', (async (sql: string) => {
            if (sql.includes("status = 'failed'")) failures.push(sql);
            return { rows: sql.includes('FROM trend_scores') ? [{ symbol: '600001', name: '测试', industry: '测试行业' }] : [] };
        }) as never),
        mock.method(TencentQuoteService, 'getBatchQuotes', async () => [{ 股票代码: '600001', 最新价: 12.34, 今开价: 12, 行情时间: '20261120094000' }]),
        mock.method(TushareKlineService, 'getKLine', async () => []),
        mock.method(ClsStockNewsService, 'getStockNews', (async () => ({ items: [] })) as never),
        mock.method(deps, 'capitalFlow', (async () => ({})) as never),
        mock.method(deps, 'priceLimits', async () => new Map([['600001', { upper: 14, lower: 10 }]])),
        mock.method(deps, 'suspensions', async () => new Map()),
        mock.method(deps, 'modelFetch', async () => {
            client.emit('error', new Error('socket lost while waiting for model'));
            const output = { summary: '注意市场风险', stocks: [{ symbol: '600001', rank: 1, recommendationLevel: '关注', riskTip: '注意波动',
                reason: [{ field: 'market.price', analysis: '趋势仍需观察' }], evidence: [{ field: 'market.price', value: 12.34 }] }] };
            return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
        }),
    ];
    try {
        await deps.execute(99, '2026-11-20', client as never, session);
        assert.ok(!statements.includes('BEGIN'));
        assert.ok(!statements.some(sql => sql.includes('INSERT INTO ai_stock_selection_results')));
        assert.equal(failures.length, 1);
    } finally {
        await session.release(73140922);
        assert.deepEqual(client.release.mock.calls[0].arguments, [true]);
        hooks.forEach(hook => hook.mock.restore());
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
});
