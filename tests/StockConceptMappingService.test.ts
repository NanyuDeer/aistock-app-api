import assert from 'node:assert/strict';
import { buildStockConceptPairs } from '../src/services/StockConceptMappingService';

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
    await runAsyncTest('builds stock-concept pairs from concepts and members', async () => {
        const concepts = [
            { tsCode: '885853.TI', name: '六氟化硫' },
            { tsCode: '885854.TI', name: '存储芯片' },
        ];
        const mockGetMembers = async (tsCode: string) => {
            if (tsCode === '885853.TI') {
                return [
                    { conCode: '300308.SZ', conName: '中际旭创' },
                    { conCode: '002475.SZ', conName: '立讯精密' },
                ];
            }
            if (tsCode === '885854.TI') {
                return [
                    { conCode: '603986.SH', conName: '兆易创新' },
                ];
            }
            return [];
        };

        const pairs = await buildStockConceptPairs(concepts, mockGetMembers);
        assert.equal(pairs.length, 3);
        assert.ok(pairs.some(p => p.symbol === '300308' && p.sectorName === '六氟化硫'));
        assert.ok(pairs.some(p => p.symbol === '002475' && p.sectorName === '六氟化硫'));
        assert.ok(pairs.some(p => p.symbol === '603986' && p.sectorName === '存储芯片'));
    });

    await runAsyncTest('deduplicates identical symbol-sector pairs', async () => {
        const concepts = [
            { tsCode: '885001.TI', name: '概念A' },
            { tsCode: '885002.TI', name: '概念A' }, // 同名概念（不同 ts_code）
        ];
        const mockGetMembers = async (tsCode: string) => {
            if (tsCode === '885001.TI') {
                return [{ conCode: '300308.SZ', conName: '中际旭创' }];
            }
            if (tsCode === '885002.TI') {
                return [{ conCode: '300308.SZ', conName: '中际旭创' }];
            }
            return [];
        };

        const pairs = await buildStockConceptPairs(concepts, mockGetMembers);
        // 同一 symbol + 同一 sectorName 只保留一条
        const count = pairs.filter(p => p.symbol === '300308' && p.sectorName === '概念A').length;
        assert.equal(count, 1);
    });

    await runAsyncTest('skips members with invalid con_code', async () => {
        const concepts = [{ tsCode: '885001.TI', name: '测试概念' }];
        const mockGetMembers = async () => [
            { conCode: '300308.SZ', conName: '中际旭创' },
            { conCode: '', conName: '空代码' },
            { conCode: 'ABC.SZ', conName: '非6位代码' },
        ];

        const pairs = await buildStockConceptPairs(concepts, mockGetMembers);
        assert.equal(pairs.length, 1);
        assert.equal(pairs[0].symbol, '300308');
    });

    await runAsyncTest('continues on member fetch error for single concept', async () => {
        const concepts = [
            { tsCode: '885001.TI', name: '正常概念' },
            { tsCode: '885002.TI', name: '错误概念' },
        ];
        const mockGetMembers = async (tsCode: string) => {
            if (tsCode === '885002.TI') throw new Error('API error');
            return [{ conCode: '300308.SZ', conName: '中际旭创' }];
        };

        const pairs = await buildStockConceptPairs(concepts, mockGetMembers);
        assert.equal(pairs.length, 1);
        assert.equal(pairs[0].sectorName, '正常概念');
    });

    console.log('\n所有测试通过');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
