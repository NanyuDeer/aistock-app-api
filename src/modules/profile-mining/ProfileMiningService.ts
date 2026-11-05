/**
 * 用户画像自动挖掘（一期）— 推断表读写 + 5 维度聚合规则
 *
 * 设计（spec 2026-11-05-user-profile-mining-design.md）：
 * - 只写 `user_profile_inferences`，**任何情况下不 INSERT/UPDATE `user_profiles`**（显式画像唯一权威）。
 * - 5 维度均为确定性 SQL 聚合 + 阈值/占比规则，零 LLM。
 * - 置信度上限 0.75；样本为 0 或过滤后为空 → 返回 null（不写行）。
 * - 身份双通道：`user_stocks` 同时存在 openid（微信）与 user_id（UUID，手机号）两种归属，
 *   聚合必须 `us.openid = $1 OR us.user_id = (SELECT id FROM users WHERE openid = $1)`。
 * - 「永不阻断主流程」：批次与单用户异常只 warning，不上抛。
 */
import pool from '../../core/db';

export type InferenceDimension =
    | 'preferred_sectors'
    | 'question_topics'
    | 'watch_events'
    | 'active_hours'
    | 'watchlist_breadth';

export interface Inference {
    dimension: InferenceDimension;
    value: Record<string, unknown>;
    confidence: number;
    sampleSize: number;
    windowDays: number | null;
}

export interface InferenceRow {
    dimension: string;
    value: unknown;
    confidence: number | string;
    sample_size: number | string;
    window_days: number | null;
    inferred_at: Date | string;
}

/** 推断画像元信息（公开侧 meta 接口契约；刻意不含 value） */
export interface InferenceMeta {
    count: number;
    dimensions: string[];
    updated_at: Date | string | null;
}

/** meta 聚合查询的原始行（COUNT / array_agg 在 pg 驱动下可能返回字符串） */
interface MetaRow {
    count: number | string;
    dimensions: string[] | null;
    updated_at: Date | string | null;
}

/**
 * 推断表 DDL（由 index.ts 启动时执行）。
 *
 * 独立于 `user_profiles`：`(user_id, dimension)` 唯一 upsert，只保留最新一次结果。
 * `confidence` 用 DB CHECK 兜底 [0, 1]（规则侧上限 0.75，见 spec §3.3）。
 */
export const USER_PROFILE_INFERENCES_DDL = `
    CREATE TABLE IF NOT EXISTS user_profile_inferences (
        user_id      TEXT NOT NULL,
        dimension    TEXT NOT NULL,
        value        JSONB NOT NULL,
        confidence   NUMERIC(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        sample_size  INTEGER NOT NULL DEFAULT 0,
        window_days  INTEGER,
        inferred_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, dimension)
    )
`;

/** 滑动窗口天数（question_topics / watch_events / active_hours） */
const WINDOW_DAYS = 30;

/**
 * 提问主题关键词表（一期 10 类，模块内常量维护，不做热更新）。
 *
 * 同一问题命中多主题时，每个主题各计 1 次（不重复计权）。
 */
export const QUESTION_TOPIC_KEYWORDS: ReadonlyArray<{ topic: string; keywords: readonly string[] }> = [
    { topic: '财报业绩', keywords: ['财报', '业绩', '营收', '净利润', '季报', '年报', '中报', '毛利率', '业绩预告', '利润'] },
    { topic: '宏观政策', keywords: ['宏观', '政策', '央行', '降息', '降准', '利率', 'GDP', 'CPI', '财政', '监管'] },
    { topic: '板块轮动', keywords: ['板块', '轮动', '切换', '风格', '题材', '赛道'] },
    { topic: '资金流向', keywords: ['资金', '主力', '北向', '流入', '流出', '净买', '龙虎榜', '成交额'] },
    { topic: '技术形态', keywords: ['技术', 'K线', '均线', '支撑', '压力', '突破', 'MACD', 'KDJ', 'RSI', '形态'] },
    { topic: '消息面事件', keywords: ['消息', '新闻', '公告', '事件', '利好', '利空', '重组', '并购'] },
    { topic: '个股基本面', keywords: ['基本面', '估值', '市盈率', 'PE', 'PB', 'ROE', '护城河', '现金流'] },
    { topic: '打新与新股', keywords: ['打新', '新股', '申购', '中签', 'IPO', '上市首日'] },
    { topic: '基金与ETF', keywords: ['基金', 'ETF', '指数基金', '定投', '净值', '份额'] },
    { topic: '风险与止损', keywords: ['风险', '止损', '止盈', '回撤', '仓位', '亏损', '被套', '割肉'] },
];

