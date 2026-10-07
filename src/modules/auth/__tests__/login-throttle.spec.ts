import { test } from 'node:test';
import assert from 'node:assert/strict';
import redis from '../../../core/redis';
import { isThrottled, recordFailure, clearAccountFailure, FAIL_MAX, MEMORY_MAX_ENTRIES, REG_MAX, isRegisterThrottled, recordRegisterAttempt, clearRegisterCount, redisIncr } from '../loginThrottle';

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

// 灌入用账号：连续序号保证互不相同（139/138 前缀与 uniquePhone 区分开）
function floodPhone(base: number, i: number): string {
    return `138${String(base + i).padStart(8, '0')}`;
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

test('内存兜底超容量时按最旧 expireAt 淘汰', async () => {
    // 本用例断言内存兜底语义：显式断开 Redis，避免本机存在 Redis 时走 Redis 分支使断言失效
    redis.disconnect();

    const oldest = uniquePhone();
    for (let i = 0; i < FAIL_MAX; i += 1) {
        await recordFailure(oldest);
    }
    assert.equal(await isThrottled(oldest), true);

    const base = 10000000;
    for (let i = 0; i < MEMORY_MAX_ENTRIES; i += 1) {
        await recordFailure(floodPhone(base, i));
    }

    // 注：过期清理分支（entry.expireAt <= now）由本用例触发的同一次清扫逻辑覆盖；
    // expireAt 为 Date.now()+窗口 且不可注入，故不强行断言过期，仅断言容量淘汰路径。
    assert.equal(await isThrottled(oldest), false);
});

test('注册计数与登录失败计数相互隔离', async () => {
    // 断言内存兜底语义：显式断开 Redis，避免本机存在 Redis 时走 Redis 分支使断言失效
    redis.disconnect();

    const acct = uniquePhone();
    assert.equal(REG_MAX, 5);
    for (let i = 0; i < REG_MAX; i += 1) {
        await recordRegisterAttempt(acct);
    }
    assert.equal(await isRegisterThrottled(acct), true);
    // 注册计数不得污染登录失败计数（否则首次设密码被误锁将无法登录）
    assert.equal(await isThrottled(acct), false);
    await clearRegisterCount(acct);
    assert.equal(await isRegisterThrottled(acct), false);
});

test('redisIncr 以单条原子脚本设置计数与 TTL（不回退两步命令）', async () => {
    const calls: Array<[string, number, (string | number)[]]> = [];
    // 假客户端只实现 eval：若实现回退为 incr + expire 两步，调用将直接抛错
    const fake = {
        eval: async (script: string, numkeys: number, ...args: (string | number)[]) => {
            calls.push([script, numkeys, args]);
            return 1;
        },
    };
    await redisIncr('p:', 'acct', 900, fake);
    assert.equal(calls.length, 1);
    const [script, numkeys, args] = calls[0];
    assert.equal(numkeys, 1);
    assert.deepEqual(args, ['p:acct', 900]);
    assert.match(script, /INCR/);
    assert.match(script, /EXPIRE/);
});
