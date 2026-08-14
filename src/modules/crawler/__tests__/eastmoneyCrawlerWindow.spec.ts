/**
 * E-2 东财 dateFrom 窗口（2026-08-14）
 *
 * 覆盖：
 * 1. tradingDayWindowStart 从 end 回溯 N 个 A 股交易日（跳过周末/节假日），
 *    替代原来的"自然日 × 24h"窗口——节后窗口过窄漏公告的修复。
 * 2. buildNewsApiUrl 按时间排序（sort=time），保证最新新闻进入第一页，
 *    替代原来的相关性排序（sort=default，最新新闻可能排不到前 10 条）。
 */

import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { buildNewsApiUrl, tradingDayWindowStart } from '../services/EastmoneyCrawler';

/** mock 节假日 API：一律非节假日 → 非交易日只由周末决定 */
function mockHolidayApiNonHoliday(): void {
    mock.method(global, 'fetch', async () => ({
        ok: true,
        json: async () => ({ code: 0, holiday: { holiday: false } }),
    } as unknown as Response));
}

describe('EastmoneyCrawler 东财窗口 (E-2)', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('tradingDayWindowStart 回溯 N 个交易日（跳过周末）', async () => {
        mockHolidayApiNonHoliday();
        // 2026-08-14 上海时区是周五（交易日），end 取当日下午
        const end = new Date('2026-08-14T10:00:00Z');
        const start = await tradingDayWindowStart(end, 30);

        // start 到 end（含）之间的工作日数恰为 30
        let trading = 0;
        const cursor = new Date(start);
        while (cursor.getTime() <= end.getTime()) {
            const day = cursor.getDay();
            if (day !== 0 && day !== 6) trading++;
            cursor.setDate(cursor.getDate() + 1);
        }
        assert.equal(trading, 30, '窗口应恰含 30 个交易日');
        // 窗口起点本身必须是交易日（非周末）
        assert.notEqual(start.getDay(), 0);
        assert.notEqual(start.getDay(), 6);
        // 30 个交易日必然跨过至少 4 个周末 → 自然日跨度 > 30
        const spanDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000);
        assert.ok(spanDays > 30, '交易日窗口自然日跨度应大于 30（含周末）');
    });

    it('回溯窗口遇节假日跳过（长假后窗口不缩水）', async () => {
        // 模拟 2026-10-01 至 10-07 为国庆节假日：mock fetch 对该区间返回 holiday=true
        const holidayRanges = new Set(['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']);
        mock.method(global, 'fetch', async (input: string | URL | Request) => {
            const url = String(input);
            const dateKey = url.split('/').pop() || '';
            const isHoliday = holidayRanges.has(dateKey);
            return {
                ok: true,
                json: async () => ({ code: 0, holiday: { holiday: isHoliday } }),
            } as unknown as Response;
        });

        // 2026-10-09（周五）为节后首个交易日，回溯 5 个交易日应跨过国庆长假
        const end = new Date('2026-10-09T04:00:00Z'); // 上海 10-09 12:00 周五
        const start = await tradingDayWindowStart(end, 5);

        let trading = 0;
        const cursor = new Date(start);
        while (cursor.getTime() <= end.getTime()) {
            const day = cursor.getDay();
            const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
            if (day !== 0 && day !== 6 && !holidayRanges.has(key)) trading++;
            cursor.setDate(cursor.getDate() + 1);
        }
        assert.equal(trading, 5, '窗口应恰含 5 个交易日（跳过国庆 7 天假）');
    });

    it('buildNewsApiUrl 按时间排序（sort=time）', () => {
        const url = buildNewsApiUrl('600000', 10);
        const decoded = decodeURIComponent(url);
        assert.ok(decoded.includes('"sort":"time"'), '新闻应按时序取最新');
        assert.ok(!decoded.includes('"sort":"default"'), '不得回退相关性排序');
    });
});