/** watch_events 事件类型顺序（也用于同 count 时的稳定排序） */
const WATCH_EVENT_TYPE_ORDER = ['limit_up_radar', 'up_move', 'down_move', 'insight_push'] as const;

export interface SectorAggregateRow {
    industry: string | null;
    count: number | string;
}

export interface EventAggregateRow {
    type: string;
    count: number | string;
}

export interface HourAggregateRow {
    hour: number | string;
    hits: number | string;
}

/**
 * preferred_sectors：user_stocks ⋈ stocks.industry，按行业计数占比降序 Top5。
 * 过滤 industry 为空/空白串的行；total 为有效自选股数（样本量）。
 */
export function buildPreferredSectors(rows: SectorAggregateRow[]): Inference | null {
    const filtered = rows
        .map((row) => ({ name: (row.industry ?? '').trim(), count: Number(row.count) }))
        .filter((row) => row.name !== '' && Number.isFinite(row.count) && row.count > 0);
    const total = filtered.reduce((sum, row) => sum + row.count, 0);
    if (total <= 0) return null;

    const items = [...filtered]
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, 5)
        .map((row) => ({
            name: row.name,
            stock_count: row.count,
            weight: Math.round((row.count / total) * 10000) / 10000,
        }));

    return {
        dimension: 'preferred_sectors',
        value: { items, total },
        confidence: total >= 10 ? 0.70 : total >= 5 ? 0.60 : 0.45,
        sampleSize: total,
        windowDays: null,
    };
}

/**
 * question_topics：chat_token_usage.question 近 30 天，命中关键词表计数降序 Top5。
 * 同一问题命中多主题 → 每个主题各计 1 次；total 为有效提问数（样本量）。
 */
export function buildQuestionTopics(questions: Array<string | null | undefined>): Inference | null {
    const samples = questions.filter((q): q is string => typeof q === 'string' && q.trim() !== '');
    if (samples.length === 0) return null;

    const hits = new Map<string, number>();
    for (const question of samples) {
        const lower = question.toLowerCase();
        for (const { topic, keywords } of QUESTION_TOPIC_KEYWORDS) {
            if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
                hits.set(topic, (hits.get(topic) ?? 0) + 1);
            }
        }
    }

    // Array.prototype.sort 稳定：同 hits 时保留关键词表顺序，保证结果确定性
    const items = QUESTION_TOPIC_KEYWORDS
        .map(({ topic }) => ({ topic, hits: hits.get(topic) ?? 0 }))
        .filter((item) => item.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 5);
    if (items.length === 0) return null;

    return {
        dimension: 'question_topics',
        value: { items, total: samples.length },
        confidence: samples.length >= 30 ? 0.65 : samples.length >= 10 ? 0.55 : 0.40,
        sampleSize: samples.length,
        windowDays: WINDOW_DAYS,
    };
}

/**
 * watch_events：stock_trace_user_events ⋈ stock_trace_events 近 30 天，
 * 类型由 is_limit_up（涨停雷达）/ direction='up'（上涨异动）/ direction='down'（下跌异动）派生；
 * watchlist_insight_push_records 存在时叠加 insight_push。
 */
