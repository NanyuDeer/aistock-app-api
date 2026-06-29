import assert from 'node:assert/strict';
import { evaluateStockResonance } from '../src/services/StockResonanceService';

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
    await runAsyncTest('returns outbreak when all three resonances pass', async () => {
        const hotConcepts = [
            {
                conceptName: '氟化工概念',
                conceptTsCode: '885551.TI',
                clsCount: 3,
                glhCount: 2,
                totalCount: 5,
                previousCount: 1,
                surgeRatio: 5,
                crossVerified: true,
                stockCodes: [{ symbol: '300308', name: '中际旭创', source: 'both' as const }],
                articles: [],
                detectedAt: new Date().toISOString(),
            },
        ];

        const hotSectorSet = new Set(['化学制品']);
        const hotSectorRankMap = new Map([['化学制品', 3]]);
        const reportStocks = [{ symbol: '300308', stockName: '中际旭创', messageId: 'm1', chatName: 'VIP研报群', text: '推荐', receivedAt: new Date().toISOString() }];

        const result = await evaluateStockResonance('300308', hotConcepts, hotSectorSet, hotSectorRankMap, reportStocks);
        assert.equal(result.isOutbreak, true);
        assert.equal(result.resonance1.verified, true);
        assert.equal(result.resonance2.verified, true);
        assert.equal(result.resonance3.verified, true);
    });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
