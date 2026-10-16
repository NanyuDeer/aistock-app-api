import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// 源文件已迁至 src/modules/（原 src/services/ 路径已不存在）
import { getParentIndustries, isParentIndustryHot } from '../src/modules/monitor/ConceptIndustryMap';

function runAsyncTest(name: string, fn: () => Promise<void>): Promise<void> {
    return fn().then(
        () => console.log(`PASS ${name}`),
        (err) => {
            console.error(`FAIL ${name}`);
            throw err;
        },
    );
}

// ConceptIndustryMap 从运行时缓存 src/data/kg-cache/*.json 读取（该目录被 .gitignore，干净检出/CI 中不存在，
// 直接跑会 ENOENT）。测试自备最小 fixture 临时写入、结束后还原，保证无外部数据也能稳定运行。
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
        await runAsyncTest('returns parent industries for a known concept', async () => {
            const parents = await getParentIndustries('885551.TI');
            assert.ok(parents.length > 0, 'should have parent industries');
            assert.ok(parents.map(p => p.name).includes('化学制品'), 'should include 化学制品');
        });

        await runAsyncTest('detects hot parent industry', async () => {
            const hotSet = new Set(['化学制品', '半导体']);
            const result = await isParentIndustryHot('885551.TI', hotSet);
            assert.equal(result.verified, true);
            assert.ok(result.names.includes('化学制品'));
        });
    } finally {
        restore();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
