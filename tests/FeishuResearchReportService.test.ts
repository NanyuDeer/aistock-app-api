import assert from 'node:assert/strict';
// 源文件已迁至 src/core/ 与 src/modules/（原 src/db、src/services/ 路径已不存在）
import pool from '../src/core/db';
import { isResearchReportMessage, extractReportRecommendedStocks, findResearchReportMessagesForStock } from '../src/modules/crawler/FeishuResearchReportService';

function runTest(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`PASS ${name}`);
    } catch (err) {
        console.error(`FAIL ${name}`);
        throw err;
    }
}

function runAsyncTest(name: string, fn: () => Promise<void>): Promise<void> {
    return fn().then(
        () => console.log(`PASS ${name}`),
        (err) => {
            console.error(`FAIL ${name}`);
            throw err;
        },
    );
}

async function main(): Promise<void> {
    runTest('identifies research report messages', () => {
        assert.equal(isResearchReportMessage('【VIP研报】六氟化硫龙头推荐：XXX'), true);
        assert.equal(isResearchReportMessage('今天天气不错'), false);
    });

    runTest('extracts recommended stocks from text', () => {
        const text = '推荐关注中际旭创(300308)、宁德时代：300750';
        const stocks = extractReportRecommendedStocks(text);
        const symbols = stocks.map(s => s.symbol);
        assert.ok(symbols.includes('300308'));
        assert.ok(symbols.includes('300750'));
    });

    await runAsyncTest('finds research report messages for a stock', async () => {
        const originalQuery = pool.query.bind(pool);
        // 两条查询语义不同：查询1 按 `$1 = ANY(stock_codes)` 命中，查询2 只取 `array_length(stock_codes,1) IS NULL`（此处无命中）。
        // 原 mock 对两条 SQL 返回同一批行，制造出现实中不存在的重复命中，导致断言 2 !== 1；按 SQL 形状分别返回以贴合真实语义。
        (pool as any).query = async (...args: any[]) => {
            const sql = String(args[0]);
            if (sql.includes('ANY(stock_codes)')) {
                return {
                    rows: [
                        {
                            id: 1,
                            chat_name: 'VIP研报群',
                            message_id: 'm1',
                            text: '【VIP研报】推荐中际旭创(300308)',
                            stock_codes: ['300308'],
                            received_at: '2026-06-18T09:00:00Z',
                        },
                        {
                            id: 2,
                            chat_name: '闲聊群',
                            message_id: 'm2',
                            text: '今天行情不错',
                            stock_codes: ['300308'],
                            received_at: '2026-06-18T09:05:00Z',
                        },
                    ],
                };
            }
            return { rows: [] };
        };

        try {
            const result = await findResearchReportMessagesForStock('300308', 24);
            assert.equal(result.length, 1);
            assert.equal(result[0].symbol, '300308');
            assert.equal(result[0].chatName, 'VIP研报群');
        } finally {
            (pool as any).query = originalQuery;
        }
    });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
