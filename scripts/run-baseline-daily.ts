/**
 * 状态基线日链（S1–S5 的四个构建步骤串成一条命令）
 *
 * 为什么不是进程内 cron：`tsx` 是 devDependency，`tsconfig.include` 只有 `src/**\/*`，
 * `scripts/` 不进 `dist`。挂在 `src/index.ts` 的 cron 在生产跑不起来。
 * 定案是用系统 crontab 调本脚本（见 S5 spec §8）。
 *
 * 顺序不能换：补数 → 状态 → 罕见度 → 前瞻分布 → claim → 验证（了结到期 claim）。
 *
 * 【第 0 步为什么必须有】
 *   `stock_daily` 只有 `backfill-market-history.ts` 一个写入方，**没有任何每日自动更新**。
 *   2026-11-26 首跑就撞上了：日链四步全过，但状态仍停在 11-25，因为日线没入库。
 *   补数是"按交易日拉、跳过已存在"的，所以每天跑一次只补新的一天，代价很小。
 *
 * 【无新交易日就早退】
 *   补完数若 `stock_daily` 的最大交易日没有推进，后面四步只会把同样的结果重写一遍：
 *   白耗 150 秒，还会让"历史被静默改写"的风险每天都暴露一次。所以直接跳过。
 * 后一步都依赖前一步的产物，任一步失败立即中止（不要"尽力而为"地继续，
 * 否则会拿昨天的状态算出今天的 claim）。
 *
 * 全量重算，不做增量：增量需要前 60 日上下文（mom_60 / vol_20 / 分位窗口），
 * 边界最容易错；四张表都很小（2,646 + 2,646 + 432 行），全量约 60 秒。
 *
 * 用法：
 *   node --import tsx scripts/run-baseline-daily.ts
 *   node --import tsx scripts/run-baseline-daily.ts --skip-state    # 只跑后半段（不重算状态）
 *   node --import tsx scripts/run-baseline-daily.ts --skip-backfill # 不补数（数据已就绪时）
 *   node --import tsx scripts/run-baseline-daily.ts --date 2026-11-20
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import pool from '../src/core/db';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(n: string): string | null {
    const i = process.argv.indexOf(`--${n}`);
    if (i < 0) return null;
    const v = process.argv[i + 1];
    return v && !v.startsWith('--') ? v : null;
}

const hasFlag = (n: string): boolean => process.argv.includes(`--${n}`);

interface Step {
    name: string;
    script: string;
    extra: string[];
    skip?: boolean;
}

function ymd(d: string): string {
    return d.replace(/-/g, '');
}

function shiftDays(d: string, n: number): string {
    return new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
    const date = arg('date');

    // ── 第 0 步：补日线 ──
    if (!hasFlag('skip-backfill')) {
        const last = await pool.query('SELECT max(trade_date)::text AS d FROM stock_daily');
        const lastDay: string | null = last.rows[0]?.d ?? null;
        if (!lastDay) throw new Error('stock_daily 为空，先全量回填');
        // 回看 5 天：容忍上游偶发缺日，同时不把 11 年的范围重新扫一遍
        const start = ymd(shiftDays(lastDay, -5));
        console.log(`[日链] ▶ 补日线（从 ${start} 起，跳过已存在）`);
        const res = spawnSync(
            process.execPath,
            ['--import', 'tsx', path.join(HERE, 'backfill-market-history.ts'), '--start', start],
            { stdio: 'inherit', cwd: path.resolve(HERE, '..') },
        );
        if (res.status !== 0) {
            console.error(`[日链] ✗ 补日线失败（退出码 ${res.status}），中止`);
            process.exit(res.status ?? 1);
        }
        console.log('[日链] ✓ 补日线');
    }

    // ── 无新交易日则早退 ──
    const cmp = await pool.query(
        `SELECT (SELECT max(trade_date)::text FROM stock_daily) AS src,
                (SELECT max(trade_date)::text FROM state_daily) AS dst`,
    );
    const src: string | null = cmp.rows[0]?.src ?? null;
    const dst: string | null = cmp.rows[0]?.dst ?? null;
    await pool.end();
    if (src !== null && dst !== null && src <= dst) {
        console.log(`[日链] 无新交易日（stock_daily=${src}，state_daily=${dst}），跳过后续步骤`);
        return;
    }
    console.log(`[日链] 新交易日：state ${dst ?? '空'} → stock ${src}`);

    const steps: Step[] = [
        { name: '状态向量', script: 'build-state-daily.ts', extra: [], skip: hasFlag('skip-state') },
        // 注意：--skip-state 只跳过第 1 步。后三步读的是 state_daily，仍要重建，
        // 否则改了状态口径却不重算分布，两张表会不一致。
        { name: '罕见度', script: 'build-state-rarity.ts', extra: [] },
        { name: '前瞻分布', script: 'build-forward-dist.ts', extra: ['--quiet'] },
        { name: '账本', script: 'emit-daily-baseline-claim.ts', extra: date ? ['--date', date] : [] },
        // 账本之后：先写今天的新 claim，再了结到期的旧 claim
        { name: '验证', script: 'verify-baseline-claims.ts', extra: [] },
    ];

    const t0 = Date.now();
    for (const step of steps) {
        if (step.skip) {
            console.log(`[日链] 跳过 ${step.name}`);
            continue;
        }
        const started = Date.now();
        console.log(`[日链] ▶ ${step.name} (${step.script})`);
        const res = spawnSync(
            process.execPath,
            ['--import', 'tsx', path.join(HERE, step.script), ...step.extra],
            { stdio: 'inherit', cwd: path.resolve(HERE, '..') },
        );
        if (res.status !== 0) {
            // 失败即停：继续跑只会拿旧状态算出新 claim
            console.error(`[日链] ✗ ${step.name} 退出码 ${res.status}，中止`);
            process.exit(res.status ?? 1);
        }
        console.log(`[日链] ✓ ${step.name}（${((Date.now() - started) / 1000).toFixed(1)}s）`);
    }
    console.log(`[日链] 全部完成，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e: unknown) => {
    console.error('[日链] 失败：', e instanceof Error ? e.message : e);
    process.exit(1);
});
