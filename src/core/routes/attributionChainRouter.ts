/**
 * Attribution Chain Router — 大盘归因链存储与读取（2026-09-03 P1 chain-attribution Task 4）。
 *
 * - POST /api/internal/attribution-chain  body {date, chain} → upsert attribution_chains
 *   （date text PK, content jsonb, updated_at）；建表由 migration 020_attribution_chains.sql
 *   负责，路由不再内联 DDL（原先每次 POST 都 CREATE TABLE IF NOT EXISTS，非事务且多实例
 *   并发会竞态）。落库前校验：date 匹配 DATE_RE、root.type==="market"、children 为数组
 *   且每个子项 {sector 非空字符串, relation ∈ RELATIONS, pct number|null}，否则 400
 *   （错误文案带 children 下标）。
 * - GET  /api/agent/attribution-chain/:date → {date, chain|null}（查无该日期链 → 200 降级，
 *   不报错）。
 *
 * 挂载要求：GET 路径在 /api/agent 下，必须在 createAgentProxy 之前 app.use('/api', …)
 * （见 src/index.ts），否则会被反代转发到 Python。全局 express.json() 位于反代之后，
 * 故本 router 的 POST 自带 json parser（body-parser 幂等：body 已被全局 parser 消费时跳过）。
 */
import { Router, json as jsonBodyParser, type Request, type Response } from 'express'
import pool from '../../core/db'

export const attributionChainRouter: Router = Router()

/** Express 5 params 可能为 string | string[]，安全取 string（对齐 internal.ts param helper） */
function param(req: Request, key: string): string {
    const val = req.params[key]
    return Array.isArray(val) ? val[0] : (val || '')
}

// 内部写接口鉴权 token：对齐仓库统一读取惯例（internal.ts / agent.proxy.ts 同源）
// 优先 INTERNAL_API_TOKEN（agent-py 用变量名），兼容 INTERNAL_TOKEN（旧约定）
const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production'

/** 校验 X-Internal-Token（对齐 judgementController/windLeaderController 同款：header 优先 + Bearer 兜底） */
function verifyInternalToken(req: Request): boolean {
    const headerToken = req.headers['x-internal-token']
    const bearerToken = req.headers.authorization?.replace('Bearer ', '')
    const token = String(Array.isArray(headerToken) ? headerToken[0] : headerToken || '') || bearerToken || ''
    return token === INTERNAL_TOKEN
}

/** :date 路径参数格式（对齐 sectorInsightRouter DATE_RE 防御：YYYY-MM-DD） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface AttributionChainBody {
    date?: unknown
    chain?: { root?: { type?: unknown }; children?: unknown }
}

/** children[].relation 取值域（对齐 agent-py judge_sector_driver_relation 的三个返回值） */
const RELATIONS = new Set(['self_driven', 'market_follow', 'unknown'])

interface AttributionChainChild {
    sector?: unknown
    relation?: unknown
    pct?: unknown
}

/** 校验单个 children 子项；返回错误文案（含下标定位），null 表示通过 */
function validateChild(raw: unknown, index: number): string | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return `children[${index}] must be an object`
    }
    const child = raw as AttributionChainChild
    if (typeof child.sector !== 'string' || !child.sector.trim()) {
        return `children[${index}].sector must be a non-empty string`
    }
    if (typeof child.relation !== 'string' || !RELATIONS.has(child.relation)) {
        return `children[${index}].relation must be one of ${[...RELATIONS].join('|')}`
    }
    // pct 允许显式 null（溯源未取到涨跌幅）；缺失（undefined）与字符串等视为非法
    if (child.pct !== null && typeof child.pct !== 'number') {
        return `children[${index}].pct must be a number or null`
    }
    return null
}

attributionChainRouter.post(
    '/internal/attribution-chain',
    jsonBodyParser(),
    async (req: Request, res: Response) => {
        try {
            // 内部写接口：先鉴权再落库（无/错 token → 401，不触达 DB）
            if (!verifyInternalToken(req)) {
                res.status(401).json({ error: 'invalid internal token' })
                return
            }
            const body = req.body as AttributionChainBody | undefined
            const date = body?.date
            const chain = body?.chain
            if (typeof date !== 'string' || !date) {
                res.status(400).json({ error: 'invalid attribution chain payload' })
                return
            }
            // date 格式与 GET 侧同款 DATE_RE：非法日期落库后 GET 永远取不回（脏数据）
            if (!DATE_RE.test(date)) {
                res.status(400).json({ error: `invalid date format: ${date}（需要 YYYY-MM-DD）` })
                return
            }
            const children = chain?.children
            if (!chain || chain?.root?.type !== 'market' || !Array.isArray(children)) {
                res.status(400).json({ error: 'invalid attribution chain payload' })
                return
            }
            // 子项逐个校验：原先 children 零校验，脏链会被整棵存进 jsonb 且读时无法区分
            for (let i = 0; i < children.length; i++) {
                const childError = validateChild(children[i], i)
                if (childError) {
                    res.status(400).json({ error: childError })
                    return
                }
            }
            // 建表已转 migration 020_attribution_chains.sql（部署前需先执行）；此处仅 upsert
            await pool.query(
                `INSERT INTO attribution_chains (date, content, updated_at)
                 VALUES ($1, $2, now())
                 ON CONFLICT (date) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
                [date, JSON.stringify(chain)],
            )
            res.json({ ok: true })
        } catch (err: unknown) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
        }
    },
)

attributionChainRouter.get('/agent/attribution-chain/:date', async (req: Request, res: Response) => {
    try {
        const date = param(req, 'date')
        if (!DATE_RE.test(date)) {
            res.status(400).json({ error: `invalid date format: ${date}（需要 YYYY-MM-DD）` })
            return
        }
        const { rows } = await pool.query('SELECT content FROM attribution_chains WHERE date = $1', [date])
        const row = rows[0] as { content?: unknown } | undefined
        res.json({ date, chain: row?.content ?? null })
    } catch (err: unknown) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
})
