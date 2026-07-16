/**
 * 板块轮动反向缓存
 *
 * 核心思路：不再逐股调用 ths_member(con_code=股票)，
 * 而是从轮动数据中提取所有上榜过的概念板块（~112个），
 * 逐板调用 ths_member(ts_code=板块) 获取成分股，
 * 构建 股票→板块 的反向映射表。
 *
 * 调用次数：固定 ~112 次（而非 N股 × 1次）
 * 缓存TTL：1小时（与轮动数据缓存一致）
 */

import * as TushareService from '../quote/TushareService';
import { fetchBlockRotationData } from './WindLeaderAnalyzerService';

/** 单个板块在轮动数据中的统计结果 */
export interface BoardStat {
    boardName: string;
    boardCode: string;
    count60d: number;
    weeklyTrend: number[];
}

/** 反向映射表: 股票代码 → 板块统计列表（按上榜次数降序） */
type StockBoardMap = Map<string, BoardStat[]>;

/** 所有板块列表（构建缓存时保存） */
let cachedBoards: { name: string; code: string }[] = [];

// ==================== 缓存 ====================

const CACHE_TTL = 3600 * 1000; // 1小时
let cachedMap: StockBoardMap | null = null;
let cachedAt = 0;
let buildingPromise: Promise<StockBoardMap | null> | null = null;

// ==================== 工具函数 ====================

/** 从轮动rawData中提取所有上榜过的板块名 */
function extractRotationBoardNames(rawData: any[]): string[] {
    const names = new Set<string>();
    for (const dayData of rawData) {
        const blockList = dayData?.block_list || [];
        for (const block of blockList) {
            if (block.name) names.add(block.name);
        }
    }
    return [...names];
}

/** 从轮动rawData中统计指定板块的周度上榜趋势 */
function extractWeeklyTrend(rawData: any[], boardNames: string[]): number[] {
    if (!rawData || !rawData.length || !boardNames.length) return [0, 0, 0, 0, 0, 0];
    const nameSet = new Set(boardNames);
    const totalDays = rawData.length;
    const weekSize = Math.ceil(totalDays / 6);
    const weekly: number[] = [];
    for (let w = 0; w < 6; w++) {
        const start = w * weekSize;
        const end = Math.min(start + weekSize, totalDays);
        let count = 0;
        for (let i = start; i < end; i++) {
            const blockList = rawData[i]?.block_list || [];
            for (const block of blockList) {
                if (nameSet.has(block.name)) { count++; break; }
            }
        }
        weekly.push(count);
    }
    return weekly;
}

// ==================== 核心构建逻辑 ====================

/**
 * 构建反向映射表
 *
 * 流程：
 * 1. 获取轮动数据 → 提取所有上榜板块名（~112个）
 * 2. getThsIndex → 板块名映射为 ts_code
 * 3. 逐板 ths_member(ts_code) → 获取成分股列表
 * 4. 构建 股票→[{板名, 板代码, 上榜次数, 周趋势}] 映射
 */
