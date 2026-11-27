// 运行：node --import tsx --node --test src/shared/utils/__tests__/singleFlight.spec.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { SingleFlight } from '../SingleFlight';

test('并发同 key → loader 只执行一次，其余复用同一结果', async () => {
    const sf = new SingleFlight();
    let calls = 0;
    const loader = async () => {
        calls += 1;
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        return { value: 42 };
    };

    const [a, b] = await Promise.all([sf.run('k', loader), sf.run('k', loader)]);

    assert.equal(calls, 1);
    assert.deepEqual(a, { value: 42 });
    assert.equal(a, b);
    assert.equal(sf.stats().coalesced, 1);
    assert.equal(sf.stats().inflight, 0);
});

test('loader 失败 → promise 同步 reject，且清理后可重试', async () => {
    const sf = new SingleFlight();
    let calls = 0;
    const failing = async () => {
        calls += 1;
        throw new Error('upstream failed');
    };

    await assert.rejects(() => sf.run('k', failing), /upstream failed/);
    assert.equal(sf.stats().inflight, 0, '失败后必须清理在途表');

    const ok = await sf.run('k', async () => {
        calls += 1;
        return 'ok';
    });
    assert.equal(ok, 'ok');
    assert.equal(calls, 2, '失败不应被缓存，重试必须重新执行');
});

test('不同 key 互不合并', async () => {
    const sf = new SingleFlight();
    const started: string[] = [];
    const loader = (tag: string) => async () => {
        started.push(tag);
        await new Promise<void>(resolve => setTimeout(resolve, 5));
        return tag;
    };

    const [a, b] = await Promise.all([sf.run('a', loader('a')), sf.run('b', loader('b'))]);

    assert.deepEqual(started.sort(), ['a', 'b']);
    assert.equal(a, 'a');
    assert.equal(b, 'b');
    assert.equal(sf.stats().coalesced, 0);
});
