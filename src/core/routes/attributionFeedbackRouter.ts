/**
 * Attribution Feedback Router — 溯源弱反馈审计存储与读取（spec §13.3 / 计划 Phase 7 Task 7.1）。
 *
 * - POST /api/internal/attribution-feedback  body {date, unit_key, mode, sample_size, hit_count,
 *   miss_count, hit_rate, suggestion, detail} → upsert attribution_feedback_signals（建表由
 *   migration 021_attribution_feedback_signals.sql 负责，路由不内联 DDL）。
 *   落库前严格校验（对齐 attributionChainRouter）：date 匹配 DATE_RE；unit_key 非空字符串 ≤200；
 *   mode 小写 token ≤32；三个计数为非负整数且 hit_count+miss_count===sample_size；
 *   hit_rate 为 null（仅 sample_size=0 时）或 [0,1] 内数值；suggestion ∈ SUGGESTIONS；
 *   detail 为对象或 null；否则 400（不触达 DB）。
 * - GET  /api/agent/attribution-feedback/:date → {date, signals: [...]}（查无 → 200 + 空数组，
 *   降级不报错；hit_rate 由 pg numeric 归一为 number）。
 *
 * **本期语义（重要）**：本表只承载"观测 + 建议 + 审计"，默认不影响任何既有行为——
 * 不修改溯源 prompt、驱动类型判定、预判输入与任何既有写入，也不真正应用权重
 * （应用层待积累真实样本后单独立项）。mode 字段留痕运行模式（默认 observe）。
 *
 * 挂载要求：GET 路径在 /api/agent 下，必须在 createAgentProxy 之前 app.use('/api', …)
 * （见 src/index.ts，否则被反代转发到 Python）；POST 自带 json parser（全局 express.json()
 * 位于反代之后，见 attributionChainRouter.ts 同款说明）。
 */
import { Router, json as jsonBodyParser, type Request, type Response } from 'express'
import pool from '../../core/db'

export const attributionFeedbackRouter: Router = Router()

/** Express 5 params 可能为 string | string[]，安全取 string（对齐 internal.ts param helper） */
function param(req: Request, key: string): string {
    const val = req.params[key]
    return Array.isArray(val) ? val[0] : (val || '')
}

// 内部写接口鉴权 token：对齐仓库统一读取惯例（与 attributionChainRouter 同源）
const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production'

/** 校验 X-Internal-Token（对齐 attributionChainRouter：header 优先 + Bearer 兜底） */
function verifyInternalToken(req: Request): boolean {
    const headerToken = req.headers['x-internal-token']
    const bearerToken = req.headers.authorization?.replace('Bearer ', '')
    const token = String(Array.isArray(headerToken) ? headerToken[0] : headerToken || '') || bearerToken || ''
    return token === INTERNAL_TOKEN
}

/** date 格式（对齐 attributionChainRouter DATE_RE：YYYY-MM-DD） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** unit_key 上限：'driver_type_sector:<driver>:sector:<板块名>' 量级，200 足够且防脏数据 */
const MAX_UNIT_KEY_LEN = 200

/** mode 取值形状：小写 token（observe / off / 未来 apply），拒绝大写与分隔符 */
const MODE_RE = /^[a-z][a-z0-9_]{0,31}$/

/** suggestion 取值域（对齐 agent-py attribution_feedback.suggest()：hold/insufficient 均为观望） */
const SUGGESTIONS = new Set(['downgrade', 'upgrade', 'hold', 'insufficient'])

interface FeedbackBody {
    date?: unknown
    unit_key?: unknown
    mode?: unknown
    sample_size?: unknown
    hit_count?: unknown
    miss_count?: unknown
    hit_rate?: unknown
    suggestion?: unknown
    detail?: unknown
}

