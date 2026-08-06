/**
 * InsightService 单元测试（createEvent 幂等）
 *
 * 仓库惯例：Node 内建 test runner（node:test）+ .spec.ts 命名 + __tests__ 目录，
 * 与简报中的 jest 写法不同，此处跟随仓库惯例。
 *
 * 运行：`node --import tsx --test src/modules/insight/__tests__/insightService.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../../core/db';
import { createEvent } from '../InsightService';

afterEach(() => {
    mock.restoreAll();
});

// ==================== createEvent ====================

describe('createEvent', () => {
    it('同一业务键重复建事件第二次返回 false（ON CONFLICT DO NOTHING 幂等）', async () => {
        // 第一次 mock 返回插入成功行，第二次返回空行（模拟 DO NOTHING 无返回）
        let callCount = 0;
        const mockQuery = (async () => {
            callCount++;
            return { rows: callCount === 1 ? [{ event_id: 'wi_20260805_000962_limit_up' }] : [] };
        }) as unknown as typeof pool.query;
        mock.method(pool, 'query', mockQuery);

        const first = await createEvent('000962', '东方钽业', 'c678683171', '2026-08-05');
        const second = await createEvent('000962', '东方钽业', 'c678683171', '2026-08-05');

        assert.equal(first, true);
        assert.equal(second, false);
        assert.equal(callCount, 2);
    });

    it('event_id 格式与 INSERT 列清单/冲突键与 016 迁移一致', async () => {
        let capturedSql = '';
        let capturedParams: unknown[] = [];
        const mockQuery = (async (text: string, params?: unknown[]) => {
            capturedSql = text;
            capturedParams = params ?? [];
            return { rows: [{ event_id: 'wi_20260805_000962_limit_up' }] };
        }) as unknown as typeof pool.query;
        mock.method(pool, 'query', mockQuery);

        const ok = await createEvent('000962', '东方钽业', 'c678683171', '2026-08-05');

        assert.equal(ok, true);
        assert.ok(capturedSql.includes('INSERT INTO watchlist_insight_events'));
        assert.ok(capturedSql.includes('(event_id, symbol, stock_name, trade_date, source_id)'));
        assert.ok(capturedSql.includes('ON CONFLICT (symbol, trade_date, direction, insight_group) DO NOTHING'));
        assert.deepStrictEqual(capturedParams, [
            'wi_20260805_000962_limit_up',
            '000962',
            '东方钽业',
            '2026-08-05',
            'c678683171',
        ]);
    });
});
