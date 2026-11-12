/**
 * 事件 → 图谱节点映射的存储层。
 *
 * 分工：向量召回与图谱确认在 Python 侧（embedding 与图谱都在那边），
 * Node 只负责落库和读取。Python 没有 DB 依赖，也不该有。
 *
 * 为什么必须落库（不只是性能）：
 *   向量召回不可复现。同一事件今天匹配「半导体」，回放时可能匹配「消费电子」。
 *   2026-08-14 曾因此被迫「回放短路 embedding」。落库后向量只算一次，
 *   回放读缓存，召回广度与可复现性兼得。
 *
 * cached 与 mappings 的关系（重要）：
 *   cached=false → 从没算过，Python 应重新计算
 *   cached=true + mappings 为空 → 算过但全部被过滤，**不应重算**
 *   两者混用会导致每次回放都重跑 embedding。
 */

import pool from '../../core/db';

export interface MappingInput {
    nodeId: string;
    similarity: number;
    confirmed: boolean;
    reason?: string;
}

export interface MappingRow {
    eventId: string;
    nodeId: string;
    similarity: number;
    confirmed: boolean;
    reason: string | null;
    createdAt: string;
}

export interface MappingQueryResult {
    cached: boolean;
    mappings: MappingRow[];
}

/** DB 访问可注入，便于单测不连真实库。 */
export interface MappingDeps {
    query: (
        sql: string,
        params: unknown[],
    ) => Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }>;
}

const defaultDeps: MappingDeps = {
    query: (sql, params) => pool.query(sql, params),
};

/** 相似度必须落在 [0,1]。越界直接报错——映射错了比缺更难排查。 */
function clampSimilarity(value: number): number {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`similarity out of range: ${value}`);
    }
    return Math.round(value * 10000) / 10000;
}

/** 批量 upsert。同 (event_id, node_id) 覆盖更新，返回实际写入行数。 */
export async function upsertMappings(
    eventId: string,
    mappings: MappingInput[],
    deps: MappingDeps = defaultDeps,
): Promise<number> {
    if (!eventId) throw new Error('eventId must not be empty');
    if (mappings.length === 0) return 0;

    let written = 0;
    for (const mapping of mappings) {
        if (!mapping.nodeId) {
            throw new Error(`mapping for event ${eventId} has empty nodeId`);
        }
        const similarity = clampSimilarity(mapping.similarity);
        const result = await deps.query(
            `INSERT INTO event_node_mappings
                 (event_id, node_id, similarity, confirmed, reason)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (event_id, node_id) DO UPDATE SET
                 similarity = EXCLUDED.similarity,
                 confirmed  = EXCLUDED.confirmed,
                 reason     = EXCLUDED.reason`,
            [eventId, mapping.nodeId, similarity, mapping.confirmed, mapping.reason ?? null],
        );
        written += result.rowCount ?? 0;
    }
    return written;
}

/** 按 eventId 读取全部候选（含未确认）。 */
export async function getMappings(
    eventId: string,
    deps: MappingDeps = defaultDeps,
): Promise<MappingQueryResult> {
    if (!eventId) throw new Error('eventId must not be empty');

    const result = await deps.query(
        `SELECT event_id, node_id, similarity, confirmed, reason, created_at
           FROM event_node_mappings
          WHERE event_id = $1
       ORDER BY confirmed DESC, similarity DESC`,
        [eventId],
    );

    return {
        // 只要有记录就算已缓存——哪怕全部未确认，也不该让 Python 重算
        cached: result.rows.length > 0,
        mappings: result.rows.map((row) => ({
            eventId: String(row.event_id),
            nodeId: String(row.node_id),
            similarity: Number(row.similarity),
            confirmed: Boolean(row.confirmed),
            reason: row.reason === null ? null : String(row.reason),
            createdAt: new Date(row.created_at as string | Date).toISOString(),
        })),
    };
}
