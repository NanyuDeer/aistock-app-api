import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isThrottled, recordFailure, clearAccountFailure, FAIL_MAX } from '../loginThrottle';

// 每次运行生成唯一账号：避免持久化 Redis 中上一轮残留计数导致用例 flaky
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let seq = 0;

function hashToken(input: string): number {
    let h = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function nextHash(): number {
    seq += 1;
    return hashToken(`${runId}-${seq}`);
}

function uniquePhone(): string {
    return `139${String(nextHash() % 100000000).padStart(8, '0')}`;
}

test('累计达到阈值后 isThrottled 为 true', async () => {
    const acct = uniquePhone();
    assert.equal(FAIL_MAX, 10);
    assert.equal(await isThrottled(acct), false);
    for (let i = 0; i < FAIL_MAX - 1; i += 1) {
        await recordFailure(acct);
    }
    assert.equal(await isThrottled(acct), false);
    await recordFailure(acct);
    assert.equal(await isThrottled(acct), true);
});

test('账号维度互不影响', async () => {
    const acct = uniquePhone();
    const otherAcct = uniquePhone();
    await recordFailure(acct);
    assert.equal(await isThrottled(otherAcct), false);
});

test('clearAccountFailure 归零账号计数', async () => {
    const acct = uniquePhone();
    for (let i = 0; i < FAIL_MAX; i += 1) {
        await recordFailure(acct);
    }
    assert.equal(await isThrottled(acct), true);
    await clearAccountFailure(acct);
    assert.equal(await isThrottled(acct), false);
});