export function buildWatchEvents(rows: EventAggregateRow[]): Inference | null {
    const counts = new Map<string, number>();
    for (const row of rows) {
        const type = String(row.type ?? '');
        const count = Number(row.count);
        if (!(WATCH_EVENT_TYPE_ORDER as readonly string[]).includes(type)) continue;
        if (!Number.isFinite(count) || count <= 0) continue;
        counts.set(type, (counts.get(type) ?? 0) + count);
    }

    const items = WATCH_EVENT_TYPE_ORDER
        .map((type) => ({ type, count: counts.get(type) ?? 0 }))
        .filter((item) => item.count > 0)
        .sort((a, b) => b.count - a.count);
    const total = items.reduce((sum, item) => sum + item.count, 0);
    if (total <= 0) return null;

    return {
        dimension: 'watch_events',
        value: { items, total },
        confidence: total >= 5 ? 0.60 : 0.45,
        sampleSize: total,
        windowDays: WINDOW_DAYS,
    };
}

/** active_hours：chat_token_usage.created_at 近 30 天按小时分布 Top3（Asia/Shanghai）。 */
export function buildActiveHours(rows: HourAggregateRow[]): Inference | null {
    const counts = new Map<number, number>();
    for (const row of rows) {
        const hour = Number(row.hour);
        const hits = Number(row.hits);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
        if (!Number.isFinite(hits) || hits <= 0) continue;
        counts.set(hour, (counts.get(hour) ?? 0) + hits);
    }
    const total = [...counts.values()].reduce((sum, hits) => sum + hits, 0);
    if (total <= 0) return null;

    const items = [...counts.entries()]
        .map(([hour, hits]) => ({ hour, hits }))
        .sort((a, b) => b.hits - a.hits || a.hour - b.hour)
        .slice(0, 3);

    return {
        dimension: 'active_hours',
        value: { items, total },
        confidence: total >= 20 ? 0.60 : 0.45,
        sampleSize: total,
        windowDays: WINDOW_DAYS,
    };
}

/** watchlist_breadth：user_stocks 当前只数分档 <5 / 5-15 / >15。 */
export function buildWatchlistBreadth(count: number): Inference | null {
    if (!Number.isFinite(count) || count <= 0) return null;
    const band = count < 5 ? '<5' : count <= 15 ? '5-15' : '>15';
    return {
        dimension: 'watchlist_breadth',
        value: { band, count },
        confidence: count >= 5 ? 0.70 : 0.50,
        sampleSize: count,
        windowDays: null,
    };
}

/** 非阻断日志（永不阻断主流程） */
function warn(message: string, err: unknown): void {
    console.warn(`[ProfileMining] ${message}:`, err instanceof Error ? err.message : String(err));
}

export interface BatchResult {
    users: number;
    ok: number;
    failed: number;
    perDimension: Record<InferenceDimension, number>;
}

interface UserScopedRow {
    user_id: string;
}

function groupRowsByUser<T extends UserScopedRow>(rows: T[]): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const row of rows) {
        const list = map.get(row.user_id);
        if (list) list.push(row);
        else map.set(row.user_id, [row]);
    }
    return map;
}

/** 单维度批量取数失败不阻断其他维度（该维度本批次跳过） */
async function safeBatch<T>(
    label: string,
    fetch: () => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
    try {
        return await fetch();
    } catch (err: unknown) {
        warn(`${label} 批量取数失败（该维度本批次跳过）`, err);
        return new Map();
    }
}

// ── 批量取数：每维度一条聚合 SQL（WHERE 用户集），内存按 user_id 分组（避免 N+1）──

