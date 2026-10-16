// 运行：node --import tsx --test src/shared/utils/__tests__/tradingTime.spec.ts
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { isAShareTradingDay, isAShareTradingTime } from '../tradingTime';

/** 固定日历：2026-10-01（周四·国庆）休市；2026-10-08（周四）交易 */
const CALENDAR = {
    isTradingDay: (isoDate: string) => isoDate !== '2026-10-01',
};

test('国庆（周四，非周末）判定为非交易日 —— 不再依赖第三方接口', async () => {
    assert.equal(await isAShareTradingDay({ now: new Date('2026-10-01T02:00:00.000Z'), calendar: CALENDAR }), false);
});

test('复牌首日判定为交易日', async () => {
    assert.equal(await isAShareTradingDay({ now: new Date('2026-10-08T02:00:00.000Z'), calendar: CALENDAR }), true);
});

test('周末仍判非交易日（不查日历）', async () => {
    assert.equal(await isAShareTradingDay({ now: new Date('2026-10-03T02:00:00.000Z'), calendar: CALENDAR }), false);
});

test('isAShareTradingTime 保留交易时段窗口语义', async () => {
    const open = new Date('2026-10-08T02:00:00.000Z');   // 10:00 上海
    const closed = new Date('2026-10-08T04:00:00.000Z'); // 12:00 上海（午休）
    assert.equal(await isAShareTradingTime({ now: open, calendar: CALENDAR }), true);
    assert.equal(await isAShareTradingTime({ now: closed, calendar: CALENDAR }), false);
});

test('fetcher 抛错也不再改变判定结果（fail-open 已移除）', async () => {
    const fetcher = mock.fn(async () => { throw new Error('network down'); });
    assert.equal(
        await isAShareTradingDay({ now: new Date('2026-10-01T02:00:00.000Z'), calendar: CALENDAR, fetcher: fetcher as unknown as typeof fetch }),
        false,
    );
    assert.equal(fetcher.mock.calls.length, 0, '不应再发起任何外部请求');
});

test('源码中不得再出现第三方节假日接口', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    // tsconfig module=commonjs 禁用 import.meta；测试统一从仓库根运行（npm test / 上面的命令），故用 cwd 定位
    const src = await fs.readFile(path.resolve(process.cwd(), 'src/shared/utils/tradingTime.ts'), 'utf8');
    assert.equal(src.includes('timor.tech'), false);
    assert.equal(src.includes('isChinaHoliday'), false);
});
