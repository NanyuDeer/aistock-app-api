import assert from 'node:assert/strict';
// 源文件已迁至 src/core/ 与 src/modules/（原 src/redis、src/services/ 路径已不存在）
import redis from '../src/core/redis';
import { StockInfoPushService } from '../src/modules/crawler/StockInfoPushService';

function runAsyncTest(name: string, fn: () => Promise<void>): Promise<void> {
    return fn().then(
        () => console.log(`PASS ${name}`),
        (err) => {
            console.error(`FAIL ${name}`);
            throw err;
        },
    );
}

// resolveWindows 已改为 async（内部 await getLastPushTime()），故断言前必须 await（原同步调用拿到 Promise 导致 .map 报错）
type Windows = Awaited<ReturnType<typeof StockInfoPushService.resolveWindows>>;

function getTypes(windows: Windows): string[] {
    return windows.map(item => item.info_type);
}

async function main(): Promise<void> {
    await runAsyncTest('resolveWindows returns announcement and news for morning with the same range', async () => {
        const before = Date.now();
        const windows = await StockInfoPushService.resolveWindows({ window: 'morning' });
        const after = Date.now();

        assert.deepEqual(getTypes(windows), ['announcement', 'news']);
        assert.equal(windows[0].from.getTime(), windows[1].from.getTime());
        assert.equal(windows[0].to.getTime(), windows[1].to.getTime());
        assert.ok(windows[0].to.getTime() >= before);
        assert.ok(windows[0].to.getTime() <= after);
        // 契约变更（模块化重构起）：morning 默认窗口不再是固定 18h，而是 from=前一天 15:00（本地）、to=now
        const expectedFroms = [new Date(before), new Date(after)].map((d) => {
            d.setDate(d.getDate() - 1);
            d.setHours(15, 0, 0, 0);
            return d.getTime();
        });
        assert.ok(expectedFroms.includes(windows[0].from.getTime()), 'from 应为前一天 15:00');
    });

    await runAsyncTest('resolveWindows returns announcement and news for closing with the same range', async () => {
        const before = Date.now();
        const windows = await StockInfoPushService.resolveWindows({ window: 'closing' });
        const after = Date.now();

        assert.deepEqual(getTypes(windows), ['announcement', 'news']);
        assert.equal(windows[0].from.getTime(), windows[1].from.getTime());
        assert.equal(windows[0].to.getTime(), windows[1].to.getTime());
        // 契约变更（模块化重构起）：closing 默认窗口 from=今天 8:00（本地）、to=now（原为今天 9:30 起、固定区间）
        assert.equal(windows[0].from.getHours(), 8);
        assert.equal(windows[0].from.getMinutes(), 0);
        assert.equal(windows[0].from.getSeconds(), 0);
        assert.equal(windows[0].from.getMilliseconds(), 0);
        assert.ok(windows[0].to.getTime() >= before);
        assert.ok(windows[0].to.getTime() <= after);
    });

    await runAsyncTest('resolveWindows ignores explicit info_type and keeps both types', async () => {
        const windows = await StockInfoPushService.resolveWindows({
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
}

main().catch(err => {
    console.error(err);
    process.exit(1);
}).finally(() => {
    redis.disconnect();
});