async function fetchSectorsBatch(userIds: string[]): Promise<Map<string, SectorAggregateRow[]>> {
    const result = await pool.query<SectorAggregateRow & UserScopedRow>(
        `SELECT u.openid AS user_id,
                COALESCE(NULLIF(TRIM(s.industry), ''), '') AS industry,
                COUNT(*)::int AS count
         FROM user_stocks us
         JOIN users u ON (us.openid = u.openid OR us.user_id = u.id)
         JOIN stocks s ON s.symbol = us.symbol
         WHERE u.openid = ANY($1::text[])
           AND NULLIF(TRIM(s.industry), '') IS NOT NULL
         GROUP BY u.openid, COALESCE(NULLIF(TRIM(s.industry), ''), '')`,
        [userIds],
    );
    return groupRowsByUser(result.rows);
}

async function fetchQuestionsBatch(userIds: string[]): Promise<Map<string, Array<{ question: string | null }>>> {
    const result = await pool.query<UserScopedRow & { question: string | null }>(
        `SELECT user_id, question
         FROM chat_token_usage
         WHERE user_id = ANY($1::text[])
           AND created_at >= NOW() - INTERVAL '30 days'
           AND question IS NOT NULL
           AND TRIM(question) <> ''`,
        [userIds],
    );
    return groupRowsByUser(result.rows);
}

async function fetchWatchEventsBatch(userIds: string[]): Promise<Map<string, EventAggregateRow[]>> {
    const result = await pool.query<EventAggregateRow & UserScopedRow>(
        `SELECT ue.openid AS user_id,
                CASE
                    WHEN e.is_limit_up THEN 'limit_up_radar'
                    WHEN e.direction = 'up' THEN 'up_move'
                    ELSE 'down_move'
                END AS type,
                COUNT(*)::int AS count
         FROM stock_trace_user_events ue
         JOIN stock_trace_events e ON e.event_id = ue.event_id
         WHERE ue.openid = ANY($1::text[])
           AND e.first_triggered_at >= NOW() - INTERVAL '30 days'
         -- 必须按「用户 + 派生类型」分组（2 = 上面的 CASE 列）。若按第 1 列（openid）
         -- 分组，CASE 列不在 GROUP BY 内 → PG 报 42803，被 safeBatch 吞掉后该维度
         -- 永不产出（2026-11-05 集成冒烟实测踩到）
         GROUP BY ue.openid, 2
         ORDER BY ue.openid, type`,
        [userIds],
    );
    const groupedRows = groupRowsByUser(result.rows);
    const grouped = new Map<string, EventAggregateRow[]>();
    for (const [userId, rows] of groupedRows) {
        grouped.set(userId, rows.map((row) => ({ type: row.type, count: row.count })));
    }

    // insight push 表存在才叠加（to_regclass 探测；本地缺表安全跳过）
    try {
        const probe = await pool.query<{ reg: string | null }>(
            `SELECT to_regclass('public.watchlist_insight_push_records') AS reg`,
        );
        if (!probe.rows[0]?.reg) return grouped;

        const overlay = await pool.query<UserScopedRow & { count: number | string }>(
            `SELECT openid AS user_id, COUNT(*)::int AS count
             FROM watchlist_insight_push_records
             WHERE openid = ANY($1::text[])
               AND created_at >= NOW() - INTERVAL '30 days'
             GROUP BY openid`,
            [userIds],
        );
        for (const row of overlay.rows) {
            const count = Number(row.count);
            if (count <= 0) continue;
            const list = grouped.get(row.user_id);
            if (list) list.push({ type: 'insight_push', count });
            else grouped.set(row.user_id, [{ type: 'insight_push', count }]);
        }
    } catch (err: unknown) {
        warn('watch_events insight push 批量叠加跳过（不阻断）', err);
    }
    return grouped;
}

async function fetchActiveHoursBatch(userIds: string[]): Promise<Map<string, HourAggregateRow[]>> {
    const result = await pool.query<HourAggregateRow & UserScopedRow>(
        `SELECT user_id,
                EXTRACT(HOUR FROM (created_at AT TIME ZONE 'Asia/Shanghai'))::int AS hour,
                COUNT(*)::int AS hits
         FROM chat_token_usage
         WHERE user_id = ANY($1::text[])
           AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY user_id, EXTRACT(HOUR FROM (created_at AT TIME ZONE 'Asia/Shanghai'))`,
        [userIds],
    );
    return groupRowsByUser(result.rows);
}

