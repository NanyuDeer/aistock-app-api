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

    /** 删除某用户全部推断，返回删除行数。 */
    static async deleteInferences(userId: string): Promise<number> {
        const result = await pool.query(
            'DELETE FROM user_profile_inferences WHERE user_id = $1',
            [userId],
        );
        return result.rowCount ?? 0;
    }
}
