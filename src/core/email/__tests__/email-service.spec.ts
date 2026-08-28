import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EmailService, isValidEmail } from '../EmailService';

const savedNodeEnv = process.env.NODE_ENV;
after(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
});

test('isValidEmail 合法邮箱 → true', () => {
    assert.strictEqual(isValidEmail('user@163.com'), true);
    assert.strictEqual(isValidEmail('a.b+c@example.com.cn'), true);
});

test('isValidEmail 非法邮箱 → false', () => {
    assert.strictEqual(isValidEmail(''), false);
    assert.strictEqual(isValidEmail('abc'), false);
    assert.strictEqual(isValidEmail('a@b'), false);
    assert.strictEqual(isValidEmail('a b@c.com'), false);
});

test('send dev 环境 → 不抛错（日志回显）', async () => {
    process.env.NODE_ENV = 'test';
    await EmailService.send('user@163.com', '123456'); // 只回显日志，不真发
});

test('send 生产未配置 SMTP → 抛"邮箱服务未配置"', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.EMAIL_SMTP_USER;
    await assert.rejects(() => EmailService.send('user@163.com', '123456'), /邮箱服务未配置/);
});
