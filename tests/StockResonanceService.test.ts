import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// 源文件已迁至 src/modules/（原 src/services/ 路径已不存在）
import { evaluateStockResonance } from '../src/modules/monitor/StockResonanceService';

function runAsyncTest(name: string, fn: () => Promise<void>): Promise<void> {
    return fn().then(
        () => console.log(`PASS ${name}`),
        (err) => {
            console.error(`FAIL ${name}`);
            throw err;
        },
    );
}

// evaluateStockResonance 经 ConceptIndustryMap 读取运行时缓存 src/data/kg-cache/*.json（被 .gitignore，
// 干净检出/CI 中不存在，直接跑会 ENOENT）。测试自备最小 fixture 临时写入、结束后还原。
const KG_DIR = path.resolve(__dirname, '../src/data/kg-cache');
const FIXTURE_FILES: Array<[string, unknown]> = [
    ['concept_industry_relations.json', [
        { id: '885551.TI', name: '氟化工概念', relatedIndustries: [{ industryId: 'I1', overlapRatio: 0.8, overlapCount: 12 }] },
    ]],
    ['industries.json', [
        { id: 'I1', name: '化学制品', leadingStocks: [] },
    ]],
];

function seedKgCache(): () => void {
    const backups = new Map<string, string | null>();
    fs.mkdirSync(KG_DIR, { recursive: true });
    for (const [name, data] of FIXTURE_FILES) {
        const file = path.join(KG_DIR, name);
        backups.set(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);
        fs.writeFileSync(file, JSON.stringify(data));
    }
    return () => {
        for (const [file, original] of backups) {
            if (original === null) fs.rmSync(file, { force: true });
            else fs.writeFileSync(file, original);
        }
    };
}

async function main(): Promise<void> {
    const restore = seedKgCache();
    try {
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
            // 契约变更（模块化重构起）：返回值由 resonance1/2/3 三个对象改为扁平布尔 + resonanceCount（见 StockResonanceDetail）
            assert.equal(result.clsVerified, true);
            assert.equal(result.glhVerified, true);
            assert.equal(result.thsVerified, true);
            assert.equal(result.reportVerified, true);
            assert.equal(result.resonanceCount, 4);
            assert.equal(result.isOutbreak, true);
        });
    } finally {
        restore();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
