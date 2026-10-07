import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, isStrongPassword, verifyPasswordConstantTime, MAX_PASSWORD_LENGTH, MAX_CONCURRENT_SCRYPT } from '../passwordUtils';

test('hashPassword 生成 scrypt$ 前缀，且 verifyPassword 正确验证', async () => {
    const stored = await hashPassword('abc12345');
    assert.ok(stored.startsWith('scrypt$'));
    assert.equal(stored.split('$').length, 6);
    assert.equal(await verifyPassword('abc12345', stored), true);
    assert.equal(await verifyPassword('abc12346', stored), false);
});

test('verifyPassword 对 null / 非法格式返回 false', async () => {
    assert.equal(await verifyPassword('abc12345', null), false);
    assert.equal(await verifyPassword('abc12345', ''), false);
    assert.equal(await verifyPassword('abc12345', 'plaintext'), false);
    assert.equal(await verifyPassword('abc12345', 'scrypt$bad'), false);
});

test('isStrongPassword 校验长度与字母数字组合', () => {
    assert.equal(isStrongPassword('abc12345'), true);
    assert.equal(isStrongPassword('abcdefgh'), false);
    assert.equal(isStrongPassword('12345678'), false);
    assert.equal(isStrongPassword('abc123'), false);
});

test('hashPassword 使用绑定参数（N/r/p/keylen/salt）', async () => {
    const stored = await hashPassword('abc12345');
    const parts = stored.split('$');
    assert.deepEqual(parts.slice(1, 4), ['16384', '8', '1']);
    assert.equal(Buffer.from(parts[4], 'base64').length, 16);
    assert.equal(Buffer.from(parts[5], 'base64').length, 64);
});

test('hashPassword 每次盐不同，且各自可验证', async () => {
    const a = await hashPassword('abc12345');
    const b = await hashPassword('abc12345');
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('abc12345', a), true);
    assert.equal(await verifyPassword('abc12345', b), true);
});

test('verifyPassword 拒绝非规范数值段与超限成本参数', async () => {
    const parts = (await hashPassword('abc12345')).split('$');
    const mk = (n: string) => ['scrypt', n, '8', '1', parts[4], parts[5]].join('$');
    assert.equal(await verifyPassword('abc12345', mk('16384x')), false);
    assert.equal(await verifyPassword('abc12345', mk(' 16384 ')), false);
    assert.equal(await verifyPassword('abc12345', mk('9999')), false);
    assert.equal(await verifyPassword('abc12345', mk('1048576')), false);
    assert.equal(await verifyPassword('abc12345', parts.join('$')), true);
});

test('verifyPasswordConstantTime 结果与 verifyPassword 一致（null / 正确 / 错误）', async () => {
    assert.equal(await verifyPasswordConstantTime('abc12345', null), false);
    const stored = await hashPassword('abc12345');
    assert.equal(await verifyPasswordConstantTime('abc12345', stored), true);
    assert.equal(await verifyPasswordConstantTime('abc12346', stored), false);
});

test('verifyPasswordConstantTime 对空 stored 仍执行 scrypt（耗时下界）', async () => {
    const start = process.hrtime.bigint();
    assert.equal(await verifyPasswordConstantTime('abc12345', null), false);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1000000;
    // N=16384 的单次 scrypt 为数十毫秒量级；纯比较路径仅零点几毫秒。
    // 取 1ms 作为保守下界，避免 CI 抖动造成 flaky。
    assert.ok(elapsedMs > 1, `期望 scrypt 级耗时，实际 ${elapsedMs.toFixed(3)}ms`);
});

test('MAX_PASSWORD_LENGTH 为 128，isStrongPassword 接受 128 位并拒绝 129 位', () => {
    assert.equal(MAX_PASSWORD_LENGTH, 128);
    const ok = `a1${'x'.repeat(126)}`;
    const tooLong = `a1${'x'.repeat(127)}`;
    assert.equal(ok.length, 128);
    assert.equal(tooLong.length, 129);
    assert.equal(isStrongPassword(ok), true);
    assert.equal(isStrongPassword(tooLong), false);
});

test('scrypt 异步化后不阻塞事件循环（事件循环先于 scrypt 完成推进）', async () => {
    const order: string[] = [];
    const pending = hashPassword('abc12345');
    void pending.then(() => order.push('scrypt'));
    setImmediate(() => order.push('tick'));
    await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    // 同步 scryptSync 实现下 'scrypt' 必然先入队；异步实现下事件循环在 scrypt 完成前即可推进
    assert.deepEqual(order, ['tick', 'scrypt']);
});

test('并发超过 MAX_CONCURRENT_SCRYPT 时排队等待且不丢失', async () => {
    assert.ok(MAX_CONCURRENT_SCRYPT >= 1, '并发上限应为正数');
    const burst = MAX_CONCURRENT_SCRYPT + 3;
    const results = await Promise.all(Array.from({ length: burst }, () => verifyPasswordConstantTime('abc12345', null)));
    assert.deepEqual(results, Array.from({ length: burst }, () => false));
    // 突发结束后额度未泄漏：仍能正常完成一次校验
    const stored = await hashPassword('abc12345');
    assert.equal(await verifyPassword('abc12345', stored), true);
});
