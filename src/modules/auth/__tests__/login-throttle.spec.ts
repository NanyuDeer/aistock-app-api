import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isThrottled, recordFailure, clearAccountFailure, FAIL_MAX } from '../loginThrottle';

// 每次运行生成唯一账号/IP：避免持久化 Redis 中上一轮残留计数导致用例 flaky
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

function uniqueIp(): string {
    const h = nextHash();
    return `10.${(h >>> 16) & 255}.${(h >>> 8) & 255}.${h & 255}`;
}

test('累计达到阈值后 isThrottled 为 true', async () => {
    const acct = uniquePhone();
    const ip = uniqueIp();
    assert.equal(FAIL_MAX, 2);
    assert.equal(await isThrottled(acct, ip), false);
    await recordFailure(acct, ip);
    assert.equal(await isThrottled(acct, ip), false);
    await recordFailure(acct, ip);
    assert.equal(await isThrottled(acct, ip), true);
});

test('clearAccountFailure 清账号计数但保留 IP 计数', async () => {
    const acct = uniquePhone();
    const ip = uniqueIp();
    const otherAcct = uniquePhone();
    const freshAcct = uniquePhone();
    await recordFailure(acct, ip);
    await clearAccountFailure(acct);
    assert.equal(await isThrottled(acct, ip), false);
    await recordFailure(otherAcct, ip);
    assert.equal(await isThrottled(freshAcct, ip), true);
});
