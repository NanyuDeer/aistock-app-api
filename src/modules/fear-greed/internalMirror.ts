import { Router, type Request, type Response } from 'express'
import { getLatestJq } from './FearGreedService'
import type { JqIndicator, JqResult } from './calculator'

/**
 * 测试注入点（对齐 modules/prediction __internalPredictionDependencies 先例）。
 * 类型放宽为 Partial + null：真实 getLatestJq 恒返回 JqResult（完整字段），
 * 但镜像契约要求"无数据 → 200 + 空字段"，测试注入 null / 精简字段时类型仍合法。
 */
export const __fearGreedInternalDeps: {
    getLatestJq: (force?: boolean, timeSlot?: string) => Promise<
        (Omit<Partial<JqResult>, 'indicators'> & { indicators?: Array<Partial<JqIndicator>> }) | null
    >
} = { getLatestJq }

const EMPTY = { index: null, label: '', indicators: [], history: { dates: [], scores: [] } }

/** GET /internal/fear-greed 只读镜像（契约 #1）：失败语义 = 200 + 空字段，不 500。 */
export async function fearGreedMirrorHandler(_req: Request, res: Response): Promise<void> {
    try {
        const jq = await __fearGreedInternalDeps.getLatestJq(false, 'post')
        // 信封 code 对齐 internal.ts 成功约定（200）；agent-py _request 仅接受 code==200，0 会恒降级（C1）
        if (!jq || typeof jq.composite !== 'number') {
            res.json({ code: 200, data: EMPTY })
            return
        }
        res.json({
            code: 200,
            data: {
                index: jq.composite,
                label: jq.label ?? '',
                indicators: (jq.indicators ?? []).map((i) => ({ key: i.key, name: i.name, score: i.score, label: i.label })),
                history: jq.history ?? { dates: [], scores: [] },
            },
        })
    } catch (err) {
        console.error('[Internal] /fear-greed mirror error:', err)
        res.json({ code: 200, data: EMPTY })
    }
}

export const fearGreedInternalRouter: Router = Router()
fearGreedInternalRouter.get('/', fearGreedMirrorHandler)

/** 别名导出：测试与挂载侧按 Router 使用（Express Router 可直接 use/挂载）。 */
export { fearGreedInternalRouter as internalMirror }
