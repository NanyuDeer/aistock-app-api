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

/** 按日期查询时，单个节点的映射（只暴露 L2 需要的两列）。 */
export interface DateMappingEntry {
    nodeId: string;
    /** 与 DB 的 reason 列同源，形如 `direct_sector|overseas:台积电`。 */
    matchedBy: string | null;
}

export interface DateEventMappings {
    eventId: string;
    title: string;
    /** ISO8601（UTC），原样取自 event_start_time。 */
    eventStartTime: string;
    mappings: DateMappingEntry[];
}

export interface DateMappingQueryResult {
    events: DateEventMappings[];
    total: number;
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

/**
 * 日期参数合法性：先卡格式，再卡真实日历日。
 *
 * 只做 `^\d{4}-\d{2}-\d{2}$` 会放过 `2026-02-31`，Postgres 的 `$1::date`
 * 会抛 `date/time field value out of range` → 变成 500。这是调用方的入参错误，
 * 必须是 400，所以在 Node 侧先排掉。
 */
export function isValidDateParam(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * 按交易日（Asia/Shanghai）批量读取「事件 → 节点」映射，供 L2 候选生成的
 * 事件路使用（spec 2026-11-22-l2-trigger-source-design §5.1）。
 *
 * 口径（三条都不能改）：
 * 1. 业务时间用 `event_start_time`，**不是 publish_time**。后者是抓取时间，
 *    638 条里只有 8 条有值，且与事件业务日期无关。
 * 2. 时区固定 Asia/Shanghai —— A 股按本地日切分；用 UTC 会把 00:00+08 的事件
 *    算到前一天。表达式与 `idx_event_entities_start_status` 完全一致，走索引。
 * 3. **内连接** event_node_mappings：无映射的事件对 L2 没有意义，不能返回空数组，
 *    否则 Python 侧要多跑一轮无用循环。
 *
 * 不按 event_status 过滤：该列实际枚举是 ongoing / occurred / scheduled，
 * 没有「published」这个值，而 22/130 条已映射事件是 scheduled。按 event_start_time
 * 落到当日已经满足 spec §2 第 7 条「未来事件不进池」，再加 status 过滤只会误杀。
 *
 * 也不按 confirmed 过滤：与 `/event-node-mappings?eventId=` 老路径保持一致
 * （未确认的候选保留但由上层决定是否采用）。当前 133 条映射全部 confirmed=true。
 */
export async function getMappingsByDate(
    date: string,
    deps: MappingDeps = defaultDeps,
): Promise<DateMappingQueryResult> {
    if (!isValidDateParam(date)) {
        throw new Error(`date must be a real calendar date in YYYY-MM-DD: ${date}`);
    }

    const result = await deps.query(
        `SELECT e.event_id,
                e.title,
                e.event_start_time,
                m.node_id,
                m.reason
           FROM event_entities e
           JOIN event_node_mappings m ON m.event_id = e.event_id
          WHERE date(e.event_start_time AT TIME ZONE 'Asia/Shanghai') = $1::date
       ORDER BY e.event_start_time ASC, e.event_id ASC,
                m.confirmed DESC, m.similarity DESC, m.node_id ASC`,
        [date],
    );

    // 扁平结果按事件分组；Map 保留插入顺序，所以 ORDER BY 决定输出顺序
    const byEvent = new Map<string, DateEventMappings>();
    for (const row of result.rows) {
        const eventId = String(row.event_id);
        let entry = byEvent.get(eventId);
        if (!entry) {
            entry = {
                eventId,
                title: String(row.title),
                eventStartTime: new Date(row.event_start_time as string | Date).toISOString(),
                mappings: [],
            };
            byEvent.set(eventId, entry);
        }
        entry.mappings.push({
            nodeId: String(row.node_id),
            matchedBy: row.reason === null ? null : String(row.reason),
        });
    }

    const events = [...byEvent.values()];
    return { events, total: events.length };
}