async function fetchBreadthBatch(userIds: string[]): Promise<Map<string, number>> {
    const result = await pool.query<UserScopedRow & { count: number | string }>(
        `SELECT u.openid AS user_id, COUNT(*)::int AS count
         FROM user_stocks us
         JOIN users u ON (us.openid = u.openid OR us.user_id = u.id)
         WHERE u.openid = ANY($1::text[])
         GROUP BY u.openid`,
        [userIds],
    );
    const map = new Map<string, number>();
    for (const row of result.rows) {
        map.set(row.user_id, Number(row.count));
    }
    return map;
}



export class ProfileMiningService {
    /** upsert 单维度推断（同日重跑幂等：ON CONFLICT DO UPDATE，`inferred_at` 一并刷新）。 */
    static async upsertInference(
        userId: string,
        dimension: InferenceDimension,
        value: Record<string, unknown>,
        confidence: number,
        sampleSize: number,
        windowDays: number | null,
    ): Promise<void> {
        // 规则侧置信度上限 0.75；越界属编程错误，显式拒绝而非依赖 DB CHECK 报错。
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
            throw new RangeError(`confidence 必须在 [0, 1] 区间，收到 ${confidence}`);
        }
        await pool.query(
            `INSERT INTO user_profile_inferences
                (user_id, dimension, value, confidence, sample_size, window_days, inferred_at, updated_at)
             VALUES ($1, $2, $3::jsonb, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, dimension) DO UPDATE SET
                value = EXCLUDED.value,
                confidence = EXCLUDED.confidence,
                sample_size = EXCLUDED.sample_size,
                window_days = EXCLUDED.window_days,
                inferred_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP`,
            // JSONB 参数必须传 JSON 文本（node-postgres 不自动序列化 JS 对象）
            [userId, dimension, JSON.stringify(value), confidence, sampleSize, windowDays],
        );
    }

    /** 列出某用户全部维度推断（无数据 → []）。 */
    static async listInferences(userId: string): Promise<InferenceRow[]> {
        const result = await pool.query<InferenceRow>(
            `SELECT dimension, value, confidence, sample_size, window_days, inferred_at
             FROM user_profile_inferences
             WHERE user_id = $1
             ORDER BY dimension ASC`,
            [userId],
        );
        return result.rows;
    }

    /**
     * 推断画像元信息：只返回计数与维度名，**不返回 value**（隐私边界，spec §3.8）。
     *
     * 收尾重构（2026-11-05）：聚合查询从 Controller 下移到这里，避免同一张表出现
     * 「Controller 裸 SQL」与「Service 方法」两条访问路径（改表结构时易漏一处）。
     */
    static async getInferenceMeta(userId: string): Promise<InferenceMeta> {
        const result = await pool.query<MetaRow>(
            `SELECT COUNT(*)::int AS count,
                    COALESCE(array_agg(dimension ORDER BY dimension), '{}'::text[]) AS dimensions,
                    MAX(updated_at) AS updated_at
             FROM user_profile_inferences
             WHERE user_id = $1`,
            [userId],
        );
        const row = result.rows[0];
        return {
            // pg 驱动下 COUNT 可能以字符串返回 → 统一归一为 number（与 internal 接口契约一致）
            count: Number(row?.count ?? 0),
            dimensions: Array.isArray(row?.dimensions) ? row.dimensions : [],
            updated_at: row?.updated_at ?? null,
        };
    }

    /** 删除某用户全部推断，返回删除行数。 */
    static async deleteInferences(userId: string): Promise<number> {
        const result = await pool.query(
            'DELETE FROM user_profile_inferences WHERE user_id = $1',
            [userId],
        );
        return result.rowCount ?? 0;
    }

    // ─────────────────────────────────────────────────────────
    // 5 维度计算（单用户查询；批次走下方批量 SQL 后复用 build* 纯函数）
    // ─────────────────────────────────────────────────────────

    /** preferred_sectors：自选股 ⋈ stocks.industry 计数占比 Top5。 */
    static async computePreferredSectors(userId: string): Promise<Inference | null> {
        const result = await pool.query<SectorAggregateRow>(
            `SELECT COALESCE(NULLIF(TRIM(s.industry), ''), '') AS industry,
                    COUNT(*)::int AS count
             FROM user_stocks us
             JOIN stocks s ON s.symbol = us.symbol
             WHERE (us.openid = $1 OR us.user_id = (SELECT id FROM users WHERE openid = $1))
               AND NULLIF(TRIM(s.industry), '') IS NOT NULL
             GROUP BY COALESCE(NULLIF(TRIM(s.industry), ''), '')`,
            [userId],
        );
        return buildPreferredSectors(result.rows);
    }

    /** question_topics：近 30 天提问原文命中关键词表。 */
    static async computeQuestionTopics(userId: string): Promise<Inference | null> {
        const result = await pool.query<{ question: string | null }>(
            `SELECT question
             FROM chat_token_usage
             WHERE user_id = $1
               AND created_at >= NOW() - INTERVAL '30 days'
               AND question IS NOT NULL
               AND TRIM(question) <> ''
             ORDER BY created_at DESC`,
            [userId],
        );
        return buildQuestionTopics(result.rows.map((row) => row.question));
    }

    /** watch_events：stock_trace 主源 + （可选）watchlist_insight_push_records 叠加。 */
    static async computeWatchEvents(userId: string): Promise<Inference | null> {
        const result = await pool.query<EventAggregateRow>(
            `SELECT CASE
                        WHEN e.is_limit_up THEN 'limit_up_radar'
                        WHEN e.direction = 'up' THEN 'up_move'
                        ELSE 'down_move'
                    END AS type,
                    COUNT(*)::int AS count
             FROM stock_trace_user_events ue
             JOIN stock_trace_events e ON e.event_id = ue.event_id
             WHERE ue.openid = $1
               AND e.first_triggered_at >= NOW() - INTERVAL '30 days'
             GROUP BY 1`,
            [userId],
        );
        const rows: EventAggregateRow[] = [...result.rows];

        // insight push 表在生产可能存在、本地缺表（Task 0 实证）：to_regclass 探针安全跳过
        try {
            const probe = await pool.query<{ reg: string | null }>(
                `SELECT to_regclass('public.watchlist_insight_push_records') AS reg`,
            );
            if (probe.rows[0]?.reg) {
                const overlay = await pool.query<{ count: number | string }>(
                    `SELECT COUNT(*)::int AS count
                     FROM watchlist_insight_push_records
                     WHERE openid = $1
                       AND created_at >= NOW() - INTERVAL '30 days'`,
                    [userId],
                );
                const count = Number(overlay.rows[0]?.count ?? 0);
                if (count > 0) rows.push({ type: 'insight_push', count });
            }
        } catch (err: unknown) {
            warn('watch_events insight push 叠加跳过（不阻断）', err);
        }

        return buildWatchEvents(rows);
    }

    /** active_hours：近 30 天提问时间按小时分布 Top3。 */
    static async computeActiveHours(userId: string): Promise<Inference | null> {
        const result = await pool.query<HourAggregateRow>(
            `SELECT EXTRACT(HOUR FROM (created_at AT TIME ZONE 'Asia/Shanghai'))::int AS hour,
                    COUNT(*)::int AS hits
             FROM chat_token_usage
             WHERE user_id = $1
               AND created_at >= NOW() - INTERVAL '30 days'
             GROUP BY 1`,
            [userId],
        );
        return buildActiveHours(result.rows);
    }

    /** watchlist_breadth：自选股当前只数分档。 */
    static async computeWatchlistBreadth(userId: string): Promise<Inference | null> {
        const result = await pool.query<{ count: number | string }>(
            `SELECT COUNT(*)::int AS count
             FROM user_stocks us
             WHERE us.openid = $1 OR us.user_id = (SELECT id FROM users WHERE openid = $1)`,
            [userId],
        );
        return buildWatchlistBreadth(Number(result.rows[0]?.count ?? 0));
    }

    // ─────────────────────────────────────────────────────────
    // 每日批次
    // ─────────────────────────────────────────────────────────

    /**
     * 每日 00:30 挖掘批次（不挂交易日守卫）。
     *
     * 1. 只取 `setting_type='profile_mining' AND enabled=1` 的用户（未开启 = 零查询）；
     * 2. 5 维度各一条批量聚合 SQL，内存按 user_id 分组；
     * 3. 逐用户逐维度 upsert，单用户异常隔离；
     * 4. 批次异常一律 warning 不上抛（「永不阻断主流程」）。
     */
    static async runDailyMining(): Promise<BatchResult> {
        const perDimension: Record<InferenceDimension, number> = {
            preferred_sectors: 0,
            question_topics: 0,
            watch_events: 0,
            active_hours: 0,
            watchlist_breadth: 0,
        };

        try {
            const optIn = await pool.query<{ openid: string }>(
                `SELECT openid
                 FROM user_settings
                 WHERE setting_type = 'profile_mining' AND enabled = 1`,
            );
            const userIds = optIn.rows
                .map((row) => row.openid)
                .filter((id): id is string => typeof id === 'string' && id !== '');
            if (userIds.length === 0) {
                console.log('[ProfileMining] 本批次 0 opt-in 用户，跳过');
                return { users: 0, ok: 0, failed: 0, perDimension };
            }

            const [sectors, questions, events, hours, breadth] = await Promise.all([
                safeBatch('preferred_sectors', () => fetchSectorsBatch(userIds)),
                safeBatch('question_topics', () => fetchQuestionsBatch(userIds)),
                safeBatch('watch_events', () => fetchWatchEventsBatch(userIds)),
                safeBatch('active_hours', () => fetchActiveHoursBatch(userIds)),
                safeBatch('watchlist_breadth', () => fetchBreadthBatch(userIds)),
            ]);

            let ok = 0;
            let failed = 0;
            for (const userId of userIds) {
                try {
                    const inferences: Array<Inference | null> = [
                        buildPreferredSectors(sectors.get(userId) ?? []),
                        buildQuestionTopics((questions.get(userId) ?? []).map((row) => row.question)),
                        buildWatchEvents(events.get(userId) ?? []),
                        buildActiveHours(hours.get(userId) ?? []),
                        buildWatchlistBreadth(breadth.get(userId) ?? 0),
                    ];
                    for (const inference of inferences) {
                        if (!inference) continue;
                        await ProfileMiningService.upsertInference(
                            userId,
                            inference.dimension,
                            inference.value,
                            inference.confidence,
                            inference.sampleSize,
                            inference.windowDays,
                        );
                        perDimension[inference.dimension] += 1;
                    }
                    ok += 1;
                } catch (err: unknown) {
                    failed += 1;
                    warn(`用户 ${userId} 挖掘失败（已隔离，继续其他用户）`, err);
                }
            }

            const summary = (Object.keys(perDimension) as InferenceDimension[])
                .map((dimension) => `${dimension}=${perDimension[dimension]}`)
                .join(' ');
            console.log(
                `[ProfileMining] 批次完成 users=${userIds.length} ok=${ok} failed=${failed} ${summary}`,
            );
            return { users: userIds.length, ok, failed, perDimension };
        } catch (err: unknown) {
            warn('批次异常（不阻断主流程）', err);
            return { users: 0, ok: 0, failed: 0, perDimension };
        }
    }
}


