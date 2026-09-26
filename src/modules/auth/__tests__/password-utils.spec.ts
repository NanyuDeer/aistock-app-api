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
