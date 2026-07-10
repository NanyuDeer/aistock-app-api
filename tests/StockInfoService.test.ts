import assert from 'node:assert/strict';
import pool from '../src/db';
import {
    buildStockInfoTargets,
    buildStockInfoExistingKeys,
    normalizeStockInfoJudgementInput,
    shouldPushStockInfoJudgement,
    StockInfoService,
    type StockInfoJudgementRow,
} from '../src/services/StockInfoService';

function runTest(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`PASS ${name}`);
    } catch (err) {
        console.error(`FAIL ${name}`);
        throw err;
    }
}

async function runAsyncTest(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`PASS ${name}`);
    } catch (err) {
        console.error(`FAIL ${name}`);
        throw err;
    }
}

runTest('buildStockInfoTargets merges favorites and leaders by 6-digit symbol', () => {
    const targets = buildStockInfoTargets({
        favorites: [
            { symbol: '000001', stock_name: '平安银行', market: 'SZ', favorite_user_count: 2 },
            { symbol: 'SH600519', stock_name: '贵州茅台', market: 'SH', favorite_user_count: 1 },
        ],
        hotSectors: [
            {
                leading_stock_info: { code: '000001', name: '平安银行', reason: '趋势龙头股' },
                main_stocks: [{ code: '688595', name: '芯海科技', reason: '量价齐升' }],
            },
        ],
        source: 'all',
        limit: 10,
    });

    assert.deepEqual(targets, [
        {
            symbol: '000001',
            stock_name: '平安银行',
            market: 'SZ',
            target_sources: ['favorite', 'leader'],
            favorite_user_count: 2,
            leader_reason: '趋势龙头股',
        },
        {
            symbol: '600519',
            stock_name: '贵州茅台',
            market: 'SH',
            target_sources: ['favorite'],
            favorite_user_count: 1,
            leader_reason: '',
        },
        {
            symbol: '688595',
            stock_name: '芯海科技',
            market: 'SH',
            target_sources: ['leader'],
            favorite_user_count: 0,
            leader_reason: '量价齐升',
        },
    ]);
});

runTest('normalizeStockInfoJudgementInput validates and clips crawler payload', () => {
    const item = normalizeStockInfoJudgementInput({
        symbol: 'SZ000001',
        stock_name: '平安银行',
        info_type: 'news',
        source: 'ths',
        source_id: '',
        title: ' 平安银行发布重要公告 ',
        url: 'https://field.10jqka.com.cn/a.shtml',
        published_at: '2026-06-08T09:30:00+08:00',
        ai_impact: '重大利好',
        ai_horizon: '中长期',
        ai_keywords: ['涨价', '订单', '涨价', 123, '回购', '分红', '扩产', '并购', '中标', '降本'],
        ai_summary: '重大利好，中长期，关键词：涨价、订单',
    });

    assert.equal(item.symbol, '000001');
    assert.equal(item.source_id, null);
    assert.equal(item.dedupe_key.length, 40);
    assert.deepEqual(item.ai_keywords, ['涨价', '订单', '回购', '分红', '扩产', '并购', '中标', '降本']);
});

runTest('normalizeStockInfoJudgementInput rejects invalid enum values', () => {
    assert.throws(() => normalizeStockInfoJudgementInput({
        symbol: '000001',
        info_type: 'report',
        source: 'ths',
        title: '标题',
        url: 'https://field.10jqka.com.cn/a.shtml',
        published_at: '2026-06-08T09:30:00+08:00',
        ai_impact: '重大利好',
        ai_horizon: '中长期',
        ai_keywords: [],
        ai_summary: '结论',
    }), /info_type/);
});

runTest('buildStockInfoExistingKeys normalizes source info_type and source_id', () => {
    const keys = buildStockInfoExistingKeys([
        { source: ' eastmoney ', info_type: 'announcement', source_id: ' eastmoney-announcement-AN1 ' },
        { source: 'eastmoney', info_type: 'news', source_id: 'eastmoney-news-N1' },
        { source: '', info_type: 'news', source_id: 'eastmoney-news-N2' },
        { source: 'eastmoney', info_type: 'report', source_id: 'eastmoney-report-R1' },
        { source: 'eastmoney', info_type: 'news', source_id: '' },
        { source: 'eastmoney', info_type: 'news', source_id: 'eastmoney-news-N1' },
    ]);

    assert.deepEqual(keys, [
        { key: 'eastmoney|announcement|eastmoney-announcement-AN1', source: 'eastmoney', info_type: 'announcement', source_id: 'eastmoney-announcement-AN1' },
        { key: 'eastmoney|news|eastmoney-news-N1', source: 'eastmoney', info_type: 'news', source_id: 'eastmoney-news-N1' },
    ]);
});

runAsyncTest('getExistingJudgements returns rows already stored by dedupe key', async () => {
    const originalQuery = pool.query.bind(pool);
    const calls: any[][] = [];
    (pool as any).query = async (...args: any[]) => {
        calls.push(args);
        if (String(args[0]).includes('CREATE TABLE') || String(args[0]).includes('CREATE INDEX')) {
            return { rows: [] };
        }
        return {
            rows: [
                { source: 'eastmoney', info_type: 'announcement', source_id: 'eastmoney-announcement-AN1' },
            ],
        };
    };

    try {
        const existing = await StockInfoService.getExistingJudgements([
            { source: 'eastmoney', info_type: 'announcement', source_id: 'eastmoney-announcement-AN1' },
            { source: 'eastmoney', info_type: 'news', source_id: 'eastmoney-news-N1' },
        ]);

        assert.deepEqual(existing, [
            { key: 'eastmoney|announcement|eastmoney-announcement-AN1', source: 'eastmoney', info_type: 'announcement', source_id: 'eastmoney-announcement-AN1' },
        ]);
        assert.equal(calls.some(call => String(call[0]).includes('dedupe_key = ANY')), true);
    } finally {
        (pool as any).query = originalQuery;
    }
});

runTest('shouldPushStockInfoJudgement only allows major impact within window and type', () => {
    const base: StockInfoJudgementRow = {
        id: 1,
        symbol: '000001',
        stock_name: '平安银行',
        info_type: 'announcement',
        title: '公告',
        url: 'https://field.10jqka.com.cn/a.shtml',
        published_at: new Date('2026-06-08T00:30:00Z'),
        ai_impact: '重大利好',
        ai_horizon: '中长期',
        ai_keywords: ['涨价'],
        ai_summary: '重大利好，中长期，关键词：涨价',
        created_at: new Date('2026-06-08T00:35:00Z'),
    };

    assert.equal(shouldPushStockInfoJudgement(base, {
        info_type: 'announcement',
        from: new Date('2026-06-07T07:00:00Z'),
        to: new Date('2026-06-08T01:00:00Z'),
    }), true);
    assert.equal(shouldPushStockInfoJudgement({ ...base, ai_impact: '利好' }, {
        info_type: 'announcement',
        from: new Date('2026-06-07T07:00:00Z'),
        to: new Date('2026-06-08T01:00:00Z'),
    }), false);
    assert.equal(shouldPushStockInfoJudgement(base, {
        info_type: 'news',
        from: new Date('2026-06-07T07:00:00Z'),
        to: new Date('2026-06-08T01:00:00Z'),
    }), false);
});
