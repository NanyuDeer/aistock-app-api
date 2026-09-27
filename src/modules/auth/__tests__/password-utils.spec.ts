import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, isStrongPassword } from '../passwordUtils';

test('hashPassword 生成 scrypt$ 前缀，且 verifyPassword 正确验证', () => {
    const stored = hashPassword('abc12345');
    assert.ok(stored.startsWith('scrypt$'));
    assert.equal(stored.split('$').length, 6);
    assert.equal(verifyPassword('abc12345', stored), true);
    assert.equal(verifyPassword('abc12346', stored), false);
});

test('verifyPassword 对 null / 非法格式返回 false', () => {
    assert.equal(verifyPassword('abc12345', null), false);
    assert.equal(verifyPassword('abc12345', ''), false);
    assert.equal(verifyPassword('abc12345', 'plaintext'), false);
    assert.equal(verifyPassword('abc12345', 'scrypt$bad'), false);
});

test('isStrongPassword 校验长度与字母数字组合', () => {
    assert.equal(isStrongPassword('abc12345'), true);
    assert.equal(isStrongPassword('abcdefgh'), false);
    assert.equal(isStrongPassword('12345678'), false);
    assert.equal(isStrongPassword('abc123'), false);
});

test('hashPassword 使用绑定参数（N/r/p/keylen/salt）', () => {
    const stored = hashPassword('abc12345');
    const parts = stored.split('$');
    assert.deepEqual(parts.slice(1, 4), ['16384', '8', '1']);
    assert.equal(Buffer.from(parts[4], 'base64').length, 16);
    assert.equal(Buffer.from(parts[5], 'base64').length, 64);
});

test('hashPassword 每次盐不同，且各自可验证', () => {
    const a = hashPassword('abc12345');
    const b = hashPassword('abc12345');
    assert.notEqual(a, b);
    assert.equal(verifyPassword('abc12345', a), true);
    assert.equal(verifyPassword('abc12345', b), true);
});

test('verifyPassword 拒绝非规范数值段与超限成本参数', () => {
    const parts = hashPassword('abc12345').split('$');
    const mk = (n: string) => ['scrypt', n, '8', '1', parts[4], parts[5]].join('$');
    assert.equal(verifyPassword('abc12345', mk('16384x')), false);
    assert.equal(verifyPassword('abc12345', mk(' 16384 ')), false);
    assert.equal(verifyPassword('abc12345', mk('9999')), false);
    assert.equal(verifyPassword('abc12345', mk('1048576')), false);
    assert.equal(verifyPassword('abc12345', parts.join('$')), true);
});
