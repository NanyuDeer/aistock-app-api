import assert from 'node:assert/strict';
import redis from '../src/redis';
import { StockInfoPushService } from '../src/services/StockInfoPushService';

function runTest(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`PASS ${name}`);
    } catch (err) {
        console.error(`FAIL ${name}`);
        throw err;
    }
}

function getTypes(windows: ReturnType<typeof StockInfoPushService.resolveWindows>): string[] {
    return windows.map(item => item.info_type);
}

runTest('resolveWindows returns announcement and news for morning with the same range', () => {
    const before = Date.now();
    const windows = StockInfoPushService.resolveWindows({ window: 'morning' });
    const after = Date.now();

    assert.deepEqual(getTypes(windows), ['announcement', 'news']);
    assert.equal(windows[0].from.getTime(), windows[1].from.getTime());
    assert.equal(windows[0].to.getTime(), windows[1].to.getTime());
    assert.ok(windows[0].to.getTime() >= before);
    assert.ok(windows[0].to.getTime() <= after);
    assert.equal(windows[0].to.getTime() - windows[0].from.getTime(), 18 * 60 * 60 * 1000);
});

runTest('resolveWindows returns announcement and news for closing with the same range', () => {
    const windows = StockInfoPushService.resolveWindows({ window: 'closing' });

    assert.deepEqual(getTypes(windows), ['announcement', 'news']);
    assert.equal(windows[0].from.getTime(), windows[1].from.getTime());
    assert.equal(windows[0].to.getTime(), windows[1].to.getTime());
    assert.equal(windows[0].from.getHours(), 9);
    assert.equal(windows[0].from.getMinutes(), 30);
    assert.equal(windows[0].from.getSeconds(), 0);
    assert.equal(windows[0].from.getMilliseconds(), 0);
});

runTest('resolveWindows ignores explicit info_type and keeps both types', () => {
    const windows = StockInfoPushService.resolveWindows({
        window: 'morning',
        info_type: 'news',
        from: '2026-06-08T01:00:00+08:00',
        to: '2026-06-08T10:00:00+08:00',
    });

    assert.deepEqual(getTypes(windows), ['announcement', 'news']);
    assert.equal(windows[0].from.toISOString(), '2026-06-07T17:00:00.000Z');
    assert.equal(windows[1].from.toISOString(), '2026-06-07T17:00:00.000Z');
    assert.equal(windows[0].to.toISOString(), '2026-06-08T02:00:00.000Z');
    assert.equal(windows[1].to.toISOString(), '2026-06-08T02:00:00.000Z');
});

redis.disconnect();
