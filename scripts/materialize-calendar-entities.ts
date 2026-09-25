/**
 * 手动触发：Calendar → Event Entity 物化（重大事件时间线 Phase 0.5）。
 *
 * 用途：cron（每天 06:40/12:40/18:40）之外的手动杠杆——部署后不必等下一次 cron；
 * 种子入库（source=L4）或候选晋升（importance→high）后可立即让时间线可见；
 * 也可用自定义窗口回补历史（默认窗口 [今天-1, 今天+180] 不含更早历史）。
 *
 * 用法：
 *   npx tsx scripts/materialize-calendar-entities.ts --dry-run                    # 只读预演：列出可物化行，不写库
 *   npx tsx scripts/materialize-calendar-entities.ts                              # 默认窗口 [今天-1, 今天+180]
 *   npx tsx scripts/materialize-calendar-entities.ts 2026-09-01 2026-12-31        # 自定义窗口
 *
 * 幂等：canonical_event_key 唯一约束 + ON CONFLICT upsert，重复执行不产生重复实体。
 *
 * 为什么脚本可以跨模块编排：本文件是 composition root（与 src/index.ts 的 cron 同级），
 * 所以「读 calendar 模块 rows → 交给 event-entities 模块物化」不违反模块解耦规则
 * （modules 之间仍然零直接依赖）。
 */
import pool from '../src/core/db'
import { listEvents } from '../src/modules/calendar/MarketCalendarEventService'
import {
    materializeCalendarRows,
    qualifyCalendarEvent,
    type CalendarRowLike,
} from '../src/modules/event-entities/CalendarEntityMaterializer'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 上海时区墙钟日期（固定 +8，无 DST），对齐 EventEntityService.startDateOf 口径。 */
function shanghaiDate(offsetDays: number): string {
    const ms = Date.now() + offsetDays * 86400000
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

async function run(): Promise<void> {
    const args = process.argv.slice(2)
    const dryRun = args.includes('--dry-run')
    const positional = args.filter((a) => !a.startsWith('--'))
    const [argFrom, argTo] = positional

    if (argFrom && !DATE_RE.test(argFrom)) throw new Error('dateFrom 须为 YYYY-MM-DD')
    if (argTo && !DATE_RE.test(argTo)) throw new Error('dateTo 须为 YYYY-MM-DD')

    const dateFrom = argFrom || shanghaiDate(-1)
    const dateTo = argTo || shanghaiDate(180)

    console.log(`[materialize-calendar] 窗口 ${dateFrom} ~ ${dateTo}${dryRun ? '（dry-run，不写库）' : ''}`)
    const rows = await listEvents(dateFrom, dateTo)
    const qualified = rows.filter((row) => qualifyCalendarEvent(row as CalendarRowLike))
    console.log(
        `[materialize-calendar] 日历行 ${rows.length} 条 → 通过 Qualification ${qualified.length} 条（importance=high 或 source=L4）`,
    )

    if (dryRun) {
        for (const row of qualified) {
            console.log(`  - ${row.event_date} [${row.importance}/${row.source}] ${row.title}`)
        }
        console.log('[materialize-calendar] dry-run 结束，未写库。去掉 --dry-run 即执行物化。')
        return
    }

    const result = await materializeCalendarRows(rows)
    console.log(
        `[materialize-calendar] 物化完成 materialized=${result.materialized} skipped=${result.skipped} failed=${result.failed}`,
    )
}

void run()
    .catch((error: unknown) => {
        console.error('[materialize-calendar] 失败:', error)
        process.exitCode = 1
    })
    .finally(() => {
        void pool.end()
    })
