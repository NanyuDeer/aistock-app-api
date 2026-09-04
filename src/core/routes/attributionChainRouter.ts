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

interface AttributionChainBody {
    date?: unknown
    chain?: { root?: { type?: unknown }; children?: unknown }
}

attributionChainRouter.post(
    '/internal/attribution-chain',
    jsonBodyParser(),
    async (req: Request, res: Response) => {
        try {
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
        const { rows } = await pool.query('SELECT content FROM attribution_chains WHERE date = $1', [date])
        const row = rows[0] as { content?: unknown } | undefined
        res.json({ date, chain: row?.content ?? null })
    } catch (err: unknown) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
})
