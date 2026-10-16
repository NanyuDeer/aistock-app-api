// 运行：node --import tsx --node --test src/shared/utils/__tests__/cronGuards.spec.ts
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { runIfTradingDay, __cronGuardDependencies } from '../cronGuards';

test('交易日 → 执行任务', async (t) => {
    const m = mock.method(__cronGuardDependencies, 'isTradingDay', () => true);
    t.after(() => m.mock.restore());
    let ran = 0;
    await runIfTradingDay('unit-test-job', () => { ran += 1; });
    assert.equal(ran, 1);
});

test('非交易日 → 跳过 + 记 info 审计日志（不静默）', async (t) => {
    const m = mock.method(__cronGuardDependencies, 'isTradingDay', () => false);
    const logMock = mock.method(console, 'log', () => undefined);
    t.after(() => { m.mock.restore(); logMock.mock.restore(); });
    let ran = 0;
    await runIfTradingDay('inst-research-开盘', () => { ran += 1; });
    assert.equal(ran, 0);
    const logged = logMock.mock.calls.map(c => String(c.arguments[0])).join('\n');
    assert.ok(logged.includes('[SkipNonTradingDay]'), '必须有可审计的跳过日志');
    assert.ok(logged.includes('job=inst-research-开盘'));
});

test('守卫自身异常不冒泡（不让任务因守卫崩掉）', async (t) => {
    const m = mock.method(__cronGuardDependencies, 'isTradingDay', () => { throw new Error('store broken'); });
    const errMock = mock.method(console, 'error', () => undefined);
    t.after(() => { m.mock.restore(); errMock.mock.restore(); });
    await assert.doesNotReject(() => runIfTradingDay('x', () => undefined));
});