/** 非负整数校验（注意：布尔 typeof 为 boolean，天然被拒；Number.isInteger(true) 亦为 false） */
function isNonNegativeInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** 校验请求体；返回错误文案（null 表示通过）；路由层只做 res.status 映射 */
function validateFeedbackBody(body: FeedbackBody): string | null {
    const date = body.date
    if (typeof date !== 'string' || !date) {
        return 'invalid attribution feedback payload'
    }
    if (!DATE_RE.test(date)) {
        return `invalid date format: ${date}（需要 YYYY-MM-DD）`
    }
    const unitKey = body.unit_key
    if (typeof unitKey !== 'string' || !unitKey.trim() || unitKey.length > MAX_UNIT_KEY_LEN) {
        return 'unit_key must be a non-empty string'
    }
    const mode = body.mode
    if (typeof mode !== 'string' || !MODE_RE.test(mode)) {
        return 'mode must be a lowercase token (≤32 chars)'
    }
    for (const field of ['sample_size', 'hit_count', 'miss_count'] as const) {
        if (!isNonNegativeInt(body[field])) {
            return `${field} must be a non-negative integer`
        }
    }
    const sampleSize = body.sample_size as number
    const hitCount = body.hit_count as number
    const missCount = body.miss_count as number
    if (hitCount + missCount !== sampleSize) {
        return 'hit_count + miss_count must equal sample_size'
    }
    const hitRate = body.hit_rate
    if (sampleSize === 0) {
        // 空样本无命中率可言：必须显式 null（写 0 会被误读为"命中率 0%"）
        if (hitRate !== null) {
            return 'hit_rate must be null or a number in [0,1]'
        }
    } else if (typeof hitRate !== 'number' || !Number.isFinite(hitRate) || hitRate < 0 || hitRate > 1) {
        return 'hit_rate must be null or a number in [0,1]'
    }
    const suggestion = body.suggestion
    if (typeof suggestion !== 'string' || !SUGGESTIONS.has(suggestion)) {
        return `suggestion must be one of ${[...SUGGESTIONS].join('|')}`
    }
    const detail = body.detail
    if (detail !== undefined && detail !== null) {
        if (typeof detail !== 'object' || Array.isArray(detail)) {
            return 'detail must be an object or null'
        }
    }
    return null
}

attributionFeedbackRouter.post(
    '/internal/attribution-feedback',
    jsonBodyParser(),
    async (req: Request, res: Response) => {
        try {
            // 内部写接口：先鉴权再落库（无/错 token → 401，不触达 DB）
            if (!verifyInternalToken(req)) {
                res.status(401).json({ code: 401, message: 'invalid internal token' })
                return
            }
            const body = (req.body ?? {}) as FeedbackBody
            const error = validateFeedbackBody(body)
            if (error) {
                res.status(400).json({ code: 400, message: error })
                return
            }
            const detail = body.detail
            // 建表已转 migration 021（部署前需先执行）；此处仅 upsert，(date, unit_key) 幂等
            await pool.query(
                `INSERT INTO attribution_feedback_signals
                     (date, unit_key, mode, sample_size, hit_count, miss_count, hit_rate, suggestion, detail)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (date, unit_key) DO UPDATE SET
                     mode = EXCLUDED.mode,
                     sample_size = EXCLUDED.sample_size,
                     hit_count = EXCLUDED.hit_count,
                     miss_count = EXCLUDED.miss_count,
                     hit_rate = EXCLUDED.hit_rate,
                     suggestion = EXCLUDED.suggestion,
                     detail = EXCLUDED.detail,
                     created_at = now()`,
                [
                    body.date,
                    body.unit_key,
                    body.mode,
                    body.sample_size,
                    body.hit_count,
                    body.miss_count,
                    body.hit_rate,
                    body.suggestion,
                    detail === undefined || detail === null ? null : JSON.stringify(detail),
                ],
            )
            res.json({ code: 200, data: { ok: true } })
        } catch (err: unknown) {
            res.status(500).json({ code: 500, message: err instanceof Error ? err.message : String(err) })
        }
    },
)

interface FeedbackRow {
    date?: unknown
    unit_key?: unknown
    mode?: unknown
    sample_size?: unknown
    hit_count?: unknown
    miss_count?: unknown
    hit_rate?: unknown
    suggestion?: unknown
    detail?: unknown
    created_at?: unknown
}

/** 行 → 响应对象（camelCase；hit_rate 由 pg numeric 的 string 归一为 number） */
function toSignal(row: FeedbackRow): Record<string, unknown> {
    const rawRate = row.hit_rate
    const hitRate = rawRate === null || rawRate === undefined ? null : Number(rawRate)
    const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
    return {
        date: row.date,
        unitKey: row.unit_key,
        mode: row.mode,
        sampleSize: row.sample_size,
        hitCount: row.hit_count,
        missCount: row.miss_count,
        hitRate,
        suggestion: row.suggestion,
        detail: row.detail ?? null,
        createdAt: createdAt ?? null,
    }
}

attributionFeedbackRouter.get(
    '/agent/attribution-feedback/:date',
    async (req: Request, res: Response) => {
        try {
            const date = param(req, 'date')
            if (!DATE_RE.test(date)) {
                res.status(400).json({ code: 400, message: `invalid date format: ${date}（需要 YYYY-MM-DD）` })
                return
            }
            const { rows } = await pool.query(
                `SELECT date, unit_key, mode, sample_size, hit_count, miss_count, hit_rate, suggestion,
                        detail, created_at
                 FROM attribution_feedback_signals
                 WHERE date = $1
                 ORDER BY unit_key`,
                [date],
            )
            res.json({ date, signals: (rows as FeedbackRow[]).map(toSignal) })
        } catch (err: unknown) {
            res.status(500).json({ code: 500, message: err instanceof Error ? err.message : String(err) })
        }
    },
)
