import assert from 'node:assert/strict';
import pool from '../src/db';
import { StockMonitorService } from '../src/services/StockMonitorService';

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

async function main(): Promise<void> {
await runAsyncTest('getEvents maps stock info judgements to trend hotspot events', async () => {
    const originalQuery = pool.query.bind(pool);
    const calls: any[][] = [];

    (pool as any).query = async (...args: any[]) => {
        calls.push(args);
        const sql = String(args[0]);
        assert.equal(sql.includes('stock_monitor_events'), false);

        if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) {
            return { rows: [] };
        }
        if (sql.includes('COUNT(*)::int AS total')) {
            return { rows: [{ total: 1 }] };
        }
        return {
            rows: [
                {
                    id: 7,
                    symbol: '300059',
                    stock_name: '东方财富',
                    info_type: 'news',
                    source: 'eastmoney',
                    source_id: 'eastmoney-news-202606083763702541',
                    title: '新闻标题',
                    url: 'https://finance.eastmoney.com/a/202606083763702541.html',
                    published_at: new Date('2026-06-08T09:34:00Z'),
                    ai_impact: '重大利好',
                    ai_horizon: '短期',
                    ai_keywords: ['券商', '金融科技'],
                    ai_summary: '公告或新闻带来短期关注度提升',
                    created_at: new Date('2026-06-08T09:35:00Z'),
                },
            ],
        };
    };

    try {
        const result = await StockMonitorService.getEvents({ limit: 20 });

        assert.equal(result.total, 1);
        assert.deepEqual(result.events, [
            {
                event_id: 'stock_info:7',
                symbol: '300059',
                stock_code: '300059',
                stock_name: '东方财富',
                industry: '',
                change_type: 'news',
                change_type_name: '新闻研判',
                level: '重大利好',
                cycle: 'short',
                price: null,
                change_pct: null,
                volume_ratio: null,
                turnover_rate: null,
                event_time: new Date('2026-06-08T09:34:00Z'),
                title: '新闻标题',
                summary: '公告或新闻带来短期关注度提升',
                detail_url: 'https://finance.eastmoney.com/a/202606083763702541.html',
                info_type: 'news',
                ai_impact: '重大利好',
                ai_horizon: '短期',
                ai_keywords: ['券商', '金融科技'],
                source: 'eastmoney',
            },
        ]);
        assert.equal(calls.some(call => String(call[0]).includes('stock_info_judgements')), true);
    } finally {
        (pool as any).query = originalQuery;
    }
});

await runAsyncTest('getStats counts announcement and news trend hotspots by impact', async () => {
    const originalQuery = pool.query.bind(pool);

    (pool as any).query = async (...args: any[]) => {
        const sql = String(args[0]);
        assert.equal(sql.includes('stock_monitor_events'), false);

        if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) {
            return { rows: [] };
        }
        return {
            rows: [{
                total: 3,
                announcement: 1,
                news: 2,
                positive: 2,
                negative: 1,
            }],
        };
    };

    try {
        assert.deepEqual(await StockMonitorService.getStats(), {
            total: 3,
            announcement: 1,
            news: 2,
            positive: 2,
            negative: 1,
        });
    } finally {
        (pool as any).query = originalQuery;
    }
});

runTest('stock monitor service has no active scanner method', () => {
    assert.equal('scanAndDispatch' in StockMonitorService, false);
});
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
