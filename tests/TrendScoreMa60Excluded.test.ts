import assert from 'node:assert/strict';
import { calcMa60Excluded } from '../src/modules/monitor/ma60Excluded';

function runTest(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`PASS ${name}`);
    } catch (err) {
        console.error(`FAIL ${name}`);
        throw err;
    }
}

/** 生成指定长度的收盘价序列：最后 N 天为 below 值，其余为 above 值 */
function makeCloses(len: number, above: number, below?: number): number[] {
    const arr = new Array(len).fill(above);
    if (below !== undefined) {
        arr[arr.length - 1] = below;
        arr[arr.length - 2] = below;
    }
    return arr;
}

function main(): void {
    // 基准：60日线上方的平稳序列，不应剔除
    runTest('不剔除：连续在60日线上方', () => {
        const closes = makeCloses(120, 10);
        assert.equal(calcMa60Excluded(closes), false);
    });

    // 连续两日跌破60日线 → 剔除
    runTest('剔除：连续两日收盘价在60日均线下方', () => {
        const closes = makeCloses(120, 10, 9);
        // ma60 ≈ 10，最后两天 close=9 < 10
        assert.equal(calcMa60Excluded(closes), true);
    });

    // 仅最后一天跌破 → 不剔除（需连续两日）
    runTest('不剔除：仅最后一天在60日均线下方', () => {
        const closes = makeCloses(120, 10);
        closes[closes.length - 1] = 9; // 仅最后一天跌破
        assert.equal(calcMa60Excluded(closes), false);
    });

    // 最后一天站回60日线上方 → 不剔除（搂回）
    runTest('不剔除：最后一天重新站上60日线（搂回）', () => {
        const closes = makeCloses(120, 10, 9);
        closes[closes.length - 1] = 10.5; // 最后一天站回
        // 前一天 9 < 10(ma60Prev)，但最后一天 10.5 > 10(ma60) → 不满足连续两日
        assert.equal(calcMa60Excluded(closes), false);
    });

    // 数据不足60日 → 不剔除（无法判断）
    runTest('不剔除：数据不足60日', () => {
        const closes = makeCloses(50, 10, 9);
        assert.equal(calcMa60Excluded(closes), false);
    });

    // 恰好61日数据，连续两日跌破 → 剔除（边界）
    runTest('剔除：恰好61日数据连续两日跌破', () => {
        const closes = makeCloses(61, 10, 9);
        assert.equal(calcMa60Excluded(closes), true);
    });

    // 收盘价恰好等于60日线 → 不算跌破（< 严格小于）
    runTest('不剔除：收盘价恰好等于60日线', () => {
        const closes = makeCloses(120, 10);
        // ma60 = 10，close = 10 不满足 close < ma60
        closes[closes.length - 1] = 10;
        closes[closes.length - 2] = 10;
        assert.equal(calcMa60Excluded(closes), false);
    });
}

main();
