import assert from 'node:assert/strict';
import { getParentIndustries, isParentIndustryHot } from '../src/services/ConceptIndustryMap';

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
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
