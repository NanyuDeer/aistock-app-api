/**
 * backfill-rhythm-position-index.ts
 *
 * 给历史 rhythm_master(after_close) 报告回填 `rhythm_card.position_index`。
 *
 * 背景：节奏大师重构（2026-11-04）把日历上色依据从 `level`（情绪强度）换成
 * `position_index`（仓位档位 0-4）。但该字段是新增的，部署前生成的历史卡没有这个键
 * → 日历 `position_index` 全为 null → 格子不显示「空/轻/半/重/满」。
 *
 * 日历只读 after_close 时点（`user_id='after_close'`），故只回填该时点。
 *
 * 用法:
 *   npx tsx scripts/backfill-rhythm-position-index.ts             # dry-run（默认，只读）
 *   npx tsx scripts/backfill-rhythm-position-index.ts --execute   # 实际写入
 *
 * 安全设计:
 *   - **默认 dry-run**，必须显式 `--execute` 才写库
 *   - 单事务：任一行失败整体回滚
 *   - 写库前把受影响行的原 `rhythm_card` 落盘备份（CWD 下带时间戳的 json）
 *   - 只新增 `position_index`，不动 `level` / `score` / `position_band` / 其他字段
 *   - 幂等：已含合法 position_index 的行直接跳过，可重复运行
 *   - 未登记文案不猜，保持 null 并在报告里列出，由人补映射后重跑
 *
 * 关于「文案 → 档位」的反向映射:
 *   运行时**禁止**用文案反推档位（序号是唯一真相源，文案由序号派生）。本脚本是
 *   **一次性历史数据迁移**，只在离线跑一次，性质不同。映射表刻意做成封闭枚举，
 *   不在表内的一律不猜，避免把错档位写进历史。
 */

import fs from 'fs'
import pool from '../src/core/db'

/** 封闭枚举：历史卡出现过的 position_band.text（已剥离「建议仓位：」前缀）→ 档位 */
const POSITION_TEXT_TO_INDEX: Record<string, 0 | 1 | 2 | 3 | 4> = {
    // 阶梯文案（current POSITION_LADDER）
    '空仓观望': 0,
    '轻仓~三成': 1,
    '五成~六成': 2,
    '七成~八成': 3,
    '八成~满仓': 4,
    // 阶段自带文案（POSITION_BANDS 与历史变体）
    '空仓~观察': 0,
    '空仓~观察（冰点修复窗口属博弈，非确定性加仓信号）': 0,
    '轻仓~观望': 1,
    '轻仓~半仓试探': 1,
    '半仓~6 成，中性偏多': 2,
    '半仓~减仓，防退潮回落': 2,
    '半仓~减仓防退潮': 2,
    '6~8 成，顺势持有': 3,
    '6~8 成顺势持有': 3,
}

interface Row {
    report_date: string
    rhythm_card: Record<string, unknown> | null
}

interface Decision {
    date: string
    text: string
    target: 0 | 1 | 2 | 3 | 4 | null
    reason: 'write' | 'already' | 'unmapped' | 'no_text'
}

function isValidIndex(v: unknown): v is 0 | 1 | 2 | 3 | 4 {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4
}

function stripPrefix(text: string): string {
    return text.replace(/^建议仓位[:：]\s*/, '').trim()
}

function decide(row: Row): Decision {
    const date = row.report_date
    const card = row.rhythm_card ?? {}
    const existing = (card as { position_index?: unknown }).position_index
    if (isValidIndex(existing)) {
        return { date, text: '', target: null, reason: 'already' }
    }
    const band = (card as { position_band?: { text?: unknown } }).position_band
    const raw = band && typeof band.text === 'string' ? band.text : ''
    const text = stripPrefix(raw)
    if (!text) {
        return { date, text: '', target: null, reason: 'no_text' }
    }
    const target = POSITION_TEXT_TO_INDEX[text]
    if (target === undefined) {
        return { date, text, target: null, reason: 'unmapped' }
    }
    return { date, text, target, reason: 'write' }
}

async function main(): Promise<void> {
    const execute = process.argv.includes('--execute')

    const result = await pool.query(
        `SELECT (report_date AT TIME ZONE 'Asia/Shanghai')::date::text AS report_date,
                content->'rhythm_card' AS rhythm_card
         FROM agent_analysis_reports
         WHERE report_type = 'rhythm_master' AND user_id = 'after_close'
         ORDER BY report_date ASC`,
    )
    const rows = result.rows as Row[]
    const decisions = rows.map(decide)

    const writes = decisions.filter((d) => d.reason === 'write')
    const already = decisions.filter((d) => d.reason === 'already')
    const unmapped = decisions.filter((d) => d.reason === 'unmapped')
    const noText = decisions.filter((d) => d.reason === 'no_text')

    console.log(`\n扫描 rhythm_master(after_close) 共 ${rows.length} 行\n`)
    if (writes.length) {
        console.log('待回填：')
        for (const d of writes) {
            console.log(`  ${d.date}  ${String(d.target)}  ← ${d.text}`)
        }
        console.log('')
    }
    if (unmapped.length) {
        console.log('未登记文案（不猜，保持 null，请补映射后重跑）：')
        for (const d of unmapped) console.log(`  ${d.date}  ${d.text}`)
        console.log('')
    }
    if (noText.length) {
        console.log(`无 position_band.text，跳过：${noText.map((d) => d.date).join(', ')}\n`)
    }
    console.log(
        `汇总：待回填 ${writes.length}｜已有 ${already.length}｜未登记 ${unmapped.length}｜无文案 ${noText.length}`,
    )

    if (!writes.length) {
        console.log('\n没有需要回填的行，退出。\n')
        return
    }
    if (!execute) {
        console.log('\n这是 dry-run。确认无误后加 --execute 实际写入。\n')
        return
    }

    // 备份：只备份会被改动的行
    const writeDates = new Set(writes.map((d) => d.date))
    const backup = rows
        .filter((r) => writeDates.has(r.report_date))
        .map((r) => ({ report_date: r.report_date, rhythm_card: r.rhythm_card }))
    const backupPath = `backfill-rhythm-position-index-${Date.now()}.json`
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8')
    console.log(`\n已备份 ${backup.length} 行原 rhythm_card → ${backupPath}`)

    const client = await pool.connect()
    try {
        await client.query('BEGIN')
        for (const d of writes) {
            // jsonb_set 只加 position_index 键，不动其余字段。
            // 历史行可能没有 rhythm_card 对象本身 → create_missing=true 会创建一个仅含该键的对象，
            // 这种行在日历上本就无仓位语义，故显式排除（target 有值必然来自 position_band，故对象存在）。
            await client.query(
                `UPDATE agent_analysis_reports
                    SET content = jsonb_set(
                            content,
                            '{rhythm_card,position_index}',
                            to_jsonb($2::int),
                            true
                        )
                  WHERE report_type = 'rhythm_master'
                    AND user_id = 'after_close'
                    AND (report_date AT TIME ZONE 'Asia/Shanghai')::date = $1::date`,
                [d.date, d.target],
            )
        }
        await client.query('COMMIT')
        console.log(`已回填 ${writes.length} 行。\n`)
    } catch (err) {
        await client.query('ROLLBACK')
        console.error('回填失败，已回滚，未产生任何写入：', err)
        process.exitCode = 1
    } finally {
        client.release()
        await pool.end()
    }
}

main().catch(async (err) => {
    console.error(err)
    process.exitCode = 1
    await pool.end().catch(() => undefined)
})
