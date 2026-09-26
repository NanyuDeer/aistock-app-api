import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isThrottled, recordFailure, clearAccountFailure, FAIL_MAX } from '../loginThrottle';

test('累计达到阈值后 isThrottled 为 true', async () => {
    const acct = '13900009999';
    const ip = '10.9.9.9';
    assert.equal(FAIL_MAX, 2);
    assert.equal(await isThrottled(acct, ip), false);
    await recordFailure(acct, ip);
    assert.equal(await isThrottled(acct, ip), false);
    await recordFailure(acct, ip);
    assert.equal(await isThrottled(acct, ip), true);
});

test('clearAccountFailure 清账号计数但保留 IP 计数', async () => {
    const acct = '13900009998';
    const ip = '10.9.9.8';
    await recordFailure(acct, ip);
    await clearAccountFailure(acct);
    assert.equal(await isThrottled(acct, ip), false);
    await recordFailure('13900009997', ip);
    assert.equal(await isThrottled('13900009996', ip), true);
});
