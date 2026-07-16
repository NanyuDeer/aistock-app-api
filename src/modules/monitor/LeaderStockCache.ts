/**
 * 龙头股缓存
 *
 * 核心思路：从 RotationBoardCache 获取所有上榜板块代码（~112个），
 * 逐板调用 fetchConceptLeadingStocks 爬取同花顺F10标记的龙头股，
 * 构建 板块代码→龙头股集合 的映射。
 *
 * 调用次数：固定 ~112 次同花顺页面爬取
 * 缓存TTL：24小时（龙头股标记不常变动）
 *
 * 关键设计：龙头股加分仅当股票是其「最佳板块」（上榜次数最多的板块）的龙头股时生效，
 * 而非任意板块的龙头股都加分。因此按板块存储，由调用方传入 boardCode 精确查询。
 */

import { fetchConceptLeadingStocks } from './WindLeaderAnalyzerService';
import { getAllBoards, ensureCacheBuilt as ensureRotationCache } from './RotationBoardCache';

/** 板块代码 → 龙头股代码集合 */
let boardLeaderMap: Map<string, Set<string>> | null = null;

/** 板块代码 → 板块名称（用于输出展示） */
let boardNameMap: Map<string, string> | null = null;

let cachedAt = 0;
let buildingPromise: Promise<void> | null = null;

const CACHE_TTL = 24 * 3600 * 1000; // 24小时

// ==================== 核心构建逻辑 ====================

async function buildCache(): Promise<void> {
    const startTime = Date.now();
    try {
        // 1. 确保 RotationBoardCache 已构建（获取板块代码）
        await ensureRotationCache();
        const boards = getAllBoards();
        if (boards.length === 0) {
            console.error('[LeaderStockCache] RotationBoardCache 未构建或为空');
            return;
        }
        console.log(`[LeaderStockCache] 开始爬取 ${boards.length} 个板块的龙头股`);

        // 2. 逐板爬取龙头股（并发控制，避免同花顺限流）
        const newBoardLeaderMap = new Map<string, Set<string>>();
        const newBoardNameMap = new Map<string, string>();
        let totalLeaders = 0;

        const CONCURRENCY = 5;
        for (let i = 0; i < boards.length; i += CONCURRENCY) {
            const batch = boards.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(
                batch.map(async (board) => {
                    const leaders = await fetchConceptLeadingStocks(board.code);
                    return { boardCode: board.code, boardName: board.name, leaders };
                })
            );

            for (const result of results) {
                if (result.status !== 'fulfilled') continue;
                const { boardCode, boardName, leaders } = result.value;
                newBoardNameMap.set(boardCode, boardName);
                const codeSet = new Set<string>();
                for (const leader of leaders) {
                    codeSet.add(leader.code);
                }
                newBoardLeaderMap.set(boardCode, codeSet);
                totalLeaders += codeSet.size;
            }

            if ((i + CONCURRENCY) % 20 === 0 || i + CONCURRENCY >= boards.length) {
                console.log(`[LeaderStockCache] 已处理 ${Math.min(i + CONCURRENCY, boards.length)}/${boards.length} 个板块, 累计龙头股 ${totalLeaders} 只`);
            }
        }

        boardLeaderMap = newBoardLeaderMap;
        boardNameMap = newBoardNameMap;
        cachedAt = Date.now();

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[LeaderStockCache] 构建完成: ${boards.length}个板块, ${totalLeaders}只龙头股(含跨板块重复), 耗时${elapsed}s`);
    } catch (e) {
        console.error('[LeaderStockCache] 构建失败:', e);
    }
}

// ==================== 公开API ====================

/**
 * 确保龙头股缓存已构建（如果过期则重新构建）
 * 批量评分前调用此方法预热
 */
export async function ensureCacheBuilt(): Promise<void> {
    if (boardLeaderMap && Date.now() - cachedAt <= CACHE_TTL) {
        console.log('[LeaderStockCache] 缓存有效，跳过构建');
        return;
    }
    if (buildingPromise) {
        console.log('[LeaderStockCache] 缓存正在构建中，等待...');
        await buildingPromise;
        return;
    }
    buildingPromise = buildCache();
    await buildingPromise;
    buildingPromise = null;
}

/**
 * 查询某只股票是否是指定板块的龙头股
 * @param symbol 股票代码（纯数字，如 "002475"）
 * @param boardCode 板块代码（如 "886033.TI"）
 * @returns true=是该板块的龙头股, false=不是或缓存未构建
 */
export function isLeaderStockInBoard(symbol: string, boardCode: string): boolean {
    if (!boardLeaderMap || Date.now() - cachedAt > CACHE_TTL) {
        return false;
    }
    const leaderSet = boardLeaderMap.get(boardCode);
    if (!leaderSet) return false;
    return leaderSet.has(symbol);
}

/**
 * 获取板块名称（用于输出展示）
 * @param boardCode 板块代码
 * @returns 板块名称，未找到则返回 boardCode
 */
export function getBoardName(boardCode: string): string {
    if (!boardNameMap || Date.now() - cachedAt > CACHE_TTL) {
        return boardCode;
    }
    return boardNameMap.get(boardCode) || boardCode;
}

/**
 * 强制重新构建缓存
 */
export async function rebuildCache(): Promise<void> {
    boardLeaderMap = null;
    boardNameMap = null;
    cachedAt = 0;
    await ensureCacheBuilt();
}

/**
 * 获取缓存状态信息
 */
export function getCacheStatus(): { built: boolean; age: number; boardCount: number } {
    return {
        built: boardLeaderMap !== null && Date.now() - cachedAt <= CACHE_TTL,
        age: boardLeaderMap ? Date.now() - cachedAt : 0,
        boardCount: boardLeaderMap ? boardLeaderMap.size : 0,
    };
}
