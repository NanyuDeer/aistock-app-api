/**
 * 个股-板块映射同步服务
 *
 * 从 Tushare 同花顺概念板块（ths_index + ths_member）获取成分股，
 * 填充 stock_concept_mapping 表，供机构调研推荐热门股 resonance2（板块验证）使用。
 */

import pool from '../../core/db';
import { getThsIndex, getThsMember } from '../quote/TushareService';

export interface StockConceptPair {
    symbol: string;
    sectorName: string;
    sectorCode?: string;
}

/**
 * 从概念列表和成分股获取器构建个股-板块映射对（纯函数，可测试）
 *
 * @param concepts 概念列表 { tsCode, name }
 * @param getMembers 成分股获取函数 (tsCode) => [{ conCode, conName }]
 * @returns 去重后的映射对数组
 */
export async function buildStockConceptPairs(
    concepts: { tsCode: string; name: string }[],
    getMembers: (tsCode: string) => Promise<{ conCode: string; conName: string }[]>,
): Promise<StockConceptPair[]> {
    const pairs: StockConceptPair[] = [];
    const seen = new Set<string>();

    for (const concept of concepts) {
        try {
            const members = await getMembers(concept.tsCode);
            for (const member of members) {
                const symbol = String(member.conCode || '').split('.')[0];
                if (!symbol || symbol.length !== 6) continue;

                const key = `${symbol}|${concept.name}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    pairs.push({ symbol, sectorName: concept.name });
                }
            }
        } catch (err) {
            throw new Error(`概念 ${concept.tsCode} 成分获取失败，保留上次完整映射`, { cause: err });
        }
    }

    return pairs;
}

/**
 * 同步个股-板块映射表（从 Tushare 同花顺概念板块获取）
 * 启动时异步调用 + 每日定时刷新
 *
 * @returns 插入的记录数
 */
export async function syncStockConceptMapping(): Promise<number> {
    console.log('[StockConceptMapping] 开始同步个股-板块映射...');

    const concepts = await getThsIndex('N', 'A');
    console.log(`[StockConceptMapping] 获取到 ${concepts.length} 个概念板块`);

    const pairs = await buildStockConceptPairs(
        concepts.map(c => ({ tsCode: c.ts_code, name: c.name })),
        async (tsCode: string) => {
            const members = await getThsMember(tsCode);
            if (!members.length) throw new Error('成分为空，无法确认完整性');
            return members.map(m => ({ conCode: m.con_code, conName: m.con_name }));
        },
    );
    console.log(`[StockConceptMapping] 构建了 ${pairs.length} 条映射对`);

    if (!concepts.length || !pairs.length) throw new Error('概念映射为空，保留上次完整映射');
    const codes = new Map(concepts.map(c => [c.name, c.ts_code]));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE stock_concept_mapping IN EXCLUSIVE MODE');
        await client.query('DELETE FROM stock_concept_mapping');
        for (let i = 0; i < pairs.length; i += 500) {
            const batch = pairs.slice(i, i + 500);
            const values = batch.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`).join(', ');
            await client.query(
                `INSERT INTO stock_concept_mapping (symbol, sector_name, sector_code) VALUES ${values}`,
                batch.flatMap(p => [p.symbol, p.sectorName, codes.get(p.sectorName) ?? null]),
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    console.log(`[StockConceptMapping] 完整替换 ${pairs.length} 条映射记录`);
    return pairs.length;
}
