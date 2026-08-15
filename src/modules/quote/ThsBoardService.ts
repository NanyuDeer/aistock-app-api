/**
 * 同花顺（ths）板块指数服务 — 885/886 全表 + 进程缓存
 *
 * 供 Python Agent 预测验证器（M2 roadmap）通过 GET /internal/ths/index-map 拉取
 * 板块名 → ts_code 全表映射。取数复用 TushareService.getThsIndex；
 * 进程缓存 + 6 小时 TTL 近似覆盖"每交易日刷新"语义。
 */
import { getThsIndex } from './TushareService'

const INDEX_MAP_TTL_MS = 6 * 60 * 60 * 1000 // 每 6 小时刷新（覆盖跨交易日 TTL 语义）

export interface ThsIndexRow {
    ts_code: string
    name: string
    count: number | null
    exchange: string
    list_date: string | null
    type: string
}

export interface ThsBoardDeps {
    getThsIndex: (type: string, exchange: string) => Promise<ThsIndexRow[]>
}

/** DI 注入点：测试通过替换此对象避免触达真实 Tushare（与 __marketEventHandlers 同款约定） */
export const __indexMapDeps: ThsBoardDeps = {
    getThsIndex,
}

let cache: { ts_codes: ThsIndexRow[]; updated_at: string; fetchedAt: number } | null = null

/** 板块名 → 885/886 全表（进程缓存 + TTL，每交易日语义由 TTL 近似覆盖）。
 * 返回契约形状 { ts_codes, updated_at }，不暴露内部 fetchedAt（fetchedAt 仅缓存校验用）。 */
export async function getIndexMap(): Promise<{ ts_codes: ThsIndexRow[]; updated_at: string }> {
    const now = Date.now()
    if (cache && now - cache.fetchedAt < INDEX_MAP_TTL_MS) {
        return { ts_codes: cache.ts_codes, updated_at: cache.updated_at }
    }
    const [concepts, industries] = await Promise.all([
        __indexMapDeps.getThsIndex('N', 'A'),
        __indexMapDeps.getThsIndex('I', 'A'),
    ])
    const ts_codes = [...concepts, ...industries]
    cache = { ts_codes, updated_at: new Date().toISOString(), fetchedAt: now }
    return { ts_codes, updated_at: cache.updated_at }
}

/** 测试钩子：清空进程缓存（配合 __indexMapDeps 注入使用，隔离用例间缓存状态） */
export function __resetIndexMapCache(): void {
    cache = null
}
