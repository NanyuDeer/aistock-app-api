/**
 * Attribution Chain Router — 大盘归因链存储与读取（2026-09-03 P1 chain-attribution Task 4）。
 *
 * - POST /api/internal/attribution-chain  body {date, chain} → upsert attribution_chains
 *   （date text PK, content jsonb, updated_at）；落库前校验 root.type==="market" 且
 *   children 为数组，否则 400；表不存在时先 CREATE TABLE IF NOT EXISTS。
 * - GET  /api/agent/attribution-chain/:date → {date, chain|null}（查无该日期链 → 200 降级，
 *   不报错）。
 *
 * 挂载要求：GET 路径在 /api/agent 下，必须在 createAgentProxy 之前 app.use('/api', …)
 * （见 src/index.ts），否则会被反代转发到 Python。全局 express.json() 位于反代之后，
 * 故本 router 的 POST 自带 json parser（body-parser 幂等：body 已被全局 parser 消费时跳过）。
 */
import { Router, json as jsonBodyParser, type Request, type Response } from 'express'
import pool from '../../core/db'

export const attributionChainRouter = Router()

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
            if (
                typeof date !== 'string' || !date ||
                !chain || chain?.root?.type !== 'market' || !Array.isArray(chain?.children)
            ) {
                res.status(400).json({ error: 'invalid attribution chain payload' })
                return
            }
            await pool.query(
                `CREATE TABLE IF NOT EXISTS attribution_chains (
                   date text PRIMARY KEY, content jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
                 )`,
            )
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
