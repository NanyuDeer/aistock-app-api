import assert from 'node:assert/strict';

/**
 * 从信号的三重共振状态计算 resonance_count
 * 复制自 HotBurstService 中的逻辑（导出后可直接引用）
 */
function countResonances(sig: {
    resonance1: { verified: boolean };
    resonance2: { verified: boolean };
    resonance3: { verified: boolean };
}): number {
    return [sig.resonance1.verified, sig.resonance2.verified, sig.resonance3.verified]
        .filter(Boolean).length;
}

function runTest(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`PASS ${name}`);
    } catch (err) {
        console.error(`FAIL ${name}`);
        throw err;
    }
}

function main(): void {
    runTest('counts 3 when all resonances verified', () => {
        const sig = {
            resonance1: { verified: true },
            resonance2: { verified: true },
            resonance3: { verified: true },
        };
        assert.equal(countResonances(sig), 3);
    });

    runTest('counts 2 for double resonance (1 and 2 pass)', () => {
        const sig = {
            resonance1: { verified: true },
            resonance2: { verified: true },
            resonance3: { verified: false },
        };
        assert.equal(countResonances(sig), 2);
    });

    runTest('counts 2 for double resonance (1 and 3 pass)', () => {
        const sig = {
            resonance1: { verified: true },
            resonance2: { verified: false },
            resonance3: { verified: true },
        };
        assert.equal(countResonances(sig), 2);
    });

    runTest('counts 2 for double resonance (2 and 3 pass)', () => {
        const sig = {
            resonance1: { verified: false },
            resonance2: { verified: true },
            resonance3: { verified: true },
        };
        assert.equal(countResonances(sig), 2);
    });

    runTest('counts 1 when only one resonance passes', () => {
        const sig = {
            resonance1: { verified: false },
            resonance2: { verified: true },
            resonance3: { verified: false },
        };
        assert.equal(countResonances(sig), 1);
    });

    runTest('counts 0 when no resonance passes', () => {
        const sig = {
            resonance1: { verified: false },
            resonance2: { verified: false },
            resonance3: { verified: false },
        };
        assert.equal(countResonances(sig), 0);
    });

    console.log('\n所有测试通过');
}

try {
    main();
} catch (err) {
    console.error(err);
    process.exit(1);
}
