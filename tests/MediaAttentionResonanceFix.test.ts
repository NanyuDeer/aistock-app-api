import assert from 'node:assert/strict';

// 让 A 股名称映射的加载不依赖真实 Tushare 凭据：先用 require.cache 注入一份可变的 TushareService 假 exports
//（仅覆写 tushareRequest，返回内置的 stock_basic 行），再加载 HotKeywordDetectorService / HotBurstService。
// 原因：tsx/esbuild 下模块导出属性是只读 getter，无法就地改写；且 loadStockNameMap 直接绑定真实 tushareRequest。
const tusharePath = require.resolve('../src/modules/quote/TushareService');
const tushareStub = {
    ...(require(tusharePath) as Record<string, unknown>),
    tushareRequest: async (apiName: string) => (
        apiName === 'stock_basic'
            ? [{ ts_code: '300750.SZ', symbol: '300750', name: '宁德时代' }]
            : []
    ),
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(require.cache as any)[tusharePath] = { id: tusharePath, filename: tusharePath, loaded: true, exports: tushareStub, children: [], paths: [] };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const HKModule = require('../src/modules/monitor/HotKeywordDetectorService') as {
    extractStockCodes: (text: string) => Map<string, string>;
    loadStockNameMap: () => Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const HotBurstModule = require('../src/modules/monitor/HotBurstService') as {
    enrichFeishuStockCodes: (messages: unknown[]) => Array<{ stock_codes: string[] }>;
};
const { extractStockCodes, loadStockNameMap } = HKModule;
const { enrichFeishuStockCodes } = HotBurstModule;

function runTest(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`PASS ${name}`);
    } catch (err) {
        console.error(`FAIL ${name}`);
        throw err;
    }
}

async function runAsyncTest(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`PASS ${name}`);
    } catch (err) {
        console.error(`FAIL ${name}`);
        throw err;
    }
}

async function main(): Promise<void> {
    // ===== extractStockCodes 测试 =====

    // 正则匹配（不依赖 name map）
    runTest('extracts stock codes from "名称(代码)" pattern', () => {
        const stocks = extractStockCodes('中际旭创(300308)发布新品');
        assert.ok(stocks.has('300308'), '应提取到 300308');
        assert.equal(stocks.get('300308'), '中际旭创');
    });

    runTest('extracts bare stock codes', () => {
        const stocks = extractStockCodes('关注 300308 和 600519 的走势');
        assert.ok(stocks.has('300308'));
        assert.ok(stocks.has('600519'));
    });

    // 名称匹配（依赖 loadStockNameMap；名称映射已由顶部注入的 TushareService 假 exports 提供，无需真实凭据）
    await runAsyncTest('extracts stock codes from company name only (via loaded name map)', async () => {
        await loadStockNameMap();
        const stocks = extractStockCodes('宁德时代发布新产品，产能扩张');
        assert.ok(stocks.has('300750'), '应通过公司名称匹配到 300750');
    });

    // ===== enrichFeishuStockCodes 测试 =====

    runTest('enriches feishu messages with stock codes from text', () => {
        const messages = [
            { id: 1, source: 'feishu', chat_id: '', chat_name: '', message_id: 'm1', message_type: 'text', text: '中际旭创(300308)发布新品', stock_codes: [] as string[], keywords: [], received_at: '' },
            { id: 2, source: 'feishu', chat_id: '', chat_name: '', message_id: 'm2', message_type: 'text', text: '今天天气不错', stock_codes: ['000001'], keywords: [], received_at: '' },
            { id: 3, source: 'feishu', chat_id: '', chat_name: '', message_id: 'm3', message_type: 'text', text: '市场整体平稳', stock_codes: [] as string[], keywords: [], received_at: '' },
        ];
        const enriched = enrichFeishuStockCodes(messages);
        assert.ok(enriched[0].stock_codes.includes('300308'), '应从文本提取 300308');
        assert.deepEqual(enriched[1].stock_codes, ['000001'], '已有 stock_codes 不变');
        assert.deepEqual(enriched[2].stock_codes, [], '无法提取时保持空数组');
    });

    console.log('\n所有测试通过');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