async function buildMap(): Promise<StockBoardMap | null> {
    const startTime = Date.now();
    try {
        // 1. 获取轮动数据
        const { rawData } = await fetchBlockRotationData(60);
        if (!rawData || rawData.length === 0) {
            console.error('[RotationBoardCache] 轮动数据为空');
            return null;
        }

        const rotationNames = extractRotationBoardNames(rawData);
        console.log(`[RotationBoardCache] 轮动60日共有 ${rotationNames.length} 个上榜板块`);

        // 2. 构建 板块名 → ts_code 映射
        const conceptIndices = await TushareService.getThsIndex('N', 'A');
        const industryIndices = await TushareService.getThsIndex('I', 'A');
        const nameToCode = new Map<string, string>();
        const codeToName = new Map<string, string>();
        for (const idx of [...conceptIndices, ...industryIndices]) {
            nameToCode.set(idx.name, idx.ts_code);
            codeToName.set(idx.ts_code, idx.name);
        }

        // 3. 匹配轮动板块名 → ts_code（精确+模糊）
        const boardCandidates: { name: string; code: string }[] = [];
        const matchedRotationNames = new Set<string>();

        for (const rotName of rotationNames) {
            // 精确匹配
            if (nameToCode.has(rotName)) {
                boardCandidates.push({ name: rotName, code: nameToCode.get(rotName)! });
                matchedRotationNames.add(rotName);
                continue;
            }
            // 模糊匹配（轮动名包含 ths_index 名，或反之）
            let matched = false;
            for (const [idxName, code] of nameToCode) {
                if (idxName.length >= 2 && !idxName.includes('(A股)') &&
                    (rotName.includes(idxName) || idxName.includes(rotName))) {
                    boardCandidates.push({ name: idxName, code });
                    matchedRotationNames.add(rotName);
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                console.warn(`[RotationBoardCache] 轮动板块 "${rotName}" 未匹配到 ths_index`);
            }
        }

        console.log(`[RotationBoardCache] 匹配成功 ${boardCandidates.length}/${rotationNames.length} 个板块`);

        // 保存板块列表供 LeaderStockCache 使用
        cachedBoards = boardCandidates;

        // 4. 逐板获取成分股（核心调用，~112次 ths_member）
        const stockMap: StockBoardMap = new Map();
        let totalMembers = 0;

        for (let i = 0; i < boardCandidates.length; i++) {
            const board = boardCandidates[i];
            try {
                const members = await TushareService.getThsMember(board.code);
                if (!members || members.length === 0) continue;

                // 统计该板块的轮动数据
                // 收集该板块在轮动数据中所有可能的名称变体
                const boardNameVariants = new Set<string>([board.name]);
                for (const rotName of rotationNames) {
                    if (rotName !== board.name &&
                        (board.name.includes(rotName) || rotName.includes(board.name))) {
                        boardNameVariants.add(rotName);
                    }
                }

                const weeklyTrend = extractWeeklyTrend(rawData, [...boardNameVariants]);
                const count60d = weeklyTrend.reduce((a, b) => a + b, 0);

                const boardStat: BoardStat = {
                    boardName: board.name,
                    boardCode: board.code,
                    count60d,
                    weeklyTrend,
                };

                // 将该板块的统计赋予给其所有成分股
                for (const m of members) {
                    if (m.is_new === 'N') continue; // 跳过已剔除的
                    // con_code 格式: "002475.SZ" → 提取纯数字代码
                    const stockSymbol = m.con_code.replace(/\.(SH|SZ)$/, '');
                    if (!stockMap.has(stockSymbol)) {
                        stockMap.set(stockSymbol, []);
                    }
                    stockMap.get(stockSymbol)!.push(boardStat);
                }
                totalMembers += members.filter(m => m.is_new !== 'N').length;

                if ((i + 1) % 20 === 0) {
                    console.log(`[RotationBoardCache] 已处理 ${i + 1}/${boardCandidates.length} 个板块, 覆盖 ${stockMap.size} 只股票`);
                }
            } catch (e) {
                console.warn(`[RotationBoardCache] getThsMember(${board.code}) 失败:`, (e as Error).message);
            }
        }

        // 5. 对每只股票的板块列表按上榜次数降序排序
        for (const [symbol, boards] of stockMap) {
            boards.sort((a, b) => b.count60d - a.count60d);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[RotationBoardCache] 构建完成: ${boardCandidates.length}个板块, 覆盖${stockMap.size}只股票, 总成分股记录${totalMembers}条, 耗时${elapsed}s`);

        return stockMap;
    } catch (e) {
        console.error('[RotationBoardCache] 构建失败:', e);
        return null;
    }
}

// ==================== 公开API ====================

/**
 * 获取股票的最佳概念板块（从缓存中查找）
 * @param symbol 股票代码（纯数字，如 "002475"）
 * @returns 最佳板块统计，或 null（缓存未命中或股票不在任何上榜板块中）
 */
export function getBestBoardForStock(symbol: string): BoardStat | null {
    if (!cachedMap || Date.now() - cachedAt > CACHE_TTL) {
        return null; // 缓存过期或未构建
    }
    const boards = cachedMap.get(symbol);
    if (!boards || boards.length === 0) return null;
    return boards[0]; // 已按 count60d 降序排序，第一个即为最佳
}

/**
 * 获取股票的所有上榜概念板块（从缓存中查找）
 */
export function getAllBoardsForStock(symbol: string): BoardStat[] {
    if (!cachedMap || Date.now() - cachedAt > CACHE_TTL) {
        return [];
    }
    return cachedMap.get(symbol) || [];
}

/**
 * 确保缓存已构建（如果过期则重新构建）
 * 批量评分前调用此方法预热缓存
 */
export async function ensureCacheBuilt(): Promise<void> {
    // 如果缓存有效，跳过
    if (cachedMap && Date.now() - cachedAt <= CACHE_TTL) {
        console.log('[RotationBoardCache] 缓存有效，跳过构建');
        return;
    }
    // 如果正在构建，等待
    if (buildingPromise) {
        console.log('[RotationBoardCache] 缓存正在构建中，等待...');
        await buildingPromise;
        return;
    }
    // 启动构建
    buildingPromise = buildMap();
    const result = await buildingPromise;
    buildingPromise = null;
    if (result) {
        cachedMap = result;
        cachedAt = Date.now();
    }
}

/**
 * 强制重新构建缓存（用于调试或手动刷新）
 */
export async function rebuildCache(): Promise<void> {
    cachedMap = null;
    cachedAt = 0;
    await ensureCacheBuilt();
}

/**
 * 获取所有上榜板块代码和名称（供 LeaderStockCache 使用）
 * 必须在 ensureCacheBuilt() 之后调用
 */
export function getAllBoards(): { name: string; code: string }[] {
    if (!cachedMap || Date.now() - cachedAt > CACHE_TTL) {
        return [];
    }
    return cachedBoards;
}

/**
 * 获取缓存状态信息
 */
export function getCacheStatus(): { built: boolean; age: number; stockCount: number; boardCount: number } {
    if (!cachedMap) {
        return { built: false, age: 0, stockCount: 0, boardCount: 0 };
    }
    // 统计涉及的板块数
    const boardSet = new Set<string>();
    for (const boards of cachedMap.values()) {
        for (const b of boards) boardSet.add(b.boardCode);
    }
    return {
        built: Date.now() - cachedAt <= CACHE_TTL,
        age: Date.now() - cachedAt,
        stockCount: cachedMap.size,
        boardCount: boardSet.size,
    };
}
