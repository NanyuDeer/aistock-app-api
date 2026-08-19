/**
 * StockInfoService.queryJudgements dateFrom 窗口测试（P0-2）
 *
 * P0-2 背景：/internal/monitor/alerts 原忽略 days 参数只取最新 20 行，
 * 当日事件可能 0 条。改为支持 dateFrom 参数 → queryJudgements 追加
 * `published_at >= $n::timestamptz` 条件（Node 侧按 published_at 窗口过滤）。
 *
 * 运行：`node --import tsx --test src/modules/crawler/__tests__/queryJudgementsDateFrom.spec.ts`
 */
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import pool from '../../../core/db';
import { StockInfoService } from '../StockInfoService';

describe('StockInfoService.queryJudgements dateFrom window (P0-2)', () => {
    const queries: { text: string; values: unknown[] }[] = [];

    beforeEach(() => {
        queries.length = 0;
        // ensureSchema() 有静态 schemaReady 缓存；首个测试进程会执行 CREATE TABLE + INDEX
        // 共 3 次 pool.query，污染 queries[0]（应为 COUNT 查询）。置为 true 模拟生产环境
        // schema 已就绪，与真实运行态一致（schema 建过一次后永久跳过）。
        (StockInfoService as any).schemaReady = true;
        mock.method(pool, 'query', async (text: string, values: unknown[]) => {
            queries.push({ text, values });
            if (text.trimStart().startsWith('SELECT COUNT')) {
                return { rows: [{ total: 1 }] };
            }
            return { rows: [{ id: '1', published_at: new Date() }] };
        });
    });

    afterEach(() => {
        mock.restoreAll();
    });

    it('adds published_at >= condition when dateFrom provided', async () => {
        await StockInfoService.queryJudgements({ dateFrom: '2026-08-12T00:00:00+08:00' });
        const countSql = queries[0]?.text ?? '';
        assert.ok(countSql.includes('published_at >= $1::timestamptz'), `SQL missing window: ${countSql}`);
        assert.equal(queries[0]?.values?.[0], '2026-08-12T00:00:00+08:00');
    });

    it('omits window condition when dateFrom absent (backward compatible)', async () => {
        await StockInfoService.queryJudgements({ limit: 5 });
        const countSql = queries[0]?.text ?? '';
        assert.ok(!countSql.includes('published_at >='), `SQL should not filter: ${countSql}`);
    });
});
