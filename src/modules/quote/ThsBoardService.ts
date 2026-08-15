/**
 * 同花顺（ths）板块指数服务 — 885/886 全表 + 进程缓存
 *
 * 供 Python Agent 预测验证器（M2 roadmap）通过 GET /internal/ths/index-map 拉取
 * 板块名 → ts_code 全表映射。取数复用 TushareService.getThsIndex；
 * 进程缓存 + 6 小时 TTL 近似覆盖"每交易日刷新"语义。
 */
import { getThsIndex, getThsDaily } from './TushareService'

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

// ============ 板块名三级匹配（Task 2：/internal/ths/resolve） ============

const SUFFIX_RE = /（A股）|\(A股\)|概念$|板块$|行业$|产业链$/g
const SPACE_RE = /[\s（）()]/g

function normName(s: string): string {
    return String(s).replace(SPACE_RE, '').replace(SUFFIX_RE, '').toLowerCase()
}

/** 三级匹配：归一化精确 → 归一化双向包含 → null。返回 { ts_code, name } 或 null。 */
export async function resolveBoardName(name: string): Promise<{ ts_code: string; name: string } | null> {
    const trimmed = (name || '').trim()
    if (!trimmed) return null
    const { ts_codes } = await getIndexMap()
    const ns = normName(trimmed)
    if (!ns) return null
    const exact = ts_codes.find((r) => normName(r.name) === ns)
    if (exact) return { ts_code: exact.ts_code, name: exact.name }
    const contain = ts_codes.find((r) => {
        const n = normName(r.name)
        return n.includes(ns) || ns.includes(n)
    })
    return contain ? { ts_code: contain.ts_code, name: contain.name } : null
}

// ============ 板块区间日 K（Task 3：/internal/ths/:code/daily） ============

/** DI 注入点：测试通过替换此对象避免触达真实 Tushare（与 __indexMapDeps 同款约定） */
export interface ThsDailyDeps {
    getThsDaily: (tsCode: string, startDate: string, endDate?: string) => Promise<Array<Record<string, unknown>>>
}
export const __dailyDeps: ThsDailyDeps = {
    // ThsDailyRow 是 interface（无隐式索引签名），直接赋给 Record<string, unknown>[] 会报 TS2322；
    // 每个 ThsDailyRow 都是 Record<string, unknown> 形状对象，此拓宽安全（DI 层保持宽松行类型供 mock 注入）。
    getThsDaily: getThsDaily as unknown as ThsDailyDeps['getThsDaily'],
}

const CODE_RE = /^\d{6}\.TI$/i

/** 板块指数区间日 K：pct_change → pct_chg 契约键归一（Tushare 缺失时保行为 null，H7 不静默丢行），
 * rows 按 trade_date 升序（YYYYMMDD 字典序 = 时间序）。 */
export async function getBoardDailyRange(
    code: string, start: string, end: string,
): Promise<Array<{ trade_date: string; pct_chg: number | null }>> {
    const rows = await __dailyDeps.getThsDaily(code, start, end)
    const out = rows
        .filter((r) => r.trade_date !== undefined)
        .map((r) => ({
            trade_date: String(r.trade_date),
            pct_chg: typeof r.pct_change === 'number' ? r.pct_change : null,
        }))
    out.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
    return out
}
