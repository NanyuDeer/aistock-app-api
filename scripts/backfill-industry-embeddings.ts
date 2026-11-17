/**
 * 行业向量灌数脚本。
 *
 * 用途：把 stocks.industry 的 110 个行业名送 embedding 接口，落库为向量。
 * 触发时机：首次上线、换 embedding 模型、行业列表大改之后。
 *
 * 用法：
 *   EMBEDDING_BASE_URL=... EMBEDDING_API_KEY=... \
 *     node --import tsx scripts/backfill-industry-embeddings.ts
 *
 *   # 只检查一致性，不重灌
 *   node --import tsx scripts/backfill-industry-embeddings.ts --check
 */

import {
    EMBEDDING_MODEL,
    checkModelConsistency,
    listIndustries,
    rebuildIndustryEmbeddings,
} from '../src/modules/causal/industryEmbeddingService';

async function main(): Promise<void> {
    const checkOnly = process.argv.includes('--check');

    if (checkOnly) {
        const state = await checkModelConsistency();
        console.log(`库内向量 ${state.total} 条，模型: ${state.models.join(', ') || '(无)'}`);
        if (state.mismatched > 0) {
            console.log(`⚠ ${state.mismatched} 条与当前配置(${EMBEDDING_MODEL})不一致，需要重灌`);
            process.exitCode = 1;
        } else if (state.total > 0) {
            console.log('✅ 模型一致');
        }
        return;
    }

    const industries = await listIndustries();
    console.log(`待灌行业 ${industries.length} 个，模型 ${EMBEDDING_MODEL}`);

    const written = await rebuildIndustryEmbeddings();
    console.log(`写入 ${written} 条`);

    const state = await checkModelConsistency();
    console.log(`核对：${state.total} 条，模型 ${state.models.join(', ')}`);
}

main().catch((error: unknown) => {
    console.error('灌数失败:', error);
    process.exit(1);
});
