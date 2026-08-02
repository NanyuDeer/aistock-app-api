/**
 * Task 4: ClsStockNewsService.fetchTelegraphByDate 单元测试
 *
 * 测试策略（适配 Node 原生 test runner，非 jest）：
 * 1. 通过 __clsNewsDependencies 注入点替换 sessionFetch / cailianpressThrottler
 *    （tsx 使用 ESM live binding，named import 不可 monkey-patch；
 *     与 MarketSnapshotService.__marketSnapshotDependencies 同一约定）
 * 2. 测试成功路径：分页拉取 2 条电报，第二页空 → 退出循环
 * 3. 测试部分失败路径：第二页 sessionFetch 抛错 → degraded=true
 *
 * 注意：brief 中的 ctime 1754102400 实际对应 2025-08-02，与测试日期 2026-08-02 不匹配，
 *      会导致实现中 `item.timestamp < dateStart` 提前 return（0 条结果）。
 *      本测试改用 1785636000（= 2026-08-02 10:00:00 Shanghai）使其落在 dateStart~dateEnd 区间内。
 */

import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'

import { ClsStockNewsService, __clsNewsDependencies } from '../../src/modules/monitor/ClsStockNewsService'
import type { ClsStockNewsDeps } from '../../src/modules/monitor/ClsStockNewsService'

// 2026-08-02 10:00:00 Shanghai = 2026-08-02 02:00:00 UTC = 1785636000
const CTIME_ITEM1 = 1785636000
// 2026-08-02 10:01:40 Shanghai = 1785636100
const CTIME_ITEM2 = 1785636100

let originalDeps: ClsStockNewsDeps

beforeEach(() => {
    originalDeps = {
        sessionFetch: __clsNewsDependencies.sessionFetch,
        cailianpressThrottler: __clsNewsDependencies.cailianpressThrottler,
    }
    // throttler 直接 no-op，避免真实限流 sleep
    __clsNewsDependencies.cailianpressThrottler = {
        throttle: async () => {},
    }
})

afterEach(() => {
    __clsNewsDependencies.sessionFetch = originalDeps.sessionFetch
    __clsNewsDependencies.cailianpressThrottler = originalDeps.cailianpressThrottler
})

test('fetchTelegraphByDate 成功拉取指定日期电报', async () => {
    // 模拟分页：第一次返回有 entries，第二次返回空（拉取结束）
    const responses = [
        {
            ok: true,
            json: async () => ({
                errno: 0,
                data: {
                    roll_data: [
                        { id: 1, ctime: CTIME_ITEM1, title: '电报1', content: '<p>内容1</p>' },
                        { id: 2, ctime: CTIME_ITEM2, title: '电报2', content: '<p>内容2</p>' },
                    ],
                },
            }),
        },
        {
            ok: true,
            json: async () => ({ errno: 0, data: { roll_data: [] } }),
        },
    ]
    let callIdx = 0
    __clsNewsDependencies.sessionFetch = async () => {
        const r = responses[callIdx++]
        return r
    }

    const result = await ClsStockNewsService.fetchTelegraphByDate('2026-08-02', { limit: 200 })

    assert.equal(result.items.length, 2)
    assert.equal(result.items[0].title, '电报1')
    assert.equal(result.date, '2026-08-02')
    assert.equal(result.degraded, false)
})

test('fetchTelegraphByDate 部分分页失败时 degraded=true', async () => {
    // 第一次返回 1 条，第二次抛错
    const responses: Array<{ ok: true; json: () => Promise<unknown> } | Error> = [
        {
            ok: true,
            json: async () => ({
                errno: 0,
                data: {
                    roll_data: [
                        { id: 1, ctime: CTIME_ITEM1, title: '电报1', content: '<p>内容1</p>' },
                    ],
                },
            }),
        },
        new Error('网络错误'),
    ]
    let callIdx = 0
    __clsNewsDependencies.sessionFetch = async () => {
        const r = responses[callIdx++]
        if (r instanceof Error) throw r
        return r
    }

    const result = await ClsStockNewsService.fetchTelegraphByDate('2026-08-02', { limit: 200 })

    assert.equal(result.items.length, 1)
    assert.equal(result.degraded, true)
})
