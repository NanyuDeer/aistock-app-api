/**
 * 状态基线日链（S1–S5 的四个构建步骤串成一条命令）
 *
 * 为什么不是进程内 cron：`tsx` 是 devDependency，`tsconfig.include` 只有 `src/**\/*`，
 * `scripts/` 不进 `dist`。挂在 `src/index.ts` 的 cron 在生产跑不起来。
 * 定案是用系统 crontab 调本脚本（见 S5 spec §8）。
 *
 * 顺序不能换：状态 → 罕见度 → 前瞻分布 → claim。
 * 后一步都依赖前一步的产物，任一步失败立即中止（不要"尽力而为"地继续，
 * 否则会拿昨天的状态算出今天的 claim）。
 *
 * 全量重算，不做增量：增量需要前 60 日上下文（mom_60 / vol_20 / 分位窗口），
 * 边界最容易错；四张表都很小（2,646 + 2,646 + 432 行），全量约 60 秒。
 *
 * 用法：
 *   node --import tsx scripts/run-baseline-daily.ts
 *   node --import tsx scripts/run-baseline-daily.ts --skip-state    # 只跑后半段
 *   node --import tsx scripts/run-baseline-daily.ts --date 2026-11-20
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

function main(): void {
    const date = arg('date');
    const steps: Step[] = [
        { name: '状态向量', script: 'build-state-daily.ts', extra: [], skip: hasFlag('skip-state') },
        // 注意：--skip-state 只跳过第 1 步。后三步读的是 state_daily，仍要重建，
        // 否则改了状态口径却不重算分布，两张表会不一致。
        { name: '罕见度', script: 'build-state-rarity.ts', extra: [] },
        { name: '前瞻分布', script: 'build-forward-dist.ts', extra: ['--quiet'] },
        { name: '账本', script: 'emit-daily-baseline-claim.ts', extra: date ? ['--date', date] : [] },
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

main();
