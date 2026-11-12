/**
 * 宏观预期落库的端到端验证脚本。
 *
 * 做三件事：
 *   1. 抓「今日 + 未来 7 天」并落库
 *   2. point-in-time 回溯查询
 *   3. 打印结果供人工核对
 *
 * 用法：node --import tsx scripts/verify-macro-expectations.ts
 */

import { fetchAndStore, queryExpectations } from '../src/modules/causal/macroExpectationService';

async function main(): Promise<void> {
    console.log('== 抓取并落库 ==');
    const written = await fetchAndStore(7);
    console.log(`写入 ${written} 行`);

    console.log('\n== point-in-time 回溯 ==');
    const now = new Date();
    const data = await queryExpectations(now);
    const keys = Object.keys(data);
    console.log(`可见指标 ${keys.length} 个`);

    for (const key of keys) {
        const item = data[key];
        const gap = item.gap === null ? '—' : item.gap;
        console.log(
            `  ${key.padEnd(16)} 期 ${item.period}  ` +
                `前 ${item.previous ?? '-'}  ` +
                `预 ${item.forecast ?? '-'}  ` +
                `实 ${item.actual ?? '-'}  ` +
                `差 ${gap}  [${item.basis}]`,
        );
    }

    const withForecast = keys.filter((key) => data[key].forecast !== null).length;
    console.log(`\n其中有预期值的 ${withForecast} 个（可用于算预期差）`);
}

main().catch((error: unknown) => {
    console.error('验证失败:', error);
    process.exit(1);
});
