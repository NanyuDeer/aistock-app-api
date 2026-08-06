import assert from 'node:assert/strict';
import { shouldPushStockInfoJudgement } from '../src/modules/crawler/StockInfoService';

/**
 * 自选股情报推送过滤验证（个股情报→自选股情报 计划 Task 3）
 *
 * 覆盖：
 * 1. shouldPushStockInfoJudgement 纯函数：只推重大利好/重大利空，中性/普通利好利空不推
 * 2. 时间窗口过滤：窗口外的事件不推
 */
function runTest(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`PASS ${name}`);
    } catch (err) {
        console.error(`FAIL ${name}`);
        throw err;
    }
}

function makeRow(overrides: Partial<Parameters<typeof shouldPushStockInfoJudgement>[0]> = {}): Parameters<typeof shouldPushStockInfoJudgement>[0] {
    return {
        id: 1,
        symbol: '600519',
        stock_name: '贵州茅台',
        info_type: 'news',
        source: 'cls',
        source_id: 'cls-1',
        title: '测试标题',
        url: 'https://example.com',
        published_at: new Date('2026-08-04T09:00:00+08:00'),
        ai_impact: '重大利好',
        ai_horizon: '短期',
        ai_keywords: [],
        ai_summary: '测试摘要',
        created_at: new Date('2026-08-04T09:00:00+08:00'),
        ...overrides,
    };
}

const window = {
    info_type: 'news' as const,
    from: new Date('2026-08-04T00:00:00+08:00'),
    to: new Date('2026-08-04T23:59:59+08:00'),
};

runTest('重大利好事件在窗口内应推送', () => {
    assert.equal(shouldPushStockInfoJudgement(makeRow(), window), true);
});

runTest('重大利空事件在窗口内应推送', () => {
    assert.equal(shouldPushStockInfoJudgement(makeRow({ ai_impact: '重大利空' }), window), true);
});

runTest('中性事件不推送', () => {
    assert.equal(shouldPushStockInfoJudgement(makeRow({ ai_impact: '中性' }), window), false);
});

runTest('普通利好不推送（仅重大利好/重大利空）', () => {
    assert.equal(shouldPushStockInfoJudgement(makeRow({ ai_impact: '利好' }), window), false);
});

runTest('普通利空不推送（仅重大利好/重大利空）', () => {
    assert.equal(shouldPushStockInfoJudgement(makeRow({ ai_impact: '利空' }), window), false);
});

runTest('窗口外事件不推送', () => {
    assert.equal(
        shouldPushStockInfoJudgement(
            makeRow({ published_at: new Date('2026-08-05T09:00:00+08:00') }),
            window,
        ),
        false,
    );
});
